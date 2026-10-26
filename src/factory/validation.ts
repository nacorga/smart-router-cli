import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApprovalProvider } from '../engine/index.js';
import type { FactoryStore, FactoryTask } from './state.js';
import { hostEnvironment } from './workspace.js';
import { contentHash, scopeCheck } from './quality-gate.js';
import { approval, digest } from './approvals.js';
import { validateCommand, type ValidationCommand } from './task-spec.js';
export interface ValidationCheck {
  command: ValidationCommand; status: 'passed' | 'failed' | 'blocked' | 'unverified';
  exitCode: number | null; startedAt: string; durationMs: number; contentHash: string; evidenceDigest: string; reason?: string;
}
export interface CommandResult { exitCode: number | null; digest: string; reason?: string; terminated: boolean }
/** Owned POSIX process group, bounded output and private HOME; no shell or inherited credentials. */
export async function runValidation(command: ValidationCommand, cwd: string, privateRoot: string, signal: AbortSignal, timeoutMs = 60000): Promise<CommandResult> {
  validateCommand(command);
  if (process.platform === 'win32') throw new Error('POSIX_VALIDATION_REQUIRED');
  if (signal.aborted) return { exitCode: null, digest: digest(''), reason: 'CANCELLED', terminated: true };
  const home = await mkdtemp(join(privateRoot, 'validation-'));
  const child = spawn(command.executable, command.args, { cwd, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...hostEnvironment(), HOME: home, TMPDIR: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, CI: '1', npm_config_ignore_scripts: 'true', npm_config_cache: join(home, 'npm'), npm_config_userconfig: join(home, 'npmrc') } });
  let reason: string | undefined, size = 0, output = '', closed = false;
  const kill = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') reason = 'TERMINATION_UNCONFIRMED'; } };
  const stop = (why: string) => { reason ??= why; kill(); };
  const cancel = () => stop('CANCELLED'); signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
  const capture = (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) stop('OUTPUT_LIMIT'); else output += chunk.toString(); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  let watchdog: NodeJS.Timeout | undefined;
  try {
    const exitCode = await new Promise<number | null>(resolve => {
      child.once('error', () => { reason = 'COMMAND_UNAVAILABLE'; });
      child.once('exit', () => { kill(); }); // kill any descendants retaining pipes
      child.once('close', code => { closed = true; resolve(code); });
      watchdog = setTimeout(() => { stop('TERMINATION_UNCONFIRMED'); resolve(null); }, timeoutMs + 3000);
    });
    let terminated = closed;
    if (child.pid) try { process.kill(-child.pid, 0); terminated = false; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') terminated = false; }
    if (!terminated) reason ??= 'TERMINATION_UNCONFIRMED';
    return { exitCode, digest: digest(output), reason, terminated };
  } finally {
    clearTimeout(timer); clearTimeout(watchdog); signal.removeEventListener('abort', cancel);
    if (closed) await rm(home, { recursive: true, force: true });
  }
}
export async function validateTask(store: FactoryStore, task: FactoryTask, approve: ApprovalProvider, signal: AbortSignal, timeoutMs = 60000) {
  await scopeCheck(task); const before = await contentHash(task.workspace!.path); task.checks = []; task.validatedHash = undefined;
  for (const command of task.spec.validation.commands) {
    const started = Date.now();
    const check: ValidationCheck = { command, status: 'blocked', exitCode: null, startedAt: new Date(started).toISOString(), durationMs: 0, contentHash: before, evidenceDigest: digest('') };
    if (!await approval(store, task, approve, `Run ONE independent validation on trusted local code (no OS sandbox): ${JSON.stringify(command)} in ${task.workspace!.path}; content ${before}`)) check.reason = 'PERMISSION_DENIED';
    else {
      await scopeCheck(task);
      if (await contentHash(task.workspace!.path) !== before) throw new Error('VALIDATION_STALE_AFTER_APPROVAL');
      await store.transition(task, 'VALIDATING', 'validation-command');
      const result = await runValidation(command, task.workspace!.path, store.root, signal, timeoutMs);
      check.exitCode = result.exitCode; check.evidenceDigest = result.digest; check.reason = result.reason;
      check.status = result.reason ? 'blocked' : result.exitCode === 0 ? 'passed' : result.exitCode === null ? 'unverified' : 'failed';
      if (!result.terminated) { task.reason = 'INSPECTION_REQUIRED_PROCESS'; check.reason = 'TERMINATION_UNCONFIRMED'; check.status = 'unverified'; }
    }
    check.durationMs = Date.now() - started; task.checks.push(check);
    task.events.push({ taskId: task.id, timestamp: new Date().toISOString(), type: 'validation', operationId: task.operation?.id ?? task.id });
    if (check.reason === 'TERMINATION_UNCONFIRMED') { await store.save(task); return; }
    task.operation = undefined; await store.save(task);
    if (signal.aborted) break;
  }
  await scopeCheck(task);
  if (await contentHash(task.workspace!.path) !== before) { task.reason = 'VALIDATION_CHANGED_WORKTREE'; return; }
  task.validatedHash = before; await store.save(task);
}
