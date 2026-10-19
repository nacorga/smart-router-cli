"""Fixture-only controlling TTY for explicit Smart approval, denial and cancellation checks."""
import json, os, pty, select, signal, sys, time
from pathlib import Path

control = json.loads(Path(sys.argv[1]).read_text())
project = Path(control['project']).resolve()
mode = control['mode']
assert mode in ('continue', 'cancel-command', 'deny')
state = Path(control['state'])
args = [control['node'], control['cli'], '--config', control['config']]
if mode == 'continue':
    args += ['--continue', control['taskId']]
else:
    args += [control['objective']]
env = {**os.environ, 'SMART_STATE_DIR': str(state), 'TERM': 'xterm-256color'}
pid, fd = pty.fork()
if pid == 0:
    os.chdir(project)
    os.execve(args[0], args, env)
output, consumed, approvals, denials = '', 0, 0, 0
exit_code, signalled, error = None, False, None
started = time.monotonic()
try:
    while time.monotonic() - started < 180:
        ready, _, _ = select.select([fd], [], [], .05)
        if ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b''
            output += data.decode('utf8', errors='replace').replace('\r', '')
            if len(output) > 2 * 1024 * 1024:
                raise RuntimeError('TTY output limit')
        while 'Reply yes/no:' in output[consumed:]:
            end = output.index('Reply yes/no:', consumed) + len('Reply yes/no:')
            prompt = output[consumed:end]
            consumed = end
            marker = prompt.rfind('Approve ONE operation: ')
            if marker < 0:
                raise RuntimeError('Missing concrete approval')
            lines = prompt[marker:].split('\n')
            metadata = json.loads(lines[1])
            permitted = (lines[0].startswith('Approve ONE operation: edit: ') and metadata.get('filepath') == str(project / 'sum.mjs')) or (lines[0] == 'Approve ONE operation: bash: npm test' and metadata.get('command') == 'npm test' and metadata.get('workdir') == str(project))
            if mode == 'cancel-command' and metadata.get('filepath') is not None:
                permitted = False
            if not permitted:
                raise RuntimeError('Unexpected operation requires inspection')
            if mode == 'deny':
                os.write(fd, b'no\r')
                denials += 1
            else:
                os.write(fd, b'yes\r')
                approvals += 1
            if approvals + denials > 8:
                raise RuntimeError('Approval limit')
        if mode == 'cancel-command' and not signalled and Path(control['commandMarker']).exists():
            os.kill(pid, signal.SIGINT)
            signalled = True
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            exit_code = os.waitstatus_to_exitcode(status)
            break
    if exit_code is None:
        raise RuntimeError('TTY lifecycle timeout')
except Exception as exc:
    error = str(exc)
finally:
    if exit_code is None:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        for _ in range(240):
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                exit_code = os.waitstatus_to_exitcode(status)
                break
            time.sleep(.05)
        if exit_code is None:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
    os.close(fd)
    transcript = Path(control['transcript'])
    handle = os.open(transcript, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(handle, 'w') as stream:
        stream.write(output)
report = {'exitCode': exit_code, 'approvals': approvals, 'denials': denials, 'signalled': signalled, 'error': error}
print(json.dumps(report))
if error:
    sys.exit(1)
