import { withoutDeliveryCredentials } from './engine/environment.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { stopChild } from './server.js';
/** Bounded newline JSON parser; malformed/truncated events never become successful results. */
export class JsonLines {
  private buffer = '';
  constructor(readonly emit: (value: Record<string, any>) => void) {}
  push(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 4 * 1024 * 1024) throw new Error('PROTOCOL_LIMIT');
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_EVENT');
      this.emit(value);
    }
  }
  finish() { if (this.buffer.trim()) throw new Error('TRUNCATED_EVENT'); }
}
export function subscriptionEnvironment(): NodeJS.ProcessEnv {
  const env = withoutDeliveryCredentials();
  for (const key of Object.keys(env)) if (/^(?:ANTHROPIC_|OPENAI_|OPENROUTER_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN|CODEX_API_KEY)/.test(key)) delete env[key];
  env.CLAUDE_CODE_DISABLE_FILE_MENTIONS = '1';
  return env;
}
export class RpcProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private closed = false;
  onNotification?: (method: string, params: any) => void;
  onRequest?: (method: string, params: any) => Promise<unknown>;
  onClose?: () => void;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(executable: string, args: string[], cwd: string) {
    this.child = spawn(executable, args, { cwd, env: subscriptionEnvironment(), stdio: 'pipe' });
    const fail = () => { this.closed = true; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('RPC_UNAVAILABLE')); } this.pending.clear(); this.onClose?.(); };
    const parser = new JsonLines(value => {
      if (value.method === undefined && typeof value.id === 'number' && this.pending.has(value.id)) {
        const p = this.pending.get(value.id)!; clearTimeout(p.timer); this.pending.delete(value.id);
        value.error ? p.reject(new Error('RPC_REJECTED')) : p.resolve(value.result);
      } else if (value.id !== undefined) {
        void (async () => {
          try { if (!this.onRequest) throw new Error('Request denied'); const result = await this.onRequest(value.method, value.params); this.child.stdin.write(JSON.stringify({ id: value.id, result }) + '\n'); }
          catch { this.child.stdin.write(JSON.stringify({ id: value.id, error: { code: -32601, message: 'Unsolicited request denied' } }) + '\n'); }
        })().catch(fail);
      } else if (typeof value.method === 'string') this.onNotification?.(value.method, value.params);
    });
    this.child.stdout.on('data', b => { try { parser.push(b.toString()); } catch { fail(); this.child.kill(); } });
    this.child.stderr.on('data', () => {});
    this.child.on('error', fail); this.child.on('exit', fail);
    this.child.stdin.on('error', fail);
  }
  request(method: string, params: unknown = {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error('RPC_CLOSED'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('RPC_TIMEOUT')); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  notify(method: string) { this.child.stdin.write(JSON.stringify({ method }) + '\n'); }
  async close() { this.closed = true; await stopChild(this.child); }
}

/** Own a validation process group so abort also terminates npm's test children on POSIX. */
export async function runOwnedValidation(command: string, args: string[], cwd: string, signal: AbortSignal): Promise<{ exit: number; stdout: string; stderr: string }> {
  if (signal.aborted) throw new Error('COMMAND_CANCELLED');
  const child = spawn(command, args, { cwd, env: subscriptionEnvironment(), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', uncertain = false;
  const kill = () => {
    uncertain = true;
    if (!child.pid) return;
    try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already exited. */ }
  };
  const timer = setTimeout(kill, 60000); signal.addEventListener('abort', kill, { once: true });
  const append = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
    if (kind === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    if (stdout.length + stderr.length > 1024 * 1024) kill();
  };
  child.stdout?.on('data', chunk => append('stdout', chunk)); child.stderr?.on('data', chunk => append('stderr', chunk));
  try {
    const exit = await new Promise<number>((resolve, reject) => {
      child.once('error', () => reject(new Error('COMMAND_UNAVAILABLE')));
      child.once('close', code => uncertain || code === null ? reject(new Error('COMMAND_OUTCOME_UNCERTAIN')) : resolve(code));
    });
    return { exit, stdout, stderr };
  } finally { clearTimeout(timer); signal.removeEventListener('abort', kill); }
}
