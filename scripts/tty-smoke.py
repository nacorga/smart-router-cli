import sys,shutil,os,pty,select,time,tempfile,json,threading,http.server,signal,hashlib,subprocess
from pathlib import Path
repo=Path(__file__).resolve().parent.parent
# Optional first argument: a clean npm installation root containing node_modules/.bin/smart.
installed=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else None
cli=[str(installed/'node_modules/.bin/smart')] if installed else [shutil.which('node'),str(repo/'dist/cli.js')]
root=Path(tempfile.mkdtemp(prefix='smart-tty-')).resolve()
config=json.loads(subprocess.check_output([shutil.which('node'),'--input-type=module','-e',"import {smokeConfig} from './dist/smoke-fixture.js';console.log(JSON.stringify(smokeConfig()));"],cwd=repo,text=True));config['mode']='auto';config['limits']['maxCostUsd']=.1
(root/'smart-router.config.json').write_text(json.dumps(config));(root/'note.txt').write_text('BEFORE')
requests=[]
class Mock(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  if self.path!='/chat/completions' or self.headers.get('Authorization')!='Bearer local-tty-smoke-only': self.send_error(403);return
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));requests.append(body['model'])
  tool_done=any(m.get('role')=='tool' for m in body['messages'])
  delta={'role':'assistant','content':'Operation handled. No tests were executed.'} if tool_done else {'role':'assistant','tool_calls':[{'index':0,'id':'call_'+str(len(requests)),'type':'function','function':{'name':'edit','arguments':json.dumps({'filePath':str(root/'note.txt'),'oldString':'BEFORE','newString':'AFTER'})}}]}
  base={'id':'gen-local-tty-'+str(len(requests)),'object':'chat.completion.chunk','created':1,'model':body['model']}
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  for event in [{**base,'choices':[{'index':0,'delta':delta,'finish_reason':None}]},{**base,'choices':[{'index':0,'delta':{},'finish_reason':'stop' if tool_done else 'tool_calls'}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}]:self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode())
  self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Mock);threading.Thread(target=server.serve_forever,daemon=True).start()
provider=json.loads(subprocess.check_output([shutil.which('node'),'--input-type=module','-e',"import {smokeProviderConfig} from './dist/smoke-fixture.js';console.log(JSON.stringify(smokeProviderConfig(process.argv[1])));",'http://127.0.0.1:'+str(server.server_port)],cwd=repo,text=True))
(root/'opencode.json').write_text(json.dumps(provider))
env={**os.environ,'OPENROUTER_API_KEY':'local-tty-smoke-only','SMART_STATE_DIR':str(root/'state'),'TERM':'xterm-256color'}
for name in ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME']:
 path=root/name.lower();path.mkdir();env[name]=str(path)
pid,fd=pty.fork()
if pid==0:
 os.chdir(root);os.execve(cli[0],cli,env)
output='';exit_status=None

def wait_for(text,start=0,seconds=60):
 global output,exit_status
 end=time.monotonic()+seconds
 while text not in output[start:]:
  if time.monotonic()>end:raise RuntimeError('TTY timeout waiting for '+text+'; tail='+output[-1600:])
  ready,_,_=select.select([fd],[],[],.1)
  if ready:
   try:data=os.read(fd,65536)
   except OSError:data=b''
   if not data:raise RuntimeError('TTY closed before '+text+'; tail='+output[-1600:])
   output+=data.decode('utf8',errors='replace')
 return len(output)
def send(text):os.write(fd,(text+'\r').encode())
try:
 wait_for('smart> /help')
 offset=len(output);send('Corrige la errata de note.txt')
 wait_for('Approve ONE operation:',offset);wait_for('Reply yes/no:',offset)
 send('no');wait_for('Result: blocked',offset)
 assert (root/'note.txt').read_text()=='BEFORE'
 print('TTY rejection preserved file',flush=True)
 offset=len(output);send('Corrige la errata de note.txt')
 wait_for('Approve ONE operation:',offset);wait_for('Reply yes/no:',offset)
 send('yes');wait_for('Result: unverified',offset)
 assert (root/'note.txt').read_text()=='AFTER'
 print('TTY approval edited file without claiming tests',flush=True)
 offset=len(output);send('/status');wait_for('"status": "unverified"',offset)
 send('/exit')
 end=time.monotonic()+20
 while time.monotonic()<end:
  child,status=os.waitpid(pid,os.WNOHANG)
  if child:exit_status=os.waitstatus_to_exitcode(status);break
  ready,_,_=select.select([fd],[],[],.05)
  if ready:
   try: output+=os.read(fd,65536).decode('utf8',errors='replace')
   except OSError: pass
 assert exit_status==1,('exit',exit_status)
 report={'status':'passed','transport':'POSIX controlling pseudo-terminal; scripted yes/no keystrokes, not human UX assessment','runtime':'fresh tarball installation with its own npm dependencies, no symlink' if installed else 'compiled repository CLI','projectPath':str(root),'localMockRequests':len(requests),'realProviderInferenceRequests':0,'billableCostUsd':0,'checks':{'permissionRejectPreservesFile':True,'permissionYesAllowsExactEdit':True,'noTestsRemainUnverified':True,'statusInTTY':True,'cleanExit':True},'exitCode':exit_status,'exitCodeReason':'Earlier rejected task sets exit code 1; process exited normally','finishedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
 (root/'tty-smoke-result.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps(report),flush=True)
finally:
 if exit_status is None:
  try:os.kill(pid,signal.SIGTERM)
  except ProcessLookupError:pass
 os.close(fd);server.shutdown();server.server_close()
