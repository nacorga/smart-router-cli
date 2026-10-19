import { loadLocalEnv } from './env.js';
import { randomBytes } from 'node:crypto';
import { loadConfig, requireConfigured } from './config.js';
import { OpenCodeBackend } from './opencode.js';
import { projectRoot, lockProject } from './state.js';
async function main() {
  if(!process.argv.includes('--run')){console.log('Paid model-continuity test. Pass --run to use configured models and budget.');return;}
  const project = await projectRoot(process.cwd()); await loadLocalEnv(project); const c = await loadConfig(project); requireConfigured(c);
  if (!process.env.OPENROUTER_API_KEY) throw new Error('Configure OPENROUTER_API_KEY locally.');
  if (c.models.fast === c.models.deep) throw new Error('The continuity test requires two distinct models');
  const unlock = await lockProject(project); let backend: OpenCodeBackend | undefined;
  try {
    backend = await OpenCodeBackend.start(project, async () => false);
    const catalog = await backend.catalog();
    for (const id of Object.values(c.models)) if (!catalog.some(m => m.id === id && m.tools && m.context >= c.minContext)) throw new Error(`Ineligible model: ${id}`);
    const session = await backend.create(); let spent = 0;
    const marker = randomBytes(16).toString('hex');
    const first = await backend.prompt(session, c.models.fast, `Remember this marker for the next message: ${marker}. Reply only ACK. Do not use tools.`, 'explore', console.log);
    if (first.failure || first.usage.some(u => u.costUsd === undefined)) throw new Error('First request failed or cost unavailable');
    spent += first.usage.reduce((n, u) => n + (u.costUsd ?? 0), 0);
    if (spent >= c.limits.maxCostUsd || c.limits.maxModelCalls < 2) throw new Error('Limit reached before the second request');
    const second = await backend.prompt(session, c.models.deep, 'Return ONLY the exact marker from my previous message. Do not use tools.', 'explore', console.log);
    if (second.failure || !second.text.includes(marker)) throw new Error('Model continuity not demonstrated');
    console.log(JSON.stringify({ session, continuity: true, models: [c.models.fast, c.models.deep], usage: [...first.usage, ...second.usage], note: 'Real inference; costs reported by backend. Marker is not recorded.' }, null, 2));
  } finally { await backend?.close(); await unlock(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
