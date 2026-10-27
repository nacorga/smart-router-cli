import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import type { StageKind, ToolEvent } from './types.js';
import { safeProjectPath, secretPath } from './continuity-state.js';
import { forbiddenCommand } from './safety.js';
import { runOwnedValidation } from './native-transport.js';
import { awaitApproval, type ApprovalProvider } from './approval.js';
const exec = promisify(execFile);
const directValidation = /^(?:npm (?:test|run (?:test(?::[A-Za-z0-9_-]+)?|check|lint|type-?check))|pnpm (?:test|lint|typecheck)|yarn (?:test|lint|typecheck)|pytest|cargo test|go test)(?: [A-Za-z0-9_./:=@-]+)*$/;
/** Both native adapters execute exactly this policy; transport permission grants cannot authorize an operation. */
export class NativeTools {
  touched = false; denied = false; uncertain = false; evidence: string[] = []; events: ToolEvent[] = [];
  private active = false;
  constructor(readonly directory: string, readonly stage: StageKind, readonly approve: ApprovalProvider, readonly signal: AbortSignal) {}
  async call(name: string, args: Record<string, any>) {
    if (this.active) { this.denied = true; return { isError: true, content: [{ type: 'text', text: 'Concurrent operation denied' }] }; }
    this.active = true;
    try {
      if (this.signal.aborted) throw new Error('Cancelled');
      const mutable = this.stage === 'implement' || this.stage === 'validate'; let output: unknown;
      if (name === 'permission') output = { behavior: 'allow', updatedInput: args.input ?? args.tool_input ?? {} };
      else if (name === 'read_file') {
        const path = await safeProjectPath(this.directory, args.path); const stat = await lstat(path);
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('File denied');
        const text = await readFile(path, 'utf8');
        if (text.length > 1024 * 1024) throw new Error('Too large');
        this.touched = true; this.events.push({ id: randomUUID(), kind: 'read', status: 'completed' }); output = text;
      } else if (name === 'list_files') {
        this.touched = true; output = (await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: this.directory, maxBuffer: 4 * 1024 * 1024 })).stdout.split('\0').filter(p => p && !secretPath(p));
      } else if (name === 'write_file') {
        if (!mutable || typeof args.content !== 'string') throw new Error('Stage denied');
        const path = await safeProjectPath(this.directory, args.path, true);
        if (!await this.approveOnce(`edit: ${args.path}\n${JSON.stringify({ filepath: path, content: args.content })}`) || this.signal.aborted) throw new Error('Permission denied');
        await safeProjectPath(this.directory, args.path, true);
        this.touched = true; this.evidence = [];
        try { await writeFile(path, args.content); } catch { this.uncertain = true; throw new Error('Write outcome uncertain'); }
        this.events.push({ id: randomUUID(), kind: 'write', status: 'completed' }); output = 'Written';
      } else if (name === 'run_command') {
        if (!mutable || typeof args.command !== 'string' || !directValidation.test(args.command) || forbiddenCommand(args.command)) throw new Error('Command denied');
        if (!await this.approveOnce(`bash: ${args.command}\n${JSON.stringify({ command: args.command, workdir: this.directory })}`)) throw new Error('Permission denied');
        const [command, ...argv] = args.command.split(' '); this.touched = true;
        const result = await runOwnedValidation(command!, argv, this.directory, this.signal).catch(() => { this.uncertain = true; throw new Error('Command outcome uncertain'); });
        const commandHash = createHash('sha256').update(args.command).digest('hex');
        this.events.push({ id: randomUUID(), kind: 'command', status: result.exit === 0 ? 'completed' : 'failed', commandHash, exitCode: result.exit });
        this.evidence.push(`${commandHash}:${result.exit === 0 ? 'passed' : 'failed'}`); output = result;
      } else throw new Error('Unknown tool');
      return { content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) }] };
    } catch (error) {
      if (name === 'read_file' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.touched = true; this.events.push({ id: randomUUID(), kind: 'read', status: 'failed' });
        return { isError: true, content: [{ type: 'text', text: 'Project file not found' }] };
      }
      this.denied = true; return { isError: true, content: [{ type: 'text', text: 'Smart operation denied or outcome unavailable' }] }; }
    finally { this.active = false; }
  }
  private async approveOnce(description: string) {
    return awaitApproval(this.approve, description, this.signal);
  }
}
