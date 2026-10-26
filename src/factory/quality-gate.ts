import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { safeProjectPath, secretPath } from '../continuity-state.js';
import { git } from './workspace.js';
import { matches, type TaskSpec } from './task-spec.js';
import type { FactoryTask } from './state.js';

export async function changedPaths(root: string, base: string) {
  return [...new Set(((await git(root, ['diff', '--no-renames', '--name-only', '-z', base, '--'])) + (await git(root, ['ls-files', '--others', '--exclude-standard', '-z']))).split('\0').filter(Boolean))].sort();
}
export function scopeAllows(spec: TaskSpec, name: string) {
  return !secretPath(name) && !/(^|\/)(?:node_modules|\.github|\.gitmodules|\.gitattributes|\.gitignore)(?:\/|$)/i.test(name)
    && !/(^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|requirements[^/]*\.txt|pyproject\.toml)$/i.test(name)
    && spec.scope.allowedPaths.some(p => matches(name, p)) && !spec.scope.protectedPaths.some(p => matches(name, p));
}
/** Names are inspected before content; excluded secrets are never read. */
export async function scopeCheck(task: FactoryTask) {
  const w = task.workspace!;
  if ((await git(w.path, ['rev-parse', 'HEAD'])).trim() !== (task.delivery?.commit ?? w.baseSha)) throw new Error('WORKSPACE_HEAD_CHANGED');
  if ((await git(w.path, ['symbolic-ref', '--short', 'HEAD'])).trim() !== w.branch) throw new Error('WORKSPACE_BRANCH_CHANGED');
  if ((await git(w.path, ['ls-files', '--unmerged'])).trim()) throw new Error('UNMERGED_INDEX');
  const names = await changedPaths(w.path, w.baseSha);
  if (!names.length) throw new Error('NO_CHANGES_TO_DELIVER');
  if (names.some(name => !scopeAllows(task.spec, name))) throw new Error('SCOPE_OR_PROTECTED_PATH_DENIED');
  // Reject submodules and symlinks even if deleted or replaced in the index.
  const modes = await git(w.path, ['ls-files', '--stage', '-z']);
  if (modes.split('\0').some(line => /^(120000|160000) /.test(line))) throw new Error('SYMLINK_OR_SUBMODULE_DENIED');
  for (const name of names) {
    try {
      const path = await safeProjectPath(w.path, name), info = await lstat(path);
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('REVIEW_FILE_UNAVAILABLE');
      const text = await readFile(path, 'utf8');
      if (/(?:sk-or-v1-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][A-Za-z0-9_+/=-]{16,}["'])/i.test(text)) throw new Error('POSSIBLE_SECRET_IN_DIFF');
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  return names;
}
/** Content identity intentionally survives staging/commit; HEAD and index have separate guards. */
export async function contentHash(root: string) {
  const hash = createHash('sha256'); let bytes = 0;
  const names = [...new Set((await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean))].sort();
  if (names.length > 20000) throw new Error('SNAPSHOT_TOO_LARGE');
  for (const name of names) {
    if (secretPath(name)) { hash.update(name + ':excluded'); continue; }
    try {
      const path = await safeProjectPath(root, name), info = await lstat(path);
      if (!info.isFile() || (bytes += info.size) > 64 * 1024 * 1024) throw new Error('SNAPSHOT_UNAVAILABLE');
      hash.update(name + '\0' + (info.mode & 0o111) + '\0').update(await readFile(path)).update('\0');
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; /* deleted files absent from content tree */ }
  }
  return hash.digest('hex');
}
export async function qualityGate(task: FactoryTask) {
  await scopeCheck(task);
  if (!task.validatedHash || await contentHash(task.workspace!.path) !== task.validatedHash) throw new Error('VALIDATION_STALE');
  const commands = task.spec.validation.commands;
  if (task.checks.length !== commands.length || commands.some((c, i) => {
    const check = task.checks[i];
    return !check || JSON.stringify(check.command) !== JSON.stringify(c) || check.contentHash !== task.validatedHash || (c.required && (check.status !== 'passed' || check.exitCode !== 0));
  })) throw new Error('REQUIRED_VALIDATION_MISSING_OR_FAILED');
}
