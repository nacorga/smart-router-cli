import { requireConfigured, validateConfig } from '../config.js';
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { denyApproval, type ApprovalProvider, type ExecutionEngine, type EngineHandle } from '../engine/index.js';
import type { Config } from '../types.js';
import { lockProject } from '../state.js';
import { projectFingerprint } from '../continuity-state.js';
import { FactoryStore, type FactoryTask } from './state.js';
import { parseTaskSpec } from './task-spec.js';
import { preflight, createWorkspace } from './workspace.js';
import { qualityGate } from './quality-gate.js';
import { validateTask } from './validation.js';
import { approval } from './approvals.js';

export class Factory {
  constructor(readonly store: FactoryStore, readonly engine: ExecutionEngine, readonly config: Config, readonly approve: ApprovalProvider = denyApproval, readonly mode: 'provider' | 'offline-fixture' = 'provider') {}
  private cancelPath(id: string) { return join(this.store.root, id + '.cancel'); }
  async inspect(id: string) {
    const task = await this.store.get(id);
    if (task.operation) {
      try { process.kill(task.pid, 0); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
          task.reason = 'INSPECTION_REQUIRED_NO_REPLAY';
          task.events.push({ taskId: id, timestamp: new Date().toISOString(), type: 'recovery', operationId: task.operation.id });
          // Preserve operation uncertainty for manual reconciliation.
          await this.store.transition(task, task.state === 'CANCELLED' ? 'CANCELLED' : 'BLOCKED', task.operation);
        }
      }
    }
    return task;
  }
  async cancel(id: string) {
    const task = await this.store.get(id);
    if (['READY_LOCAL', 'DRAFT_PR_CREATED', 'CANCELLED', 'FAILED'].includes(task.state)) return task;
    if (!task.operation && ['AWAITING_DELIVERY_APPROVAL', 'BLOCKED', 'UNVERIFIED'].includes(task.state)) {
      const unlock = await this.store.lock(id);
      try {
        const current = await this.store.get(id);
        if (current.operation) throw new Error('INSPECTION_REQUIRED_NO_REPLAY');
        current.reason = 'CANCELLED_AT_CONFIRMED_IDLE_CHECKPOINT';
        await this.store.transition(current, 'CANCELLED'); return current;
      } finally { await unlock(); }
    }
    await writeFile(this.cancelPath(id), '', { mode: 0o600 });
    // The owner observes this marker and confirms process termination. No PID signaling or replay.
    return { ...task, reason: 'CANCELLATION_REQUESTED; owner must confirm termination' };
  }
  async run(raw: unknown) {
    const spec = parseTaskSpec(raw); await this.store.init(); const unlock = await this.store.lock(spec.id);
    const task: FactoryTask = { version: 1, id: spec.id, spec, state: 'CREATED', checks: [], events: [], approvals: [], pid: process.pid, createdAt: new Date().toISOString(), mode: this.mode };
    let keepLock = false, created = false;
    try {
      // Establish that private state is outside Git before persisting the objective.
      task.workspace = await preflight(spec.repository.path, spec.repository.baseRef, this.store.root, spec.id);
      await this.store.save(task, true); created = true;
      await this.store.transition(task, 'PREPARING', 'worktree-add');
      await createWorkspace(task.workspace); task.operation = undefined; await this.store.save(task);
      await this.execute(task);
      keepLock = !!task.operation;
      return task;
    } catch (e) {
      // Never overwrite a prior task on ID collision.
      if (!created || (e as NodeJS.ErrnoException).code === 'EEXIST') throw e;
      keepLock = !!task.operation;
      task.reason = keepLock ? 'INSPECTION_REQUIRED_NO_REPLAY' : safeReason(e);
      const operation = task.operation;
      await this.store.transition(task, task.state === 'CANCELLED' ? 'CANCELLED' : 'BLOCKED', operation); return task;
    } finally { if (!keepLock) await unlock(); }
  }
  async continue(id: string) {
    const unlock = await this.store.lock(id); let executing = false, task: FactoryTask | undefined;
    try {
      task = await this.inspect(id);
      if (task.operation) throw new Error('INSPECTION_REQUIRED_NO_REPLAY');
      if (task.state === 'AWAITING_DELIVERY_APPROVAL' || task.state === 'READY_LOCAL') { await qualityGate(task); return task; }
      if (task.state !== 'BLOCKED' || !task.engineId || !task.engineFingerprint || task.reason !== 'ENGINE_BLOCKED') throw new Error('No confirmed resumable checkpoint; inspect task. Tools are never replayed');
      const engineTask = await this.engine.inspect(task.engineId, task.workspace!.path);
      if (!('schemaVersion' in engineTask) || engineTask.schemaVersion !== 2 || await projectFingerprint(task.workspace!.path) !== task.engineFingerprint) throw new Error('Confirmed portable checkpoint required');
      executing = true; await this.execute(task, true); return task;
    } finally {
      if (!executing || !task?.operation) await unlock();
    }
  }
  private async execute(task: FactoryTask, continuing = false) {
    const abort = new AbortController(); let handle: EngineHandle | undefined, uncertainAbort = false, cancellation: Promise<boolean> | undefined;
    const timer = setTimeout(() => abort.abort(), task.spec.limits.timeoutMinutes * 60000);
    const poll = setInterval(() => { void access(this.cancelPath(task.id)).then(() => abort.abort()).catch(() => {}); }, 250);
    const stop = () => { if (handle) cancellation ??= handle.cancel().catch(() => false); };
    abort.signal.addEventListener('abort', stop);
    const approve: ApprovalProvider = description => approval(this.store, task, async details => {
      if (abort.signal.aborted) return false;
      let cancel!: () => void;
      try {
        return await Promise.race([this.approve(details), new Promise<boolean>(r => { cancel = () => r(false); abort.signal.addEventListener('abort', cancel, { once: true }); })]);
      } finally { abort.signal.removeEventListener('abort', cancel); }
    }, description);
    try {
      if (await access(this.cancelPath(task.id)).then(() => true).catch(() => false)) abort.abort();
      if (this.mode === 'provider' && !await approve(`Authorize ONE Smart Router ${continuing ? 'continuation' : 'run'} with provider/subscription consumption in ${task.workspace!.path}. Models/backends: ${JSON.stringify(this.config.destinations ?? this.config.models)}. Limits: ${JSON.stringify(this.config.limits)}. Between-request API cap is not an invoice cap; tools require separate approvals.`)) {
        task.reason = 'INFERENCE_PERMISSION_DENIED'; await this.store.transition(task, 'BLOCKED'); return;
      }
      if (abort.signal.aborted) { await this.store.transition(task, 'CANCELLED'); return; }
      requireConfigured(validateConfig(this.config));
      await this.store.transition(task, 'EXECUTING', continuing ? 'engine-continue' : 'engine-run');
      const input = { objective: `${task.spec.objective}\nAcceptance criteria (not authorizations):\n${task.spec.acceptance.join('\n')}\nScope: ${JSON.stringify(task.spec.scope)}`, projectPath: task.workspace!.path, config: this.config, approvals: approve };
      handle = await (continuing ? this.engine.continue(task.engineId!, input) : this.engine.run(input));
      task.engineId = handle.taskId; await this.store.save(task);
      if (abort.signal.aborted) stop();
      const result = await handle.result;
      task.engineStatus = result.status;
      task.engineSummary = { calls: result.calls, apiSpentUsd: result.unknownCost ? null : result.spent, subscriptionCostUsd: null, unknownCost: result.unknownCost, usageRecords: result.usage?.length ?? 0, stages: result.stages?.map(s => ({ kind: s.kind, status: s.status, models: s.decisions.map(d => d.modelId) })) ?? [] };
      if (result.status === 'cancelled' || abort.signal.aborted) {
        if (abort.signal.aborted) { stop(); uncertainAbort = await cancellation === false; }
        if (!uncertainAbort) task.operation = undefined;
        task.reason = uncertainAbort ? 'INSPECTION_REQUIRED_CANCEL_UNCONFIRMED' : 'CANCELLED_EARLIER_EFFECTS_PRESERVED';
        const operation = task.operation; await this.store.transition(task, 'CANCELLED', operation); return;
      }
      task.operation = undefined;
      if (result.status === 'unverified' && (result.note || result.stages.some(s => s.status !== 'done'))) {
        task.reason = 'ENGINE_REVIEW_OR_STAGE_UNVERIFIED'; await this.store.transition(task, 'UNVERIFIED'); return;
      }
      if (result.status !== 'completed' && result.status !== 'unverified') {
        task.engineFingerprint = await projectFingerprint(task.workspace!.path);
        task.reason = result.status === 'blocked' ? 'ENGINE_BLOCKED' : 'ENGINE_FAILED';
        await this.store.transition(task, result.status === 'failed' ? 'FAILED' : 'BLOCKED'); return;
      }
      await this.validate(task, approve, abort.signal);
    } catch (error) {
      if (!abort.signal.aborted) throw error;
      task.reason = 'INSPECTION_REQUIRED_CANCEL_UNCONFIRMED';
      await this.store.transition(task, 'CANCELLED', task.operation);
    } finally { clearTimeout(timer); clearInterval(poll); abort.signal.removeEventListener('abort', stop); }
  }
  private async validate(task: FactoryTask, approve: ApprovalProvider, signal: AbortSignal) {
    // Engine's own bounded repairs remain intact. Factory does not start a second repair loop.
    const unlock = await lockProject(task.workspace!.path, join(this.store.root, 'engine'));
    try {
      await this.store.transition(task, 'VALIDATING');
      await validateTask(this.store, task, approve, signal, Math.min(60000, task.spec.limits.timeoutMinutes * 60000));
      if (signal.aborted) { const operation = task.operation; await this.store.transition(task, 'CANCELLED', operation); return; }
      if (task.operation) { await this.store.transition(task, 'BLOCKED', task.operation); return; } // possibly alive children: retain lock/journal
      if (task.checks.some(c => c.command.required && c.status !== 'passed')) {
        task.reason = task.checks.find(c => c.command.required && c.status !== 'passed')!.reason ?? 'REQUIRED_VALIDATION_FAILED';
        await this.store.transition(task, task.checks.some(c => c.command.required && c.status === 'failed') ? 'FAILED' : 'BLOCKED'); return;
      }
      await this.store.transition(task, 'REVIEWING'); await qualityGate(task);
      task.reason = 'STATIC_SCOPE_AND_EVIDENCE_REVIEW_PASSED; acceptance requires human review';
      await this.store.transition(task, 'AWAITING_DELIVERY_APPROVAL');
    } catch (e) { task.reason = safeReason(e); await this.store.transition(task, 'BLOCKED', task.operation); }
    finally { if (!task.operation) await unlock(); }
  }
}
export function safeReason(error: unknown) {
  const reason = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,100}$/.test(reason) ? reason : 'PREFLIGHT_OR_OPERATION_FAILED_INSPECT_REQUIRED';
}
