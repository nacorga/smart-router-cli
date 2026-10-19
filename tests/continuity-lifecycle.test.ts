import { it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile), entry = fileURLToPath(new URL('../src/continuity-lifecycle-pilot.ts', import.meta.url));
const run = (args: string[]) => exec(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx/esm'), entry, ...args]);
it('previews lifecycle cases without provider inference', async () => {
  const p = JSON.parse((await run([])).stdout); expect(p.status).toBe('NOT_RUN'); expect(p.realProviderInferenceRequests).toBe(0); expect(p.cases).toEqual(['recovery', 'cancel-command', 'deny']);
});
it.each([{ args: ['--run'] }, { args: ['--run', '--allow-subscription-usage', '--backend', 'unknown'] }])('blocks invalid lifecycle authorization or backend before native startup: $args', async ({ args }) => {
  await expect(run(args)).rejects.toMatchObject({ code: 1 });
});
it.skipIf(process.platform === 'win32').each(['approved', 'outside'])('uses a real controlling TTY and approves only the named fixture file: %s', async scenario => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'smart-lifecycle-tty-'))), project = join(root, 'project'); await mkdir(project);
  try {
    await writeFile(join(project, 'sum.mjs'), 'prior');
    const target = scenario === 'outside' ? join(root, 'outside.txt') : join(project, 'sum.mjs');
    const cli = join(root, 'fixture-cli.mjs');
    await writeFile(cli, `import fs from 'node:fs'; import readline from 'node:readline';
if(!process.stdin.isTTY)process.exit(4);
console.log('Approve ONE operation: edit: '+${JSON.stringify(target)}+'\\n'+JSON.stringify({filepath:${JSON.stringify(target)},content:'fixture'})+'\\nReply yes/no:');
readline.createInterface({input:process.stdin}).on('line',s=>{if(s.trim()==='yes'){fs.writeFileSync(${JSON.stringify(target)},'fixture');process.exit(0);}process.exit(1);});`);
    const control = join(root, 'control.json'); await writeFile(control, JSON.stringify({ project, mode: 'continue', taskId: 'fixture', state: join(root, 'state'), config: join(root, 'unused.json'), node: process.execPath, cli, transcript: join(root, 'tty.txt') }));
    const invoke = () => exec('python3', [fileURLToPath(new URL('../scripts/continuity-tty.py', import.meta.url)), control], { timeout: 15000 });
    if (scenario === 'approved') { expect(JSON.parse((await invoke()).stdout)).toMatchObject({ exitCode: 0, approvals: 1 }); expect(await readFile(target, 'utf8')).toBe('fixture'); }
    else { await expect(invoke()).rejects.toMatchObject({ code: 1 }); expect(await readFile(join(project, 'sum.mjs'), 'utf8')).toBe('prior'); await expect(readFile(target)).rejects.toThrow(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20000);
