import { validateCommand as validateDirectCommand, type ValidationCommand } from '../validation-command.js';
export type { ValidationCommand } from '../validation-command.js';
export class TaskSpecError extends Error {}
export interface TaskSpec {
  version: 1; id: string; title: string; objective: string;
  repository: { path: string; baseRef: string };
  scope: { allowedPaths: string[]; protectedPaths: string[] };
  acceptance: string[];
  validation: { commands: ValidationCommand[] };
  limits: { maxRepairAttempts: number; timeoutMinutes: number };
  delivery: { draftPR: boolean; requireHumanApproval: true };
}
function object(value: unknown, keys: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)) || keys.some(k => !(k in value))) throw new TaskSpecError('Invalid TaskSpec object or unknown fields');
}
function text(v: unknown, max = 10000): asserts v is string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\x00-\x08\x0b-\x1f\x7f]/.test(v)) throw new TaskSpecError('Invalid TaskSpec text');
}
export function safePattern(p: string) {
  if (!/^[A-Za-z0-9_.*?/-]+$/.test(p) || p.startsWith('/') || p.split('/').some(x => !x || x === '.' || x === '..') || p.includes('***')) throw new TaskSpecError('Invalid scope path');
  return p;
}
export function validRef(ref: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/.test(ref) || ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.split('/').some(x => x.startsWith('.') || x.endsWith('.') || x.endsWith('.lock'))) throw new TaskSpecError('Invalid local base ref');
  return ref;
}
export function validateCommand(c: unknown): ValidationCommand {
  try { return validateDirectCommand(c); }
  catch (error) { throw new TaskSpecError(error instanceof Error ? error.message : 'Invalid validation command'); }
}
export function parseTaskSpec(raw: unknown): TaskSpec {
  object(raw, ['version', 'id', 'title', 'objective', 'repository', 'scope', 'acceptance', 'validation', 'limits', 'delivery']);
  if (raw.version !== 1 || typeof raw.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(raw.id)) throw new TaskSpecError('Invalid TaskSpec version or ID');
  text(raw.title, 200); text(raw.objective);
  object(raw.repository, ['path', 'baseRef']); text(raw.repository.path, 4096); text(raw.repository.baseRef, 200); validRef(raw.repository.baseRef);
  object(raw.scope, ['allowedPaths', 'protectedPaths']);
  for (const key of ['allowedPaths', 'protectedPaths']) {
    if (!Array.isArray(raw.scope[key]) || raw.scope[key].length > 100) throw new TaskSpecError('Invalid scope');
    raw.scope[key].forEach((p: unknown) => { text(p, 200); safePattern(p); });
  }
  if (!raw.scope.allowedPaths.length) throw new TaskSpecError('Allowed paths are required');
  if (!Array.isArray(raw.acceptance) || !raw.acceptance.length || raw.acceptance.length > 50) throw new TaskSpecError('Acceptance criteria required');
  raw.acceptance.forEach((s: unknown) => text(s, 2000));
  object(raw.validation, ['commands']);
  if (!Array.isArray(raw.validation.commands) || !raw.validation.commands.length || raw.validation.commands.length > 10) throw new TaskSpecError('Independent validation required');
  raw.validation.commands.forEach(validateCommand);
  if (!raw.validation.commands.some((c: ValidationCommand) => c.required)) throw new TaskSpecError('A required validation command is needed');
  object(raw.limits, ['maxRepairAttempts', 'timeoutMinutes']);
  if (!Number.isInteger(raw.limits.maxRepairAttempts) || raw.limits.maxRepairAttempts < 0 || raw.limits.maxRepairAttempts > 2 || !Number.isInteger(raw.limits.timeoutMinutes) || raw.limits.timeoutMinutes < 1 || raw.limits.timeoutMinutes > 120) throw new TaskSpecError('Invalid task limits');
  object(raw.delivery, ['draftPR', 'requireHumanApproval']);
  if (typeof raw.delivery.draftPR !== 'boolean' || raw.delivery.requireHumanApproval !== true) throw new TaskSpecError('Human delivery approval is required');
  return structuredClone(raw) as TaskSpec;
}
export function matches(path: string, pattern: string) {
  const source = safePattern(pattern).split('/').map(part => part === '**' ? '.*' : part.split('').map(c => c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')).join('/');
  return new RegExp('^' + source + '$').test(path);
}
