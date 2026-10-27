import { secretPath } from './continuity-state.js';

export interface ValidationCommand { executable: string; args: string[]; required: boolean }

/** Shared allowlist for native tools and independent checks. Never parses a shell. */
export function validateCommand(value: unknown): ValidationCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid validation command');
  const c = value as Record<string, any>;
  const keys = ['executable', 'args', 'required'];
  if (Object.keys(c).some(k => !keys.includes(k)) || keys.some(k => !(k in c))) throw new Error('Invalid validation command');
  if (!['node', 'npm', 'pnpm', 'yarn', 'pytest', 'cargo', 'go'].includes(c.executable) || !Array.isArray(c.args) || c.args.length > 20 || c.args.some((a: unknown) => typeof a !== 'string' || a.length < 1 || a.length > 200 || /[^A-Za-z0-9_./:=@-]/.test(a) || a.includes('..') || a.startsWith('/') || secretPath(a)) || typeof c.required !== 'boolean') throw new Error('Invalid validation command');
  const args = c.args as string[];
  const ok = c.executable === 'node' ? args[0] === '--test' && args.slice(1).every(a => !a.startsWith('-'))
    : c.executable === 'npm' ? (args.length === 1 && args[0] === 'test') || (args.length === 2 && args[0] === 'run' && /^(test(?::[A-Za-z0-9_-]+)?|check|lint|type-?check)$/.test(args[1]!))
    : ['pnpm', 'yarn'].includes(c.executable) ? args.length === 1 && ['test', 'lint', 'typecheck'].includes(args[0]!)
    : c.executable === 'pytest' ? args.every(a => !a.startsWith('-')) : args[0] === 'test' && args.slice(1).every(a => !a.startsWith('-'));
  if (!ok) throw new Error('Only direct validation commands are supported');
  return structuredClone(c) as ValidationCommand;
}
