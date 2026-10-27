import { createHash, randomUUID } from 'node:crypto';
import type { ApprovalProvider } from '../engine/index.js';
import type { FactoryStore, FactoryTask } from './state.js';
import { awaitApproval } from '../approval.js';
export const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
export async function approval(store: FactoryStore, task: FactoryTask, provider: ApprovalProvider, description: string, signal?: AbortSignal) {
  const operationId = randomUUID(), hash = digest(description);
  const event = (type: 'approval-requested' | 'approval-granted' | 'approval-denied') => task.events.push({ taskId: task.id, timestamp: new Date().toISOString(), type, operationId });
  event('approval-requested'); await store.save(task);
  const granted = await awaitApproval(provider, description, signal);
  event(granted ? 'approval-granted' : 'approval-denied'); task.approvals.push({ operationId, digest: hash, granted, ...(signal?.aborted ? { reason: 'ABORTED' as const } : {}) });
  await store.save(task); return granted;
}
