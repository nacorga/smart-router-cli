import { lstat, mkdir, readFile, rename, writeFile, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stateRoot } from '../state.js';
import { noSymlinks, canonicalHostPath } from './workspace.js';
import type { TaskSpec } from './task-spec.js';
import type { Workspace } from './workspace.js';
import type { ValidationCheck } from './validation.js';
export type WorkflowState = 'CREATED' | 'PREPARING' | 'EXECUTING' | 'VALIDATING' | 'REVIEWING' | 'AWAITING_DELIVERY_APPROVAL' | 'DELIVERING' | 'DRAFT_PR_CREATED' | 'READY_LOCAL' | 'BLOCKED' | 'FAILED' | 'UNVERIFIED' | 'CANCELLED';
const transitions: Record<WorkflowState, WorkflowState[]> = {
  CREATED: ['PREPARING', 'BLOCKED', 'CANCELLED'], PREPARING: ['EXECUTING', 'BLOCKED', 'CANCELLED'],
  EXECUTING: ['EXECUTING', 'VALIDATING', 'BLOCKED', 'FAILED', 'UNVERIFIED', 'CANCELLED'],
  VALIDATING: ['VALIDATING', 'REVIEWING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  REVIEWING: ['AWAITING_DELIVERY_APPROVAL', 'BLOCKED', 'CANCELLED'],
  AWAITING_DELIVERY_APPROVAL: ['DELIVERING', 'BLOCKED', 'CANCELLED'],
  DELIVERING: ['DELIVERING', 'READY_LOCAL', 'DRAFT_PR_CREATED', 'BLOCKED'],
  READY_LOCAL: ['READY_LOCAL', 'DELIVERING', 'DRAFT_PR_CREATED', 'BLOCKED'],
  DRAFT_PR_CREATED: ['BLOCKED'], BLOCKED: ['BLOCKED', 'EXECUTING', 'CANCELLED'],
  FAILED: ['BLOCKED'], UNVERIFIED: ['BLOCKED', 'CANCELLED'], CANCELLED: ['CANCELLED'],
};
export interface FactoryEvent { taskId: string; timestamp: string; type: 'transition' | 'approval-requested' | 'approval-granted' | 'approval-denied' | 'validation' | 'recovery' | 'result'; state?: WorkflowState; operationId: string }
export interface FactoryTask {
  version: 1; mode: 'provider' | 'offline-fixture'; id: string; spec: TaskSpec; state: WorkflowState; workspace?: Workspace;
  engineId?: string; engineStatus?: string; engineNote?: string; engineConfigHash?: string; engineSummary?: { calls: number; apiSpentUsd: number | null; subscriptionCostUsd: null; unknownCost: boolean; usageRecords: number; stages: { kind: string; status: string; models: string[] }[] }; engineFingerprint?: string; checks: ValidationCheck[];
  validatedHash?: string; events: FactoryEvent[]; approvals: { operationId: string; digest: string; granted: boolean; reason?: 'ABORTED' }[];
  operation?: { id: string; kind: string }; reason?: string; pid: number; createdAt: string;
  delivery?: { commit?: string; pushed?: boolean; pr?: string; remote?: string; url?: string; base?: string };
}
export class FactoryStore {
  readonly root: string; readonly projectLockRoot: string;
  constructor(root?: string, projectLockRoot?: string) {
    this.root = canonicalHostPath(root ?? join(stateRoot(), 'factory'));
    this.projectLockRoot = canonicalHostPath(projectLockRoot ?? (root === undefined ? stateRoot() : join(this.root, 'engine')));
  }
  async init() {
    await noSymlinks(this.root, true);
    await mkdir(this.root, { recursive: true, mode: 0o700 }); await noSymlinks(this.root);
    const info = await lstat(this.root);
    if (!info.isDirectory() || (info.mode & 0o077)) throw new Error('PRIVATE_STATE_PERMISSIONS_REQUIRED');
  }
  private path(id: string) { if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('Invalid task ID'); return join(this.root, id + '.json'); }
  async save(task: FactoryTask, exclusive = false) {
    await this.init(); const target = this.path(task.id);
    if (exclusive) { await writeFile(target, JSON.stringify(task), { flag: 'wx', mode: 0o600 }); return; }
    const temp = target + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(task), { flag: 'wx', mode: 0o600 }); await rename(temp, target);
  }
  async get(id: string): Promise<FactoryTask> {
    await this.init(); const path = this.path(id), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('PRIVATE_STATE_FILE_REQUIRED');
    const task = JSON.parse(await readFile(path, 'utf8')) as FactoryTask;
    if (task.version !== 1 || task.id !== id) throw new Error('Invalid Factory checkpoint'); return task;
  }
  async lock(id: string) {
    await this.init(); const path = join(this.root, 'active.lock');
    try {
      const file = await open(path, 'wx', 0o600);
      await file.writeFile(JSON.stringify({ taskId: id, pid: process.pid, at: new Date().toISOString() })); await file.close();
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('INSPECTION_REQUIRED: Factory lock exists; verify owner and child processes before manual removal'); throw e; }
    return async () => { await unlink(path); };
  }
  async transition(task: FactoryTask, state: WorkflowState, operation?: string | FactoryTask['operation']) {
    if (!transitions[task.state]?.includes(state)) throw new Error('INVALID_WORKFLOW_TRANSITION');
    task.state = state; task.pid = process.pid;
    task.operation = typeof operation === 'string' ? { id: randomUUID(), kind: operation } : operation;
    task.events.push({ taskId: task.id, timestamp: new Date().toISOString(), type: 'transition', state, operationId: task.operation?.id ?? randomUUID() });
    await this.save(task);
  }
}
