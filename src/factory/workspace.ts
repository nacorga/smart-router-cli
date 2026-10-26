import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { validRef } from './task-spec.js';
const exec = promisify(execFile);
export function hostEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
export async function git(cwd: string, args: string[]) {
  return (await exec('git', ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', '-C', cwd, ...args], { env: { ...hostEnvironment(), HOME: homedir(), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }, maxBuffer: 8 * 1024 * 1024, timeout: 30000 })).stdout;
}
export function canonicalHostPath(path: string, platform: NodeJS.Platform = process.platform) {
  const absolute = resolve(path);
  return platform === 'darwin' ? absolute.replace(/^\/tmp(?=\/|$)/, '/private/tmp').replace(/^\/var(?=\/|$)/, '/private/var') : absolute;
}
export function outside(root: string, path: string) {
  const rel = relative(root, path); return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
}
export async function noSymlinks(path: string) {
  const absolute = resolve(path); let current: string = sep;
  for (const piece of absolute.split(sep).filter(Boolean)) {
    current = join(current, piece);
    // macOS aliases /tmp and /var are resolved by callers before this check.
    if ((await lstat(current)).isSymbolicLink()) throw new Error('SYMLINK_PATH_DENIED');
  }
}
export interface Workspace { repository: string; baseSha: string; branch: string; path: string; originalDirty: boolean }
export async function preflight(repository: string, baseRef: string, stateRoot: string, id: string): Promise<Workspace> {
  validRef(baseRef);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('Invalid task ID');
  const repo = await realpath(repository); await noSymlinks(repo);
  if (resolve(repository) !== repo && (await lstat(resolve(repository))).isSymbolicLink()) throw new Error('SYMLINK_REPOSITORY_DENIED');
  await noSymlinks(canonicalHostPath(repository));
  if ((await realpath((await git(repo, ['rev-parse', '--show-toplevel'])).trim())) !== repo) throw new Error('Repository root required');
  const common = await realpath(resolve(repo, (await git(repo, ['rev-parse', '--git-common-dir'])).trim()));
  const state = await realpath(stateRoot);
  if (!outside(repo, state) || !outside(common, state)) throw new Error('PRIVATE_STATE_MUST_BE_OUTSIDE_REPOSITORY');
  const baseSha = (await git(repo, ['rev-parse', '--verify', `${baseRef}^{commit}`])).trim();
  if (!/^[a-f0-9]{40,64}$/.test(baseSha)) throw new Error('Invalid base commit');
  const tree = await git(repo, ['ls-tree', '-r', '--full-tree', baseSha]);
  if (tree.split('\n').some(line => /^(?:120000|160000) /.test(line) || /\t(?:.*\/)?\.git(?:attributes|modules)$/.test(line))) throw new Error('UNSUPPORTED_CHECKOUT_FILTERS_OR_LINKS');
  // Worktree checkout/add must not invoke repository-defined filter executables.
  let filters = '';
  try { filters = await git(repo, ['config', '--get-regexp', '^filter\\.']); } catch (e) { if ((e as { code?: number }).code !== 1) throw e; }
  if (filters.trim()) throw new Error('REPOSITORY_FILTERS_DENIED');
  const branch = `factory/${id}`;
  if ((await git(repo, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`])).trim()) throw new Error('Task branch already exists');
  const path = join(state, 'workspaces', id);
  try { await lstat(path); throw new Error('Task workspace already exists'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return { repository: repo, baseSha, branch, path, originalDirty: !!(await git(repo, ['status', '--porcelain'])).trim() };
}
export async function createWorkspace(workspace: Workspace) {
  await mkdir(resolve(workspace.path, '..'), { recursive: true, mode: 0o700 });
  await noSymlinks(resolve(workspace.path, '..'));
  await git(workspace.repository, ['worktree', 'add', '-b', workspace.branch, workspace.path, workspace.baseSha]);
  if ((await git(workspace.path, ['rev-parse', 'HEAD'])).trim() !== workspace.baseSha) throw new Error('WORKSPACE_BASE_MISMATCH');
}
