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
  if (tiers.some(t => /[<>]/.test(c.models[t]))) throw new Error('Configure models.fast/balanced/deep: placeholders cannot make requests. Use smart --init.');
}
