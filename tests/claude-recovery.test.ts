import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ getSessionInfo: vi.fn() }));
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeBackend } from '../src/native-backends.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0)) await f(); vi.resetAllMocks(); });
it.each(['idle', 'missing', 'foreign', 'active', 'ambiguous'])('checks Claude metadata and activity before %s continuation without inference', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'smart-claude-recovery-')), executable = join(root, 'claude.mjs'); cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(executable, `#!/usr/bin/env node
if(process.argv[2]!=='agents'||!process.argv.includes('--json'))process.exit(2);
console.log(${JSON.stringify(scenario === 'ambiguous' ? '{}' : scenario === 'active' ? '[{"sessionId":"fixture"}]' : '[]')});
`, { mode: 0o700 });
  const id = '00000000-0000-4000-8000-000000000000';
  vi.mocked(getSessionInfo).mockResolvedValue(scenario === 'missing' ? undefined : { sessionId: id, summary: 'private-not-exported', lastModified: 1, cwd: scenario === 'foreign' ? tmpdir() : root });
  const b = new ClaudeBackend({ id: 'claude', backend: 'claude', billing: 'subscription', executable, models: { fast: 'sonnet', balanced: 'sonnet', deep: 'sonnet' } }, root, async () => false); cleanup.unshift(() => b.close());
  if (scenario === 'idle') { await b.prepare(id); expect(getSessionInfo).toHaveBeenCalledWith(id, { dir: root }); }
  else await expect(b.prepare(id)).rejects.toThrow('INSPECTION_REQUIRED');
});
