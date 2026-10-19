import { mkdir, readFile, writeFile, rename, readdir, open, unlink, realpath, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Task } from './types.js';
const exec = promisify(execFile);
export const stateRoot = () => process.env.SMART_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'smart-router');
export async function projectRoot(dir: string): Promise<string> {
  try { return (await exec('git', ['-C', dir, 'rev-parse', '--show-toplevel'])).stdout.trim(); } catch { return realpath(dir); }
}
export async function gitSnapshot(dir: string): Promise<string> {
  try { return (await exec('git', ['-C', dir, 'status', '--porcelain=v1'], { maxBuffer: 1024 * 1024 })).stdout; } catch { return 'NOT_A_GIT_REPOSITORY'; }
}
/** Metadata only: instruction contents remain in the native backend, never the task log. */
export async function inspectProject(dir: string) {
  const [status, branch, instructions] = await Promise.all([
    gitSnapshot(dir),
    exec('git', ['-C', dir, 'symbolic-ref', '--quiet', '--short', 'HEAD']).then(r => r.stdout.trim()).catch(() => exec('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']).then(r => `detached:${r.stdout.trim()}`).catch(() => null)),
    stat(join(dir, 'AGENTS.md')).then(s => s.isFile() ? ['AGENTS.md'] : []).catch((e:NodeJS.ErrnoException) => { if(e.code === 'ENOENT') return []; throw e; }),
  ]);
  return { git: status !== 'NOT_A_GIT_REPOSITORY', branch, dirty: status === 'NOT_A_GIT_REPOSITORY' ? null : status.length > 0, instructionFiles: instructions };
}
export class Store {
  constructor(readonly root = stateRoot()) {}
  private path(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid task ID'); return join(this.root, `${id}.json`); }
  async save(task: Task) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    task.updatedAt = new Date().toISOString();
    const path = this.path(task.id); const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(task, null, 2), { mode: 0o600 }); await rename(temp, path);
  }
  async get(id: string): Promise<Task> {
    const task = JSON.parse(await readFile(this.path(id), 'utf8'));
    if (task.schemaVersion !== undefined && task.schemaVersion !== 2) throw new Error('Unsupported checkpoint version');
    return task;
  }
  async list(project?: string): Promise<Task[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const tasks: Task[] = [];
    for (const file of await readdir(this.root)) if (/^[a-f0-9-]{36}\.json$/.test(file)) { const task = await this.get(file.slice(0, -5)); if (!project || task.projectPath === project) tasks.push(task); }
    return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
export async function lockProject(project: string, root = stateRoot()): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${createHash('sha256').update(await realpath(project)).digest('hex')}.lock`);
  let f;
  try { f = await open(path, 'wx', 0o600); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Project locked by another writer or an interrupted run. Inspect ${path}; remove the lock only after verifying that the previous backend and its owned commands have stopped.`);
    throw e;
  }
  await f.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); await f.close();
  return async () => { await unlink(path); };
}
