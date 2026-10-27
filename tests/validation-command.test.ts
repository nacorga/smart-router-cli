import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeTools } from '../src/native-tools.js';
import { validateCommand } from '../src/validation-command.js';
import { validateCommand as validateFactoryCommand, TaskSpecError } from '../src/factory/task-spec.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'smart-command-contract-')); roots.push(root);
  await writeFile(join(root, 'test.mjs'), "import {appendFileSync} from 'node:fs'; import assert from 'node:assert/strict'; appendFileSync('executions.txt', 'run\\n'); assert.equal(2+3,5);\n");
  return root;
}
it.each(['node --test test.mjs', 'node --test', 'npm test', 'npm run test:unit', 'npm run check', 'pnpm test', 'yarn typecheck', 'pytest tests/check.py', 'cargo test', 'go test ./pkg'])('uses the same direct-check policy for both consumers: %s', command => {
  const [executable, ...args] = command.split(' '); const input = { executable, args, required: true };
  expect(validateCommand(input)).toEqual(validateFactoryCommand(input));
});
it.each([
  'node script.mjs', 'node --eval evil', 'node -e evil', 'node --test --require hook.mjs',
  'node --test --import hook.mjs', 'node --test ../outside.mjs', 'node --test /tmp/outside.mjs',
  'node --test .env', 'node --test config.env.backup', 'node --test test.mjs;echo',
  'node --test test.mjs && npm test', 'node --test $(echo)', 'node --test `echo`',
  'node --test test.mjs > output.txt', 'node --test\ntest.mjs', 'node --test test.mjs\n', 'node --test test.mjs\r\n', 'node  --test test.mjs',
  '/usr/bin/node --test test.mjs', 'npm install', 'npm run deploy', 'npm test -- test.mjs',
  'git diff', 'sh -c npm', 'npx node --test test.mjs',
])('rejects unsupported commands before asking the host: %s', async command => {
  const [executable, ...args] = command.split(' '); const input = { executable, args, required: true };
  expect(() => validateCommand(input)).toThrow(); expect(() => validateFactoryCommand(input)).toThrow(TaskSpecError);
  const approve = vi.fn(async () => true);
  const broker = new NativeTools(await project(), 'validate', approve, new AbortController().signal);
  expect(await broker.call('run_command', { command })).toMatchObject({ isError: true });
  expect(approve).not.toHaveBeenCalled(); expect(broker.events).toEqual([]); expect(broker.evidence).toEqual([]);
});
it('executes the previously rejected node check once after exact approval, with actual exit evidence', async () => {
  const root = await project(); const approve = vi.fn(async () => true);
  const broker = new NativeTools(root, 'validate', approve, new AbortController().signal);
  const result = await broker.call('run_command', { command: 'node --test test.mjs' });
  expect(result).not.toHaveProperty('isError'); expect(JSON.parse(result.content[0]!.text)).toMatchObject({ exit: 0 });
  expect(approve).toHaveBeenCalledTimes(1); expect(approve.mock.calls[0]![0]).toContain('bash: node --test test.mjs\n');
  expect(broker.events[0]).toMatchObject({ kind: 'command', status: 'completed', exitCode: 0 });
  expect(broker.evidence).toHaveLength(1); expect(broker.evidence[0]).toMatch(/:passed$/);
  expect(await readFile(join(root, 'executions.txt'), 'utf8')).toBe('run\n');
});
it.each(['explore', 'plan', 'review'] as const)('does not authorize node checks in read-only stage %s', async stage => {
  const approve = vi.fn(async () => true);
  const broker = new NativeTools(await project(), stage, approve, new AbortController().signal);
  expect(await broker.call('run_command', { command: 'node --test test.mjs' })).toMatchObject({ isError: true });
  expect(approve).not.toHaveBeenCalled();
});
it('does not execute a valid node check when approval is denied', async () => {
  const root = await project(); const broker = new NativeTools(root, 'validate', async () => false, new AbortController().signal);
  expect(await broker.call('run_command', { command: 'node --test test.mjs' })).toMatchObject({ isError: true });
  await expect(readFile(join(root, 'executions.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(broker.evidence).toEqual([]);
});
it('ignores a late approval after cancellation of a valid node check', async () => {
  const root = await project(); const abort = new AbortController(); let answer!: (value: boolean) => void, entered!: () => void;
  const shown = new Promise<void>(r => { entered = r; });
  const broker = new NativeTools(root, 'validate', async () => { entered(); return new Promise<boolean>(r => { answer = r; }); }, abort.signal);
  const pending = broker.call('run_command', { command: 'node --test test.mjs' });
  await shown; abort.abort(); expect(await pending).toMatchObject({ isError: true });
  answer(true); await new Promise(r => setImmediate(r));
  await expect(readFile(join(root, 'executions.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(broker.evidence).toEqual([]);
});
