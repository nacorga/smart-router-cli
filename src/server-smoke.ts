import {mkdtemp,mkdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { OpenCodeBackend } from './opencode.js';
async function main() {
  const fixture=await realpath(await mkdtemp(join(tmpdir(),'smart-server-smoke-')));
  for(const name of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME']){const path=join(fixture,name.toLowerCase());await mkdir(path);process.env[name]=path;}
  delete process.env.OPENROUTER_API_KEY;
  const backend = await OpenCodeBackend.start(fixture, async () => false);
  try {
    const id = await backend.create();
    const aborted = await backend.abort(id);
    console.log(JSON.stringify({ server: 'opencode-ai@1.19.3', sdk: '@opencode-ai/sdk@1.19.3', sessionCreated: !!id, abortConfirmed: aborted, llmCalls: 0 }));
    if (!aborted) process.exitCode = 1;
  } finally { await backend.close(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
