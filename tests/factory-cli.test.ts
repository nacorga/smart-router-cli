import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fixture } from './factory-helpers.js';
const exec = promisify(execFile);
it('exposes CLI help and noninteractive run/status/inspect/cancel without granting inference', async () => {
  const f = await fixture(); const cli = join(process.cwd(), 'src/factory/cli.ts');
  const env = { PATH: process.env.PATH, HOME: f.root, SMART_STATE_DIR: join(f.root, 'cli-state'), XDG_CONFIG_HOME: join(f.root, 'config') };
  const invoke = (args: string[]) => exec(process.execPath, ['--import', 'tsx', cli, ...args], { env, timeout: 15000 });
  try {
    expect((await invoke(['--help'])).stdout).toContain('TaskSpec never grants tools');
    const path = join(f.root, 'task.json'); await writeFile(path, JSON.stringify(f.spec));
    let output = ''; try { await invoke(['run', '--spec', path]); } catch (e) { output = (e as any).stdout; }
    expect(output).toContain('INFERENCE_PERMISSION_DENIED');
    const status = JSON.parse((await invoke(['status', f.spec.id])).stdout); expect(status.state).toBe('BLOCKED'); expect(status.events.length).toBeGreaterThan(0);
    const inspected = JSON.parse((await invoke(['inspect', f.spec.id])).stdout); expect(inspected.workspace.baseSha).toMatch(/^[a-f0-9]{40}$/);
    const cancelled = JSON.parse((await invoke(['cancel', f.spec.id])).stdout); expect(cancelled.state).toBe('CANCELLED');
    await expect(invoke(['continue', f.spec.id])).rejects.toThrow();
  } finally { await f.cleanup(); }
}, 20000);
