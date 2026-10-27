import { it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './factory-helpers.js';
import { runValidation } from '../src/factory/validation.js';
it('isolates environment, records exit codes, bounds time/output and confirms child termination', async () => {
  const f = await fixture();
  try {
    const c = { executable: 'node', args: ['--test', 'isolation.mjs'], required: true };
    process.env.FACTORY_TEST_SECRET = 'MUST_NOT_INHERIT';
    await writeFile(join(f.repo, 'isolation.mjs'), "import assert from 'node:assert/strict'; assert.equal(process.env.FACTORY_TEST_SECRET, undefined); assert.notEqual(process.env.HOME, process.env.ORIGINAL_HOME);\n");
    expect(await runValidation(c, f.repo, f.store.root, new AbortController().signal)).toMatchObject({ exitCode: 0, terminated: true, reason: undefined });
    await writeFile(join(f.repo, 'isolation.mjs'), 'setInterval(() => {}, 1000);\n');
    expect(await runValidation(c, f.repo, f.store.root, new AbortController().signal, 100)).toMatchObject({ reason: 'TIMEOUT', terminated: true });
    const cancel = new AbortController(); setTimeout(() => cancel.abort(), 100);
    expect(await runValidation(c, f.repo, f.store.root, cancel.signal)).toMatchObject({ reason: 'CANCELLED', terminated: true });
    await writeFile(join(f.repo, 'isolation.mjs'), "process.stdout.write('x'.repeat(2 * 1024 * 1024));\n");
    expect((await runValidation(c, f.repo, f.store.root, new AbortController().signal)).reason).toBe('OUTPUT_LIMIT');
    await expect(runValidation({ executable: 'sh', args: ['-c', 'evil'], required: true }, f.repo, f.store.root, new AbortController().signal)).rejects.toThrow();
  } finally { delete process.env.FACTORY_TEST_SECRET; await f.cleanup(); }
});
