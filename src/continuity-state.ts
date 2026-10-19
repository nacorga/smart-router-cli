import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Handoff, PortableTask } from './types.js';
import { Store } from './state.js';
const exec = promisify(execFile);
export const secretPath = (path: string) => path.split(/[\\/]/).some(p => /\.env/i.test(p) || /^\.(?:aws|ssh|git|codex|claude)$/i.test(p) || /credential|\.pem$|^id_(?:rsa|ed25519)$/i.test(p));
export async function safeProjectPath(root: string, name: string, writing = false): Promise<string> {
  const base = await realpath(root), path = resolve(base, name), rel = relative(base, path);
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || secretPath(rel)) throw new Error('PATH_DENIED');
  let current = base;
  for (const component of rel.split(/[\\/]/)) {
    current = join(current, component);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('SYMLINK_DENIED'); }
    catch (error) { if (writing && (error as NodeJS.ErrnoException).code === 'ENOENT' && current === path) break; throw error; }
  }
  return path;
}
/** Hash project state without copying code or reading excluded secrets. Non-Git roots fail closed. */
export async function projectFingerprint(root: string): Promise<string> {
  const git = async (args: string[]) => (await exec('git', ['-C', root, ...args], { maxBuffer: 8 * 1024 * 1024 })).stdout;
  const head = await git(['rev-parse', 'HEAD']);
  const index = await git(['ls-files', '--stage', '-z']);
  const names = [...new Set((await git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean))].sort();
  if (names.length > 20000) throw new Error('FINGERPRINT_TOO_LARGE');
  const hash = createHash('sha256').update(head).update(index); let bytes = 0;
  for (const name of names) {
    hash.update('\0' + name + '\0');
    if (secretPath(name)) { hash.update('excluded'); continue; }
    let path: string;
    try { path = await safeProjectPath(root, name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { hash.update('deleted'); continue; } throw error; }
    const stat = await lstat(path);
    if (!stat.isFile() || (bytes += stat.size) > 64 * 1024 * 1024) throw new Error('FINGERPRINT_UNAVAILABLE');
    hash.update(JSON.stringify([stat.mode, createHash('sha256').update(await readFile(path)).digest('hex')]));
  }
  return hash.digest('hex');
}
export async function handoffProject(project: string) {
  const git = async (args: string[]) => (await exec('git', ['-C', project, ...args], { maxBuffer: 8 * 1024 * 1024 })).stdout;
  const baseRevision = (await git(['rev-parse', 'HEAD'])).trim();
  const changed = (await git(['diff', '--name-only', 'HEAD', '-z'])) + (await git(['ls-files', '--others', '--exclude-standard', '-z']));
  return { baseRevision, filesAffected: [...new Set(changed.split('\0').filter(name => name && !secretPath(name)))].sort() };
}
export class ContinuityStore {
  constructor(readonly store: Store) {}
  private path(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid task ID');
    return join(this.store.root, 'handoffs', id + '.json');
  }
  async save(handoff: Handoff) {
    await mkdir(this.store.root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.store.root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077) !== 0) throw new Error('PRIVATE_STATE_PERMISSIONS_REQUIRED');
    const dir = join(this.store.root, 'handoffs'); await mkdir(dir, { recursive: true, mode: 0o700 });
    const dirInfo = await lstat(dir);
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw new Error('PRIVATE_STATE_DIRECTORY_REQUIRED');
    await chmod(dir, 0o700);
    const path = this.path(handoff.taskId), tmp = path + '.' + randomUUID() + '.tmp';
    await writeFile(tmp, JSON.stringify(handoff), { mode: 0o600, flag: 'wx' }); await rename(tmp, path);
  }
  async get(id: string): Promise<Handoff> {
    const h: Handoff = JSON.parse(await readFile(this.path(id), 'utf8'));
    if (h.schemaVersion !== 2 || h.taskId !== id || typeof h.objective !== 'string' || typeof h.fingerprint !== 'string' || h.observationsTrusted !== false) throw new Error('Invalid private handoff');
    return h;
  }
}
export function coordination(task: PortableTask): string {
  return ['# Smart coordination', '', `Status: ${task.status}`, `Requests: ${task.calls}`, `Completed stages: ${task.stages.filter(s => s.status === 'done').length}/${task.stages.length}`, `Transitions: ${task.transitions.length}`, `Request state: ${task.requestState}`, '', 'Observations and private task content omitted.'].join('\n');
}
