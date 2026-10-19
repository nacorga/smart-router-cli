import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeSettings, verifyClaudeTools } from '../dist/claude-policy.js';
import { JsonLines, subscriptionEnvironment } from '../dist/native-transport.js';
// Explicit local API fixture, separate from the subscription adapter. No real credentials/account state.
const executable = process.env.SMART_CLAUDE_EXECUTABLE ?? 'claude';
assert.match(execFileSync(executable, ['--version'], { encoding: 'utf8', env: subscriptionEnvironment() }), /^2\.1\.303\b/);
const root = await mkdtemp(join(tmpdir(), 'smart-claude-policy-')), home = join(root, 'home'); await mkdir(home);
let child, requests = 0, init, protocolError; const timerHandles = [];
const server = createServer((req, res) => {
  if (req.url === '/bridge') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: 'Diagnostic only; operations denied' }] })); return; }
  requests++; res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Deterministic local fixture' } }));
  timerHandles.push(setTimeout(() => child?.kill(), 200));
});
try {
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
  await writeFile(join(root, 'settings.json'), JSON.stringify(claudeSettings()), { mode: 0o600 });
  await writeFile(join(root, 'mcp.json'), JSON.stringify({ mcpServers: { smart: { command: process.execPath, args: [resolve('dist/continuity-mcp.js'), `http://127.0.0.1:${port}/bridge`, 'local-fixture-token'] } } }), { mode: 0o600 });
  const env = { ...subscriptionEnvironment(), CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: 'local-fixture-only-not-a-real-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  child = spawn(executable, ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', '--max-turns', '1', '--restricted', '--tools', '', '--setting-sources', '', '--settings', join(root, 'settings.json'), '--strict-mcp-config', '--mcp-config', join(root, 'mcp.json'), '--permission-mode', 'default', '--permission-prompt-tool', 'mcp__smart__permission', '--system-prompt', 'Local fixture; do not execute tools.'], { cwd: root, env, stdio: 'pipe' });
  const parser = new JsonLines(event => { if (event.type === 'system' && event.subtype === 'init') { verifyClaudeTools(event, 'sonnet'); assert.ok(event.mcp_servers.every(s => s.name === 'smart' && s.status === 'connected')); init = event; } });
  child.stdout.on('data', b => { try { parser.push(b.toString()); } catch (error) { protocolError = error; child.kill(); } }); child.stderr.on('data', () => {}); child.stdin.on('error', () => {}); child.stdin.end('Local initialization fixture only.');
  timerHandles.push(setTimeout(() => child.kill(), 15000));
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (protocolError) throw protocolError; assert.ok(init); assert.ok(requests > 0);
  console.log(JSON.stringify({ status: 'passed', kind: 'native-claude-policy-local-provider', advertisedTools: init.tools, plugins: init.plugins.length, realProviderInferenceRequests: 0, billableCostUsd: 0 }));
} finally { for (const timer of timerHandles) clearTimeout(timer); child?.kill(); server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }); }
