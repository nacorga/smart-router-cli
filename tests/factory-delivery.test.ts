import { it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fixture } from './factory-helpers.js';
import { git } from '../src/factory/workspace.js';
import { DeliveryManager, type GitHubClient, type PullRequest } from '../src/factory/delivery.js';
vi.setConfig({ testTimeout: 20000 });
class FakeGitHub implements GitHubClient {
  rows: PullRequest[] = []; creates: any[] = []; failAfterCreate = false; authenticated = true;
  validateRepository(url: string) { if (!url.startsWith('/')) throw new Error('Local fixture remote required'); }
  async available() { return this.authenticated; }
  async find() { return this.rows; }
  async create(input: any) {
    this.creates.push(input);
    this.rows = [{ url: 'https://example.invalid/pull/1', head: this.head, base: input.base, draft: true, state: 'OPEN' }];
    if (this.failAfterCreate) throw new Error('Connection interrupted after creation');
    return this.rows[0]!.url;
  }
  head = '';
}
async function remoteFixture() {
  const f = await fixture(); const remote = join(f.root, 'remote.git');
  await git(f.root, ['init', '--bare', remote]); await git(f.repo, ['remote', 'add', 'origin', remote]); await git(f.repo, ['push', 'origin', 'main']);
  f.spec.delivery.draftPR = true; const task = await f.factory.run(f.spec); const github = new FakeGitHub();
  return { ...f, task, github, remote };
}
it('requires separate approvals and creates a draft against the correct base using actual local push', async () => {
  const f = await remoteFixture(); const approvals: string[] = [];
  try {
    const original = await git(f.repo, ['status', '--porcelain']), head = await git(f.repo, ['rev-parse', 'HEAD']);
    const manager = new DeliveryManager(f.store, async description => {
      approvals.push(description);
      if (description.startsWith('Create ONE DRAFT')) f.github.head = (await f.store.get(f.task.id)).delivery!.commit!;
      return true;
    }, f.github);
    const delivered = await manager.deliver(f.task.id);
    expect(delivered.state).toBe('DRAFT_PR_CREATED'); expect(delivered.delivery?.pushed).toBe(true);
    expect(f.github.creates[0]).toMatchObject({ draft: true, base: 'main', branch: 'factory/fixture-task' });
    expect(f.github.creates[0].body).toContain('exit 0'); expect(f.github.creates[0].body).not.toContain(f.root);
    expect(approvals.some(d => d.startsWith('Push ONE'))).toBe(true);
    await manager.deliver(f.task.id); expect(f.github.creates).toHaveLength(1);
    expect(await git(f.repo, ['status', '--porcelain'])).toBe(original); expect(await git(f.repo, ['rev-parse', 'HEAD'])).toBe(head);
  } finally { await f.cleanup(); }
});
it('reconciles a pushed commit and an uncertain PR result without duplicate push or PR', async () => {
  const f = await remoteFixture(); let pushes = 0;
  try {
    const manager = new DeliveryManager(f.store, async description => {
      if (description.startsWith('Push ONE')) pushes++;
      if (description.startsWith('Create ONE DRAFT')) { f.github.head = (await f.store.get(f.task.id)).delivery!.commit!; return false; }
      return true;
    }, f.github);
    const pushed = await manager.deliver(f.task.id); expect(pushed.state).toBe('READY_LOCAL'); expect(pushed.delivery?.pushed).toBe(true);
    pushed.state = 'DELIVERING'; pushed.operation = { id: 'simulated-interruption', kind: 'push' }; pushed.delivery!.pushed = false; await f.store.save(pushed);
    f.github.failAfterCreate = true;
    const recovery = new DeliveryManager(f.store, async description => {
      if (description.startsWith('Push ONE')) pushes++;
      if (description.startsWith('Create ONE DRAFT')) f.github.head = (await f.store.get(f.task.id)).delivery!.commit!;
      return true;
    }, f.github);
    const uncertain = await recovery.deliver(f.task.id); expect(uncertain.state).toBe('DELIVERING'); expect(uncertain.operation?.kind).toBe('draft-pr');
    const recovered = await recovery.deliver(f.task.id); expect(recovered.state).toBe('DRAFT_PR_CREATED');
    expect(pushes).toBe(1); expect(f.github.creates).toHaveLength(1);
  } finally { await f.cleanup(); }
});
it('denial never commits or pushes, auth failure stays local, and approval-time mutations invalidate checks', async () => {
  const f = await remoteFixture();
  try {
    const base = await git(f.task.workspace!.path, ['rev-parse', 'HEAD']);
    await new DeliveryManager(f.store, async () => false, f.github).deliver(f.task.id);
    expect(await git(f.task.workspace!.path, ['rev-parse', 'HEAD'])).toBe(base); expect(f.github.creates).toHaveLength(0);
    f.github.authenticated = false;
    const local = await new DeliveryManager(f.store, async () => true, f.github).deliver(f.task.id);
    expect(local.state).toBe('READY_LOCAL'); expect(local.reason).toBe('GITHUB_AUTH_OR_CLIENT_UNAVAILABLE');
    expect((await git(f.repo, ['ls-remote', '--heads', 'origin', `refs/heads/${f.task.workspace!.branch}`])).trim()).toBe('');
    await writeFile(join(f.task.workspace!.path, 'outside.txt'), 'not approved');
    let approvals = 0;
    await new DeliveryManager(f.store, async () => { approvals++; return true; }, f.github).deliver(f.task.id);
    expect(approvals).toBe(0); expect(f.github.creates).toHaveLength(0);
  } finally { await f.cleanup(); }
});
it('blocks changes made inside the commit approval callback before staging', async () => {
  const f = await fixture();
  try {
    const task = await f.factory.run(f.spec), base = await git(task.workspace!.path, ['rev-parse', 'HEAD']);
    const result = await new DeliveryManager(f.store, async () => { await writeFile(join(task.workspace!.path, 'index.mjs'), 'changed after validation'); return true; }).deliver(task.id);
    expect(result.delivery).toBeUndefined(); expect(await git(task.workspace!.path, ['rev-parse', 'HEAD'])).toBe(base);
  } finally { await f.cleanup(); }
});
it('blocks staging conversions that would deliver bytes different from those validated', async () => {
  const f = await fixture();
  try {
    await git(f.repo, ['config', 'core.autocrlf', 'true']);
    const task = await f.factory.run(f.spec);
    // Revalidate a CRLF candidate independently, then Git would convert it on add.
    const { validateTask } = await import('../src/factory/validation.js');
    await writeFile(join(task.workspace!.path, 'index.mjs'), 'export const sum = (a, b) => a + b;\r\n');
    task.state = 'VALIDATING'; await f.store.save(task);
    await validateTask(f.store, task, async () => true, new AbortController().signal);
    task.state = 'AWAITING_DELIVERY_APPROVAL'; await f.store.save(task);
    const result = await new DeliveryManager(f.store, async () => true).deliver(task.id);
    expect(result.delivery?.commit).toBeUndefined(); expect(result.operation?.kind).toBe('local-commit');
    expect((await git(task.workspace!.path, ['rev-parse', 'HEAD'])).trim()).toBe(task.workspace!.baseSha);
  } finally { await f.cleanup(); }
});
it('does not report a created PR as verified when its returned head differs', async () => {
  const f = await remoteFixture();
  try {
    f.github.head = 'different-head';
    const task = await new DeliveryManager(f.store, async () => true, f.github).deliver(f.task.id);
    expect(task.state).toBe('DELIVERING'); expect(task.operation?.kind).toBe('draft-pr');
    expect(task.delivery?.pr).toBeUndefined(); expect(f.github.creates).toHaveLength(1);
  } finally { await f.cleanup(); }
});
