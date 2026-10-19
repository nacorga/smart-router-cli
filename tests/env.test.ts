import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadLocalEnv } from '../src/env.js';

let directory: string;
let original: string | undefined;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'smart-env-'));
  original = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
});
afterEach(async () => {
  if (original === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = original;
  await rm(directory, { recursive: true, force: true });
});
it('loads quoted provider credentials without importing unrelated variables', async () => {
  await writeFile(join(directory, '.env'), 'OPENROUTER_API_KEY="dummy-test-key" # comment\nSMART_ENV_TEST_UNRELATED=ignored\n');
  await loadLocalEnv(directory);
  expect(process.env.OPENROUTER_API_KEY).toBe('dummy-test-key');
  expect(process.env.SMART_ENV_TEST_UNRELATED).toBeUndefined();
});
it('preserves credentials already set in the shell', async () => {
  process.env.OPENROUTER_API_KEY = 'dummy-shell-key';
  await writeFile(join(directory, '.env'), 'OPENROUTER_API_KEY=dummy-file-key\n');
  await loadLocalEnv(directory);
  expect(process.env.OPENROUTER_API_KEY).toBe('dummy-shell-key');
});
it('allows projects without an env file', async () => {
  await expect(loadLocalEnv(directory)).resolves.toBeUndefined();
  expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
});
