import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const run = (args: string[]) => exec(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx/esm'), fileURLToPath(new URL('../src/continuity-pilot.ts', import.meta.url)), ...args]);
it('previews the real pilot without inference or implicit authorization', async () => {
  const { stdout } = await run([]); expect(JSON.parse(stdout)).toMatchObject({ status: 'NOT_RUN', realProviderInferenceRequests: 0 });
});
it.each([
  { reason: 'missing authorization', flags: ['--run'] },
  { reason: 'unknown scenario', flags: ['--run', '--allow-subscription-usage', '--scenario', 'unknown'] },
])('refuses $reason before native startup', async ({ flags }) => {
  await expect(run(flags)).rejects.toMatchObject({ code: 1 });
});
