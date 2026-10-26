import { it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { prepareFactoryPilot } from '../src/factory-pilot-preparation.js';
import { parseTaskSpec } from '../src/factory/task-spec.js';
it('prepares a failing reproducible pilot and explicit approvals without starting an engine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-pilot-test-'));
  try {
    const output = join(root, 'pilot'); const prepared = await prepareFactoryPilot(output, 'codex', 'explicit-fixture-model', 'trusted-native-cli');
    expect(prepared).toMatchObject({ status: 'PREPARED_NOT_RUN', baselineExitCode: 1, providerRequests: 0 });
    const spec = parseTaskSpec(JSON.parse(await readFile(prepared.spec, 'utf8')));
    expect(spec.delivery.draftPR).toBe(false); expect(spec.scope.allowedPaths).toEqual(['index.mjs']);
    const config = JSON.parse(await readFile(prepared.config, 'utf8')); expect(config.limits).toMatchObject({ maxCostUsd: 0, maxModelCalls: 3, repairAttemptsBeforeEscalation: 0 });
    expect((await stat(prepared.config)).mode & 0o777).toBe(0o600);
    await expect(prepareFactoryPilot(output, 'codex', 'model', 'trusted')).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);
