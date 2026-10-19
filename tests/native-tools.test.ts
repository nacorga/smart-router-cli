import { it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeTools } from '../src/native-tools.js';
import { claudeSettings, verifyClaudeTools } from '../src/claude-policy.js';
it('allows exploration to continue after an absent optional instruction file, while keeping secrets denied', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smart-missing-instructions-'));
  try {
    await writeFile(join(root, 'sum.mjs'), 'export default 3;');
    const broker = new NativeTools(root, 'explore', async () => false, new AbortController().signal);
    const missing = await broker.call('read_file', { path: 'AGENTS.md' });
    expect(missing).toMatchObject({ isError: true }); expect(broker.denied).toBe(false); expect(broker.touched).toBe(true);
    expect((await broker.call('read_file', { path: 'sum.mjs' })).content[0]!.text).toContain('default 3');
    await broker.call('read_file', { path: '.env' }); expect(broker.denied).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('explicitly disables known native built-in plugins and rejects any plugin still enabled', () => {
  expect(Object.values(claudeSettings(['fixture@local']).enabledPlugins)).toEqual([false, false, false, false]);
  const event = { tools: ['mcp__smart__read_file'], model: 'claude-sonnet-fixture', plugins: [] };
  expect(() => verifyClaudeTools(event, 'sonnet')).not.toThrow();
  expect(() => verifyClaudeTools({ ...event, plugins: [{ name: 'cc-plugin-agents-md' }] }, 'sonnet')).toThrow('PLUGIN');
  expect(() => verifyClaudeTools({ ...event, tools: [...event.tools, 'Bash'] }, 'sonnet')).toThrow('TOOLS');
});
