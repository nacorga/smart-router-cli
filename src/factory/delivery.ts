import { readFile, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { lockProject } from '../state.js';
import { join } from 'node:path';
import { denyApproval, type ApprovalProvider } from '../engine/index.js';
import { FactoryStore, type FactoryTask } from './state.js';
import { qualityGate, scopeCheck, contentHash } from './quality-gate.js';
import { git } from './workspace.js';
import { approval } from './approvals.js';
const exec = promisify(execFile);
export interface PullRequest { url: string; head: string; base: string; draft: boolean; state: string }
export interface GitHubClient {
  validateRepository(repository: string): void;
  gitEnvironment?(): NodeJS.ProcessEnv;
  available(): Promise<boolean>;
  find(repository: string, branch: string, base: string): Promise<PullRequest[]>;
  create(input: { repository: string; branch: string; base: string; title: string; body: string; draft: true }): Promise<string>;
}
/** Host-only client. No credentials are passed to the engine or validation processes. */
export class GhClient implements GitHubClient {
  private repo(url: string) {
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
    if (!match) throw new Error('GITHUB_REMOTE_REQUIRED'); return match[1]!;
  }
  validateRepository(repository: string) { this.repo(repository); }
  gitEnvironment(): NodeJS.ProcessEnv {
    // Host Git credential helpers/SSH agent only, after delivery approval.
    return Object.fromEntries(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'SSH_AUTH_SOCK', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
  }
  private async gh(args: string[]) { return (await exec('gh', args, { timeout: 30000, maxBuffer: 1024 * 1024 })).stdout.trim(); }
  async available() { try { await this.gh(['auth', 'status', '--hostname', 'github.com']); return true; } catch { return false; } }
  async find(repository: string, branch: string, base: string): Promise<PullRequest[]> {
    const rows = JSON.parse(await this.gh(['pr', 'list', '--repo', 'https://github.com/' + this.repo(repository), '--head', branch, '--base', base, '--state', 'all', '--json', 'url,headRefOid,baseRefName,isDraft,state']));
    return rows.map((r: any) => ({ url: r.url, head: r.headRefOid, base: r.baseRefName, draft: r.isDraft, state: r.state }));
  }
  async create(i: { repository: string; branch: string; base: string; title: string; body: string; draft: true }) {
    return this.gh(['pr', 'create', '--repo', 'https://github.com/' + this.repo(i.repository), '--head', i.branch, '--base', i.base, '--title', i.title, '--body', i.body, '--draft']);
  }
}
export function deliveryBody(task: FactoryTask) {
  return [`Factory task: ${task.id}`, '', 'Requested acceptance criteria (human review required):', ...task.spec.acceptance.map(s => `- [ ] ${s}`), '', `Execution: ${task.mode}.`, `Validated content SHA-256: ${task.validatedHash}`, 'Independent checks:', ...task.checks.map(c => `- ${JSON.stringify([c.command.executable, ...c.command.args])}: ${c.status}, exit ${c.exitCode}; evidence SHA-256 ${c.evidenceDigest}`), '', 'Static review checked scope and validation freshness. No independent model review or production reliability claim. Git worktrees and approvals are not an OS sandbox. Factory automatic repairs are disabled.'].join('\n');
}
export class DeliveryManager {
  constructor(readonly store: FactoryStore, readonly approve: ApprovalProvider = denyApproval, readonly github: GitHubClient = new GhClient()) {}
  async preview(id: string) {
    const task = await this.store.get(id); await qualityGate(task);
    const paths = await scopeCheck(task);
    const untracked = (await git(task.workspace!.path, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
    return { taskId: id, contentHash: task.validatedHash, paths, body: deliveryBody(task), diff: await git(task.workspace!.path, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', task.workspace!.baseSha, '--']), newFiles: await Promise.all(untracked.map(async name => ({ path: name, content: await readFile(join(task.workspace!.path, name), 'utf8') }))) };
  }
  async deliver(id: string) {
    const unlock = await this.store.lock(id); let retainLocks = false, task: FactoryTask | undefined, unlockProject: (() => Promise<void>) | undefined;
    try {
      task = await this.store.get(id);
      if (!['AWAITING_DELIVERY_APPROVAL', 'READY_LOCAL', 'DRAFT_PR_CREATED', 'DELIVERING'].includes(task.state)) throw new Error('Validated delivery checkpoint required');
      const w = task.workspace!; unlockProject = await lockProject(w.path, this.store.projectLockRoot);
      await qualityGate(task);
      if (task.state === 'DRAFT_PR_CREATED') return task;
      if (task.operation && !['push', 'draft-pr'].includes(task.operation.kind)) throw new Error('INSPECTION_REQUIRED_NO_REPLAY');
      const paths = await scopeCheck(task);
      if (!task.delivery?.commit) {
        if (!await approval(this.store, task, this.approve, `Create ONE local commit on ${w.branch} from ${w.baseSha}, content ${task.validatedHash}, files ${JSON.stringify(paths)}, message ${JSON.stringify(task.spec.title)}?`)) return task;
        await qualityGate(task);
        await this.store.transition(task, 'DELIVERING', 'local-commit');
        await git(w.path, ['add', '--', ...paths]);
        if (await contentHash(w.path) !== task.validatedHash || (await git(w.path, ['diff', '--no-ext-diff', '--no-textconv', '--name-only'])).trim()) throw new Error('VALIDATION_STALE');
        await verifyStagedBytes(w.path, paths);
        await git(w.path, ['-c', 'commit.gpgSign=false', 'commit', '-m', task.spec.title, '-m', `Factory-Task: ${task.id}\nFactory-Content: ${task.validatedHash}`]);
        const commit = (await git(w.path, ['rev-parse', 'HEAD'])).trim();
        task.delivery = { commit }; task.operation = undefined; await this.store.save(task); await qualityGate(task);
      }
      if (task.operation && !task.spec.delivery.draftPR) throw new Error('DELIVERY_TARGET_CHANGED');
      if (!task.spec.delivery.draftPR) { task.reason = 'LOCAL_COMMIT_READY'; await this.store.transition(task, 'READY_LOCAL'); return task; }
      let url: string;
      try {
        url = (await git(w.path, ['remote', 'get-url', '--push', 'origin'])).trim();
        if ((await git(w.path, ['remote', 'get-url', 'origin'])).trim() !== url || /[\x00-\x20]/.test(url) || url.startsWith('-')) throw new Error('REMOTE_TARGET_AMBIGUOUS');
      } catch { if (task.operation) throw new Error('INSPECTION_REQUIRED_REMOTE_UNAVAILABLE'); task.reason = 'REMOTE_NOT_CONFIGURED'; await this.store.transition(task, 'READY_LOCAL'); return task; }
      if (task.delivery!.url && (task.delivery!.url !== url || task.delivery!.base !== task.spec.repository.baseRef)) throw new Error('DELIVERY_TARGET_CHANGED');
      this.github.validateRepository(url);
      const base = task.spec.repository.baseRef, commit = task.delivery!.commit!;
      // Read remote state only after explicit approval of the concrete destination.
      if (!await approval(this.store, task, this.approve, `Inspect delivery refs and existing PRs at ${url}, head ${w.branch}, commit ${commit}, base ${base}; recovery never blindly repeats a publication?`)) {
        if (!task.operation) { task.reason = 'REMOTE_INSPECTION_DENIED'; await this.store.transition(task, 'READY_LOCAL'); } return task;
      }
      if (!await this.github.available()) { if (!task.operation) { task.reason = 'GITHUB_AUTH_OR_CLIENT_UNAVAILABLE'; await this.store.transition(task, 'READY_LOCAL'); } return task; }
      await this.verifyTarget(task, url); await qualityGate(task);
      const remote = (await this.remoteGit(w.path, ['ls-remote', '--heads', url, `refs/heads/${w.branch}`])).trim().split(/\s/)[0] || undefined;
      const existing = await this.github.find(url, w.branch, base);
      if (existing.length > 1 || existing.some(pr => pr.head !== commit || pr.base !== base || !pr.draft || pr.state !== 'OPEN')) throw new Error('REMOTE_PR_CONFLICT_INSPECT_REQUIRED');
      if (existing.length) {
        if (remote !== commit) throw new Error('REMOTE_HEAD_CONFLICT');
        task.delivery!.pr = existing[0]!.url; task.delivery!.pushed = true; task.operation = undefined;
        await this.store.transition(task, 'DRAFT_PR_CREATED'); return task;
      }
      if (task.operation?.kind === 'push' && remote !== commit) throw new Error('INSPECTION_REQUIRED_PUSH_RESULT_UNKNOWN');
      if (remote && remote !== commit) throw new Error('REMOTE_HEAD_CONFLICT');
      // A confirmed remote read reconciles a previous uncertain push/PR, without replaying it.
      if (task.operation?.kind === 'draft-pr') throw new Error('INSPECTION_REQUIRED_PR_RESULT_UNKNOWN');
      task.operation = undefined; task.delivery = { ...task.delivery, url, base, remote: 'origin', pushed: remote === commit }; await this.store.save(task);
      if (remote !== commit) {
        if (!await approval(this.store, task, this.approve, `Push ONE commit ${commit} to ${url} refs/heads/${w.branch}, without force; base ${base}?`)) { task.reason = 'PUSH_DENIED'; await this.store.transition(task, 'READY_LOCAL'); return task; }
        await qualityGate(task); await this.verifyTarget(task, url);
        await this.store.transition(task, 'DELIVERING', 'push');
        await this.remoteGit(w.path, ['-c', 'push.followTags=false', 'push', '--porcelain', url, `${commit}:refs/heads/${w.branch}`]);
        if (!(await this.remoteGit(w.path, ['ls-remote', '--heads', url, `refs/heads/${w.branch}`])).startsWith(commit + '\t')) throw new Error('PUSH_UNCONFIRMED');
        task.delivery!.pushed = true; task.operation = undefined; await this.store.save(task);
      }
      const body = deliveryBody(task);
      if (!await approval(this.store, task, this.approve, `Create ONE DRAFT PR at ${url}, ${w.branch} -> ${base}, commit ${commit}, title ${JSON.stringify(task.spec.title)}\n${body}`)) { task.reason = 'DRAFT_PR_DENIED'; await this.store.transition(task, 'READY_LOCAL'); return task; }
      await qualityGate(task); await this.verifyTarget(task, url);
      const latest = await this.github.find(url, w.branch, base);
      if (latest.length) throw new Error('REMOTE_PR_CHANGED_INSPECT_REQUIRED');
      if (!(await this.remoteGit(w.path, ['ls-remote', '--heads', url, `refs/heads/${w.branch}`])).startsWith(commit + '\t')) throw new Error('REMOTE_HEAD_CHANGED');
      await this.store.transition(task, 'DELIVERING', 'draft-pr');
      const pr = await this.github.create({ repository: url, branch: w.branch, base, title: task.spec.title, body, draft: true });
      const confirmed = await this.github.find(url, w.branch, base);
      if (confirmed.length !== 1 || confirmed[0]!.url !== pr || confirmed[0]!.head !== commit || confirmed[0]!.base !== base || !confirmed[0]!.draft || confirmed[0]!.state !== 'OPEN') throw new Error('DRAFT_PR_UNCONFIRMED');
      if (!(await this.remoteGit(w.path, ['ls-remote', '--heads', url, `refs/heads/${w.branch}`])).startsWith(commit + '\t')) throw new Error('REMOTE_HEAD_CHANGED');
      task.delivery!.pr = pr; task.operation = undefined;
      task.events.push({ taskId: id, timestamp: new Date().toISOString(), type: 'result', operationId: randomUUID() });
      await this.store.transition(task, 'DRAFT_PR_CREATED'); return task;
    } catch (error) {
      retainLocks = !!(error as { killed?: boolean }).killed;
      if (!task) throw new Error('Delivery task unavailable');
      if (!['AWAITING_DELIVERY_APPROVAL', 'READY_LOCAL', 'DRAFT_PR_CREATED', 'DELIVERING'].includes(task.state)) throw new Error('Validated delivery checkpoint required');
      const reason = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : undefined;
      task.reason = reason ?? (task.operation ? 'INSPECTION_REQUIRED_REMOTE_OR_LOCAL_RESULT_UNKNOWN' : 'DELIVERY_BLOCKED_INSPECT_REQUIRED');
      if (!task.operation) await this.store.transition(task, 'BLOCKED'); else await this.store.save(task); return task;
    } finally {
      // Publication uncertainty is reconciled by deliver's read-only remote checks on a later call.
      if (!retainLocks) { await unlockProject?.(); await unlock(); }
    }
  }
  private remoteGit(root: string, args: string[]) { return git(root, args, this.github.gitEnvironment?.()); }
  private async verifyTarget(task: FactoryTask, expected: string) {
    if ((await git(task.workspace!.path, ['remote', 'get-url', '--push', 'origin'])).trim() !== expected || (await git(task.workspace!.path, ['remote', 'get-url', 'origin'])).trim() !== expected) throw new Error('DELIVERY_TARGET_CHANGED');
  }
}

/** Reject checkout/add conversions: validated bytes and delivered blobs must agree. */
async function verifyStagedBytes(root: string, paths: string[]) {
  for (const name of paths) {
    const entry = (await git(root, ['ls-files', '--stage', '-z', '--', name])).split('\0').filter(Boolean);
    let info;
    try { info = await lstat(join(root, name)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (!info) { if (entry.length) throw new Error('STAGED_DELETION_MISMATCH'); continue; }
    const raw = (await git(root, ['hash-object', '--no-filters', '--', name])).trim();
    const [mode, blob, stage] = entry[0]?.split(/ |\t/) ?? [];
    if (entry.length !== 1 || blob !== raw || stage !== '0' || mode !== (info.mode & 0o111 ? '100755' : '100644')) throw new Error('STAGED_BYTES_DIFFER_FROM_VALIDATED_CONTENT');
  }
}
