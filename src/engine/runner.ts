import { realpath } from 'node:fs/promises';
import { Controller } from '../controller.js';
import { ContinuityController } from '../continuity.js';
import { Store } from '../state.js';
import { requireConfigured, validateConfig } from '../config.js';
import type { Backend, Config, Destination, Task } from '../types.js';
import { createBackend, denyApproval, type ApprovalProvider } from './backend-factory.js';

export interface EngineEvent {
  taskId: string; timestamp: string;
  type: 'task' | 'stage' | 'routing' | 'approval-requested' | 'approval-granted' | 'approval-denied' | 'result';
  status?: Task['status']; stage?: string; stageStatus?: Task['stages'][number]['status']; tier?: string;
}
export interface EngineInput {
  objective: string; context?: string; projectPath: string; config: Config; approvals?: ApprovalProvider;
  onEvent?: (event: EngineEvent) => void;
}
export interface EngineHandle { taskId: string; result: Promise<Task>; cancel(): Promise<boolean> }
export interface ExecutionEngine {
  run(input: EngineInput): Promise<EngineHandle>;
  inspect(id: string, project: string): Promise<Task>;
  continue(id: string, input: EngineInput): Promise<EngineHandle>;
}
export type EngineBackendFactory = (destination: Destination, project: string, approvals: ApprovalProvider) => Promise<Backend>;

/** No parsing of CLI text; controllers remain responsible for routing and safety. */
export class SmartEngine implements ExecutionEngine {
  constructor(readonly store = new Store(), readonly backendFactory: EngineBackendFactory = createBackend) {}
  async inspect(id: string, project: string) {
    const task = await this.store.get(id);
    if (task.projectPath !== await realpath(project)) throw new Error('Task does not belong to project');
    return task;
  }
  run(input: EngineInput) { return this.start(input); }
  async continue(id: string, input: EngineInput) {
    const task = await this.inspect(id, input.projectPath);
    if (!('schemaVersion' in task) || task.schemaVersion !== 2 || !input.config.destinations) throw new Error('Legacy tasks require inspection; portable continuation unavailable');
    return this.start(input, id);
  }
  private async start(input: EngineInput, continuing?: string): Promise<EngineHandle> {
    const project = await realpath(input.projectPath), config = structuredClone(validateConfig(input.config));
    requireConfigured(config);
    let taskId = continuing ?? '', ready!: (id: string) => void;
    const started = new Promise<string>(r => { ready = r; });
    const emit = (event: Omit<EngineEvent, 'taskId' | 'timestamp'>) => {
      // Observer failures cannot change execution or authorization.
      try { input.onEvent?.({ ...event, taskId, timestamp: new Date().toISOString() }); } catch { /* observer only */ }
    };
    const approve: ApprovalProvider = async description => {
      emit({ type: 'approval-requested' });
      let granted = false;
      try { granted = await (input.approvals ?? denyApproval)(description) === true; } catch { /* fail closed */ }
      emit({ type: granted ? 'approval-granted' : 'approval-denied' }); return granted;
    };
    const parent = this.store;
    const seen = new Set<string>();
    const store = new class extends Store {
      override async save(task: Task) {
        await parent.save(task); taskId = task.id; ready(taskId);
        emit({ type: 'task', status: task.status });
        for (const stage of task.stages) {
          const key = `${stage.id}:${stage.status}`;
          if (!seen.has(key)) { seen.add(key); emit({ type: 'stage', stage: stage.kind, stageStatus: stage.status }); }
          for (const decision of stage.decisions) if (!seen.has(decision.timestamp + stage.id)) {
            seen.add(decision.timestamp + stage.id); emit({ type: 'routing', stage: stage.kind, tier: decision.tier });
          }
        }
      }
    }(parent.root, parent.lockRoot);
    let backend: Backend | undefined;
    const controller = config.destinations
      ? new ContinuityController(d => this.backendFactory(d, project, approve), config, store, () => {})
      : new Controller(backend = await this.backendFactory({ id: 'opencode', backend: 'opencode', billing: 'api', models: config.models }, project, approve), config, store, () => {});
    const result = (continuing && controller instanceof ContinuityController ? controller.continue(continuing, project) : controller.run(input.objective, project, input.context))
      .then(task => { emit({ type: 'result', status: task.status }); return task; })
      .finally(async () => { if (controller instanceof ContinuityController) await controller.close(); await backend?.close(); });
    taskId = await Promise.race([started, result.then(task => task.id)]);
    return { taskId, result, cancel: () => controller.cancel() };
  }
}
