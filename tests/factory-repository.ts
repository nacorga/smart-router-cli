import { mkdtemp, writeFile, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/factory/workspace.js';
import type { TaskSpec } from '../src/factory/task-spec.js';
export async function repositoryFixture(id = 'fixture-task') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'factory-test-'))), repo = join(root, 'repo'); await mkdir(repo);
  await git(repo, ['init', '--initial-branch=main']);
  await git(repo, ['config', 'user.name', 'Fixture']); await git(repo, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(repo, 'index.mjs'), 'export const sum = (a, b) => 0;\n');
  await writeFile(join(repo, 'test.mjs'), "import {sum} from './index.mjs'; import assert from 'node:assert/strict'; assert.equal(sum(2,3),5);\n");
  await writeFile(join(repo, '.env'), 'PRIVATE_FIXTURE_SECRET');
  await git(repo, ['add', '--', 'index.mjs', 'test.mjs', '.env']); await git(repo, ['commit', '-m', 'fixture base']);
  await writeFile(join(repo, 'user.txt'), 'PREVIOUS_USER_CHANGE');
  const stateRoot = join(root, 'state'); await mkdir(stateRoot, { mode: 0o700 });
  const spec: TaskSpec = { version: 1, id, title: 'Fix sum', objective: 'Implement sum', repository: { path: repo, baseRef: 'main' }, scope: { allowedPaths: ['index.mjs', 'src/**'], protectedPaths: ['test.mjs', '.env*'] }, acceptance: ['sum adds operands'], validation: { commands: [{ executable: 'node', args: ['--test', 'test.mjs'], required: true }] }, limits: { maxRepairAttempts: 0, timeoutMinutes: 1 }, delivery: { draftPR: false, requireHumanApproval: true } };
  return { root, repo, stateRoot, spec, cleanup: () => rm(root, { recursive: true, force: true }) };
}
