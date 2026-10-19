import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tiers, type Config } from './types.js';
export const defaults: Config = {
  mode: 'auto', provider: 'openrouter',
  models: { fast: '<FAST_MODEL_ID>', balanced: '<BALANCED_MODEL_ID>', deep: '<DEEP_MODEL_ID>' },
  limits: { maxCostUsd: 2, maxModelCalls: 16, maxEscalationsPerStage: 1, repairAttemptsBeforeEscalation: 1, maxInfrastructureRetries: 1 }, minContext: 16000,
};
export function validateConfig(raw: unknown): Config {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid configuration');
  const c = raw as Config;
  validateDestinations(c);
  if (!['auto', 'manual'].includes(c.mode) || typeof c.provider !== 'string' || !c.provider.trim()) throw new Error('Invalid mode/provider');
  for (const t of tiers) {
    if (typeof c.models?.[t] !== 'string' || !c.models[t].trim()) throw new Error(`Missing models.${t}`);
    if (c.fallbacks?.[t] !== undefined && (typeof c.fallbacks[t] !== 'string' || !c.fallbacks[t]?.trim())) throw new Error(`fallbacks.${t} invalid`);
  }
  for (const k of Object.keys(defaults.limits) as (keyof Config['limits'])[]) {
    const n = c.limits?.[k];
    if (!Number.isFinite(n) || n < 0 || (k !== 'maxCostUsd' && !Number.isInteger(n))) throw new Error(`limits.${k} invalid`);
  }
  if (!Number.isInteger(c.minContext) || c.minContext < 1) throw new Error('Invalid minContext');
  return c;
}
export async function loadConfig(project: string, explicit?: string): Promise<Config> {
  let c = structuredClone(defaults);
  for (const path of explicit ? [explicit] : [join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'smart-router/config.json'), join(project, 'smart-router.config.json')]) {
    let raw: string;
    try { raw = await readFile(path, 'utf8'); } catch (e) { if (!explicit && (e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    const parsed = JSON.parse(raw);
    c = { ...c, ...parsed, models: { ...c.models, ...parsed.models }, limits: { ...c.limits, ...parsed.limits } };
  }
  return validateConfig(c);
}
export function requireConfigured(c: Config) {
  if (c.destinations) { for (const d of c.destinations) if (tiers.some(t => /[<>]/.test(d.models[t]))) throw new Error('Configure explicit destination models before inference'); return; }
  if (tiers.some(t => /[<>]/.test(c.models[t]))) throw new Error('Configure models.fast/balanced/deep: placeholders cannot make requests. Use smart --init.');
}

function validateDestinations(c: Config) {
  if (c.schemaVersion !== undefined && c.schemaVersion !== 2) throw new Error('Unsupported configuration version');
  if (c.destinations === undefined) { if (c.schemaVersion === 2) throw new Error('Version 2 requires destinations'); return; }
  if (c.schemaVersion !== 2 || !Array.isArray(c.destinations) || !c.destinations.length) throw new Error('Version 2 requires a nonempty destination chain');
  const ids = new Set<string>();
  for (const d of c.destinations) {
    if (!d || !/^[a-z][a-z0-9-]{0,63}$/.test(d.id) || ids.has(d.id)) throw new Error('Invalid or duplicate destination ID');
    ids.add(d.id);
    if (!['codex', 'claude', 'opencode'].includes(d.backend) || d.billing !== (d.backend === 'opencode' ? 'api' : 'subscription')) throw new Error('Invalid backend/billing combination');
    for (const t of tiers) if (typeof d.models?.[t] !== 'string' || !d.models[t].trim()) throw new Error('Missing destination model');
    if (d.executable !== undefined && (typeof d.executable !== 'string' || !d.executable.trim())) throw new Error('Invalid executable');
  }
}
export function subscriptionTemplate(): Config {
  return { ...structuredClone(defaults), schemaVersion: 2, destinations: ['codex', 'claude'].map(backend => ({
    id: backend, backend: backend as 'codex' | 'claude', billing: 'subscription',
    models: { fast: '<FAST_MODEL_ID>', balanced: '<BALANCED_MODEL_ID>', deep: '<DEEP_MODEL_ID>' },
  })) };
}
