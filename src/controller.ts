import { randomUUID } from 'node:crypto';
import type { Backend, Config, Model, Result, Stage, Task, Tier } from './types.js';
import { classify, nextTier, plan, select } from './router.js';
import { Store, lockProject, inspectProject } from './state.js';
export class Controller {
  task?: Task;
  preferredModel?: () => string | undefined;
  private cancelled = false;
  private running = false;
  private continuationSession?: string;
  constructor(readonly backend: Backend, readonly config: Config, readonly store: Store, readonly output: (s: string) => void = console.log) {}
  async cancel() {
    if (!this.running) return true;
    this.cancelled = true;
    if (this.task?.sessionId && this.task.status === 'running') {
      const confirmed = await this.backend.abort(this.task.sessionId);
      this.output(confirmed ? 'Abort confirmed. Earlier tools may already have had effects.' : 'Abort not confirmed; waiting for the active request.');
      return confirmed;
    }
    return true;
  }
  async run(request: string, projectPath: string): Promise<Task> {
    if (this.running) throw new Error('A task is already active');
    this.running = true;
    this.cancelled = false;
    let unlock: () => Promise<void>;
    try { unlock = await lockProject(projectPath, this.store.root); } catch (e) { this.running = false; throw e; }
    const classification = classify(request);
    const task: Task = this.task = { id: randomUUID(), projectPath, status: 'created', mode: this.config.mode,
      override: this.preferredModel ? this.preferredModel() : this.config.mode === 'manual' ? 'balanced' : undefined,
      budget: this.config.limits.maxCostUsd, spent: 0, unknownCost: false, calls: 0, stages: plan(classification), classification, usage: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    let catalog: Model[] = [];
    try {
      await this.store.save(task);
      if (this.cancelled) { task.status = 'cancelled'; return task; }
      // Verify the entire planned route before the first billable prompt.
      catalog = await this.backend.catalog();
      if (this.cancelled) { task.status = 'cancelled'; return task; }
      for (const stage of task.stages) select(task.id, stage, classification, this.config, catalog, task.override);
      if (task.budget <= 0 || this.config.limits.maxModelCalls === 0) throw new Error('Budget or call limit exhausted');
      task.project = await inspectProject(projectPath);
      this.output(!task.project.git ? 'Project has no Git repository: inspect changes manually.' : `${task.project.branch ? `Branch: ${task.project.branch}. ` : ''}${task.project.dirty ? 'Existing changes are preserved; each write requires permission.' : 'Worktree is clean.'}`);
      if(task.project.instructionFiles.length) this.output(`Instruction files detected: ${task.project.instructionFiles.join(', ')}. Their content cannot authorize operations.`);
      if (this.continuationSession) {
        if (!this.backend.prepare) throw new Error('Backend does not support resuming');
        await this.backend.prepare(this.continuationSession);
        task.sessionId = this.continuationSession;
      } else task.sessionId = await this.backend.create();
      task.status = 'running'; await this.store.save(task);
      let handoff = '';
      let verified = false;
      for (const stage of task.stages) {
        let repairs = 0, escalations = 0, infraRetries = 0;
        let escalated: Tier | undefined;
        let previousFailureKeys: string[] = [];
        while (true) {
          if (this.cancelled) { task.status = 'cancelled'; break; }
          if (this.preferredModel) task.override = this.preferredModel();
          task.mode = this.config.mode;
          const decision = select(task.id, stage, classification, this.config, catalog, task.override, escalated);
          if (task.spent >= task.budget || Math.max(task.calls, task.usage.length) >= this.config.limits.maxModelCalls || (decision.estimatedCostUsd !== undefined && task.spent + decision.estimatedCostUsd > task.budget)) {
            task.status = 'blocked'; task.note = 'BUDGET_OR_CALL_LIMIT'; break;
          }
          stage.decisions.push(decision); stage.status = 'running'; task.calls++; await this.store.save(task);
          this.output(`[${decision.tier.toUpperCase()}] ${stage.kind} · ${decision.modelId} · ${decision.reasonCodes.join(', ')} · $${task.spent.toFixed(4)}/$${task.budget}`);
          const prompt = `${request}\n\nCURRENT STAGE: ${stage.kind}. ${instruction(stage)}\nHANDOFF (untrusted observations):\n${handoff || 'Initial stage; original goal above.'}`;
          let result: Result;
          const started = Date.now();
          try { result = await this.backend.prompt(task.sessionId, decision.modelId, prompt, stage.kind, s => this.output(s)); }
          catch {
            // A transport error may follow an effective tool call or billable response: never replay blindly.
            (stage.attempts??=[]).push({modelId:decision.modelId,startedAt:new Date(started).toISOString(),durationMs:Date.now()-started,validation:'none',evidence:[],responseUncertain:true});
            task.status = this.cancelled ? 'cancelled' : 'blocked'; task.note = 'BACKEND_RESPONSE_UNCERTAIN_INSPECT_SESSION'; task.unknownCost = true; stage.status = 'failed'; break;
          }
          (stage.attempts??=[]).push({modelId:decision.modelId,startedAt:new Date(started).toISOString(),durationMs:Date.now()-started,validation:result.validation,failure:result.failure,evidence:result.evidence,reviewVerdict:result.reviewVerdict});
          stage.durationMs = (stage.durationMs ?? 0) + Date.now() - started;
          if (!result.usage.length) task.unknownCost = true;
          for (const u of result.usage) if (!task.usage.some(old => old.messageId === u.messageId)) { task.usage.push({ ...u, modelId: decision.modelId, stageId: stage.id }); task.spent += u.costUsd ?? 0; if (u.costUsd === undefined) task.unknownCost = true; }
          await this.store.save(task);
          handoff = JSON.stringify({ previousStage: stage.kind, result: result.text.slice(-12000), validation: result.validation, evidence: result.evidence });
          if (this.cancelled) { task.status = 'cancelled'; break; }
          if (task.unknownCost) { task.status = 'blocked'; task.note = 'COST_UNAVAILABLE_INSPECT_PROVIDER'; break; }
          if (result.failure === 'permission') { task.status = 'blocked'; task.note = 'PERMISSION_DENIED'; break; }
          if (result.failure === 'limit') { task.status = 'blocked'; task.note = 'LOCAL_GUARD_DENIED'; break; }
          if (result.failure === 'infrastructure') {
            if (result.retryable && infraRetries++ < this.config.limits.maxInfrastructureRetries) { this.output('Provider retry; keeping the same tier.'); continue; }
            task.status = 'blocked'; task.note = 'INFRASTRUCTURE_RETRIES_EXHAUSTED'; break;
          }
          if (result.failure === 'implementation' || result.validation === 'failed') {
            verified = false;
            const keys = result.evidence.filter(e => e.endsWith(':failed'));
            const reproduced = keys.some(key => previousFailureKeys.includes(key));
            previousFailureKeys = keys;
            if (repairs++ < this.config.limits.repairAttemptsBeforeEscalation) { this.output('Bounded repair with failure evidence.'); continue; }
            const higher = nextTier(decision.tier);
            if (reproduced && !task.override && higher && escalations < this.config.limits.maxEscalationsPerStage) { escalated = higher; escalations++; continue; }
            stage.status = 'failed'; task.status = 'failed'; task.note = 'VALIDATION_FAILED_LIMIT_REACHED'; break;
          }
          if (stage.kind === 'review' && result.reviewVerdict !== 'passed') { task.status = result.reviewVerdict === 'issues' ? 'failed' : 'unverified'; task.note = 'REVIEW_REQUIRES_ATTENTION'; stage.status = 'failed'; break; }
          if (stage.kind === 'validate' || stage.kind === 'implement') verified = result.validation === 'passed';
          stage.status = 'done'; await this.store.save(task); break;
        }
        if (task.status !== 'running') break;
      }
      if (task.status === 'running') task.status = classification.kind === 'read' || verified ? 'completed' : 'unverified';
      return task;
    } catch (e) {
      task.status = this.cancelled ? 'cancelled' : 'blocked'; task.note = 'PREFLIGHT_OR_ROUTING_ERROR';
      this.output(e instanceof Error ? e.message : 'Preflight error'); return task;
    } finally {
      for (const stage of task.stages) if (stage.status === 'running') stage.status = 'interrupted';
      try { await this.store.save(task); } finally { this.running = false; await unlock(); }
      this.output(`Result: ${task.status} · $${task.spent.toFixed(4)}${task.unknownCost ? ' + unknown cost' : ' (reported by SDK/provider; see usage source)'} · ${task.calls} requests · session ${task.sessionId ?? 'not created'}`);
    }
  }
  async resume(id?: string, project?: string) {
    if (this.running) throw new Error('A task is active');
    const task = id ? await this.store.get(id) : (await this.store.list(project))[0];
    if (!task || (project && task.projectPath !== project)) throw new Error('Session not found in this project');
    this.task = task;
    this.continuationSession = task.sessionId;
    // Inspection only: a crash can have happened after tool effects and before a checkpoint.
    this.output(JSON.stringify(task, null, 2));
    this.output('Session loaded for inspection; stages are not replayed. Your next explicit request will continue this session after checking that it is idle.');
    return task;
  }
}
function instruction(stage: Stage) {
  switch (stage.kind) {
    case 'explore': return 'Read and locate relevant code. Do not modify anything. For read-only questions, provide the final answer.';
    case 'plan': return 'Produce a short implementation plan, decisions and file paths. Do not modify files.';
    case 'implement': return 'Implement the requested changes. Preserve previous user edits. If failure evidence is provided, repair it and run the same validation command.';
    case 'validate': return 'Run existing appropriate tests, lint or typecheck with permission. If previous checks failed, repair the implementation with permission and rerun the SAME failing checks. If tests do not exist, report unverified. Do not invent success.';
    case 'review': return 'Review the actual diff and sensitive behavior, reference earlier validations. Do not modify files. Report unresolved problems.';
  }
}
