import { it, expect } from 'vitest';
import { readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { repositoryFixture as fixture } from './factory-repository.js';
import { preflight, createWorkspace, git } from '../src/factory/workspace.js';
it('creates an exact base worktree and preserves original HEAD, index and dirty bytes', async () => {
  const f = await fixture();
  try {
    const head = await git(f.repo, ['rev-parse', 'HEAD']), index = await git(f.repo, ['ls-files', '--stage']), status = await git(f.repo, ['status', '--porcelain']);
    const w = await preflight(f.repo, 'main', f.stateRoot, f.spec.id); await createWorkspace(w);
    expect(w.baseSha).toBe(head.trim()); expect(w.originalDirty).toBe(true);
    expect(await git(w.path, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await git(f.repo, ['rev-parse', 'HEAD'])).toBe(head); expect(await git(f.repo, ['ls-files', '--stage'])).toBe(index); expect(await git(f.repo, ['status', '--porcelain'])).toBe(status);
    expect(await readFile(join(f.repo, 'user.txt'), 'utf8')).toBe('PREVIOUS_USER_CHANGE');
    await expect(preflight(f.repo, 'main', f.stateRoot, f.spec.id)).rejects.toThrow();
    await expect(preflight(f.repo, '--bad', f.stateRoot, 'another')).rejects.toThrow();
    await symlink(f.repo, join(f.root, 'alias'));
    await expect(preflight(join(f.root, 'alias'), 'main', f.stateRoot, 'alias')).rejects.toThrow('SYMLINK');
    const w2 = await preflight(f.repo, 'main', f.stateRoot, 'another'); await createWorkspace(w2);
    expect(w2.path).not.toBe(w.path); expect(await git(w2.path, ['status', '--porcelain'])).toBe('');
  } finally { await f.cleanup(); }
});
