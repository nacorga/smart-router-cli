#!/usr/bin/env node
/** Development harness only: prepare a fixed trusted fixture, never start a provider. */
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isMain } from './entrypoint.js';
import { defaults } from './config.js';
import { parseTaskSpec } from './factory/task-spec.js';
import { canonicalHostPath, git, noSymlinks, outside } from './factory/workspace.js';
const exec = promisify(execFile);
export async function prepareFactoryPilot(output: string, backend: string, model: string, executable: string) {
  if (!['codex', 'claude'].includes(backend) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(model) || !executable.trim() || /[\x00-\x1f]/.test(executable)) throw new Error('Explicit trusted backend/model/executable required');
  const root = canonicalHostPath(output), source = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  if (!outside(source, root)) throw new Error('Pilot output must be outside the source repository');
  await noSymlinks(dirname(root)); await mkdir(root, { mode: 0o700 });
  const repo = join(root, 'repository'); await mkdir(repo, { mode: 0o700 });
  const baseline = "export const parseLines = input => input.split('\\n');\n";
  const checks = "import {parseLines} from './index.mjs'; import assert from 'node:assert/strict';\nassert.deepEqual(parseLines(''), []);\nassert.deepEqual(parseLines('alpha\\r\\nbeta'), ['alpha','beta']);\nassert.deepEqual(parseLines('á\\n雪'), ['á','雪']);\nassert.deepEqual(parseLines(' spaced '), [' spaced ']);\n";
  await writeFile(join(repo, 'index.mjs'), baseline);
  await writeFile(join(repo, 'test.mjs'), checks);
  await writeFile(join(repo, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test test.mjs' } }));
  await git(repo, ['init', '--initial-branch=pilot-base']);
  await git(repo, ['config', 'user.name', 'Factory Pilot Fixture']); await git(repo, ['config', 'user.email', 'fixture@example.invalid']);
  await git(repo, ['add', '--', 'index.mjs', 'test.mjs', 'package.json']); await git(repo, ['commit', '-m', 'Fixed supervised pilot baseline']);
  let baselineExitCode: number | undefined;
  try { await exec(process.execPath, ['--test', 'test.mjs'], { cwd: repo, env: { PATH: process.env.PATH, HOME: root }, timeout: 10000 }); baselineExitCode = 0; }
  catch (e) { baselineExitCode = typeof (e as {code?: unknown}).code === 'number' ? (e as {code: number}).code : undefined; }
  if (baselineExitCode !== 1) throw new Error('Pilot baseline must fail its independent checks with exit 1');
  const config = structuredClone(defaults); config.models = { fast: model, balanced: model, deep: model };
  config.schemaVersion = 2; config.destinations = [{ id: backend, backend: backend as 'codex' | 'claude', billing: 'subscription', executable, models: config.models }];
  config.limits = { maxCostUsd: 0, maxModelCalls: 3, maxEscalationsPerStage: 0, repairAttemptsBeforeEscalation: 0, maxInfrastructureRetries: 0 };
  const spec = parseTaskSpec({ version: 1, id: 'supervised-parser', title: 'Handle empty and CRLF lines', objective: 'Fix parseLines to return an empty array for empty input and split CRLF lines while preserving Unicode and all spaces in nonempty lines.', repository: { path: repo, baseRef: 'pilot-base' }, scope: { allowedPaths: ['index.mjs'], protectedPaths: ['test.mjs', 'package.json', '.env*'] }, acceptance: ['Empty input returns []', 'CRLF separates lines without a trailing carriage return', 'Unicode and nonempty line spaces are preserved', 'Tests/package and original checkout remain unchanged'], validation: { commands: [{ executable: 'node', args: ['--test', 'test.mjs'], required: true }] }, limits: { maxRepairAttempts: 0, timeoutMinutes: 5 }, delivery: { draftPR: false, requireHumanApproval: true } });
  const save = (name: string, value: unknown) => writeFile(join(root, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await save('task.json', spec); await save('config.json', config);
  await save('preparation.json', { status: 'PREPARED_NOT_RUN', baselineExitCode, baseSha: (await git(repo, ['rev-parse', 'HEAD'])).trim(), providerRequests: 0, scope: ['index.mjs'], approvalsRequired: ['Explicit subscription pilot authorization before invoking --run', 'Each file write and command', 'Independent validation', 'Optional local commit'], subscriptionCostUsd: null });
  return { status: 'PREPARED_NOT_RUN', root, baselineExitCode, providerRequests: 0, spec: join(root, 'task.json'), config: join(root, 'config.json') };
}
async function main() {
  const args = process.argv.slice(2), values: Record<string, string> = {};
  if (!args.length) { console.log('PREPARED_NOT_RUN: use --output <new-private-directory> --backend codex|claude --model <explicit-id> --executable <trusted-cli>. Preparation performs no inference.'); return; }
  while (args.length) { const key = args.shift()!, value = args.shift(); if (!['--output', '--backend', '--model', '--executable'].includes(key) || !value || value.startsWith('--') || values[key]) throw new Error('Invalid preparation arguments'); values[key] = value; }
  if (Object.keys(values).length !== 4) throw new Error('All four preparation arguments are required');
  console.log(JSON.stringify(await prepareFactoryPilot(resolve(values['--output']!), values['--backend']!, values['--model']!, values['--executable']!), null, 2));
}
if (isMain(import.meta.url)) main().catch(() => { console.error('Pilot preparation failed; inspect retained private files. No inference was started.'); process.exitCode = 1; });
