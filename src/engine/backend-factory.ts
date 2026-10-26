import { loadLocalEnv } from '../env.js';
import { OpenCodeBackend } from '../opencode.js';
import { CodexBackend, ClaudeBackend } from '../native-backends.js';
import type { Backend, Destination } from '../types.js';

/** Supplied by the trusted host, never by a task or model. */
export type ApprovalProvider = (description: string) => Promise<boolean>;
export const denyApproval: ApprovalProvider = async () => false;
export async function createBackend(d: Destination, project: string, approve: ApprovalProvider = denyApproval): Promise<Backend> {
  if (d.backend === 'codex') return new CodexBackend(d, project, approve);
  if (d.backend === 'claude') return new ClaudeBackend(d, project, approve);
  await loadLocalEnv(project);
  if (!process.env.OPENROUTER_API_KEY) throw Object.assign(new Error('Missing OPENROUTER_API_KEY for explicitly configured API destination'), { code: 'SMART_AUTH_REQUIRED' });
  const backend = await OpenCodeBackend.start(project, approve);
  backend.identity = d.id; backend.billing = 'api'; return backend;
}
