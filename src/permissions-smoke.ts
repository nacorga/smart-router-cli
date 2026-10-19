import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeBackend } from './opencode.js';
import type { PermissionRuleset } from '@opencode-ai/sdk/v2';
import type { StageKind } from './types.js';

/** Exercise the pinned server's real permission persistence, without inference or credentials. */
async function main() {
  const fixture = await mkdtemp(join(tmpdir(), 'smart-permissions-'));
  const previousDirectory = process.cwd();
  for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    const path = join(fixture, name.toLowerCase());
    await mkdir(path);
    process.env[name] = path;
  }
  process.chdir(fixture);
  let backend: OpenCodeBackend | undefined;
  try {
    backend = await OpenCodeBackend.start(fixture, async () => { throw new Error('Unexpected permission request'); });
    const sessionID = await backend.create();
    const stages: StageKind[] = ['explore', 'plan', 'implement', 'validate', 'review'];
    for (const stage of stages) {
      await backend.prepareStage(sessionID, stage);
      const { data: before }: { data: { permission?: PermissionRuleset } } = await backend.client.session.get({ sessionID, directory: fixture }, { throwOnError: true });
      // The removed legacy tools field used to replace these rules, even with noReply enabled.
      const { data: message }: { data: unknown } = await backend.client.session.prompt({
        sessionID, directory: fixture, agent: 'smart', noReply: true,
        model: { providerID: 'smart-permission-smoke', modelID: 'no-inference' },
        parts: [{ type: 'text', text: 'Local permission persistence check; do not generate a response.' }],
      }, { throwOnError: true });
      assert.equal((message as unknown as { info: { role: string } }).info.role, 'user');
      const { data: session }: { data: { permission?: PermissionRuleset } } = await backend.client.session.get({ sessionID, directory: fixture }, { throwOnError: true });
      assert.deepEqual(session.permission, before.permission, `Prompt replaced policy during ${stage}`);
      const rules = session.permission ?? [];
      const matches = (pattern: string, value: string) => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(value);
      const action = (permission: string, pattern: string) => rules.findLast(rule => matches(rule.permission, permission) && matches(rule.pattern, pattern))?.action;
      const readonly = stage === 'explore' || stage === 'plan' || stage === 'review';
      assert.equal(action('read', join(fixture, 'src/example.ts')), 'allow');
      assert.equal(action('glob', '**/*.ts'), 'allow');
      assert.equal(action('grep', 'generateEventId'), 'allow');
      assert.equal(action('read', join(fixture, '.env')), 'deny');
      assert.equal(action('read', join(fixture, 'nested/.env.local')), 'deny');
      assert.equal(action('external_directory', '/outside'), 'deny');
      assert.equal(action('task', 'explore'), 'deny');
      assert.equal(action('question', '*'), 'deny');
      assert.equal(action('edit', join(fixture, 'example.ts')), readonly ? 'deny' : 'ask');
      assert.equal(action('bash', 'npm test'), readonly ? 'deny' : 'ask');
    }
    const { data: messages } = await backend.client.session.messages({ sessionID, directory: fixture }, { throwOnError: true });
    assert.equal(messages.filter(m => m.info.role === 'assistant').length, 0);
    console.log(JSON.stringify({ serverVersion: '1.19.3', stages, permissionPersistence: 'passed', assistantMessages: 0, llmCalls: 0, billableCostUsd: 0 }));
  } finally {
    await backend?.close();
    process.chdir(previousDirectory);
    await rm(fixture, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Permission smoke failed'); process.exitCode = 1; });
