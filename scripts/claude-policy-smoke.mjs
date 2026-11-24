import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeSettings, verifyClaudeTools, claudePolicyVersions } from '../dist/claude-policy.js';
import { NativeTools } from '../dist/native-tools.js';
import { JsonLines, subscriptionEnvironment } from '../dist/native-transport.js';
// Explicit local API fixture, separate from the subscription adapter. No real credentials/account state.
const executable = process.env.SMART_CLAUDE_EXECUTABLE ?? 'claude';
const version = execFileSync(executable, ['--version'], { encoding: 'utf8', env: subscriptionEnvironment() }).trim();
const candidate = process.argv[2] === '--candidate-version' && process.argv.length === 4 ? process.argv[3] : undefined;
assert.ok(process.argv.length === 2 || candidate, 'Use --candidate-version with one exact version');
assert.ok(candidate ? version === candidate : claudePolicyVersions.includes(version), 'Unverified native version');
const root = await mkdtemp(join(tmpdir(), 'smart-claude-policy-')), home = join(root, 'home'); await mkdir(home);
let child, requests = 0, init, protocolError; const timerHandles = [];
const abort = new AbortController(); let approvals = 0;
const broker = new NativeTools(root, 'implement', async description => {
  const exact = description.startsWith('edit: value.txt\n') || description.startsWith('bash: npm test\n');
  if (exact) approvals++; return exact;
}, abort.signal);
const steps = [
  { name: 'mcp__smart__write_file', input: { path: 'value.txt', content: 'preserved' } },
  { name: 'mcp__smart__run_command', input: { command: 'npm test' } },
  { name: 'mcp__smart__write_file', input: { path: '.env', content: 'denied' } },
];
const server = createServer((req, res) => { void (async () => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.url === '/bridge') {
    assert.equal(req.headers.authorization, 'Bearer local-fixture-token');
    const input = JSON.parse(raw); const result = await broker.call(input.name, input.arguments);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result)); return;
  }
  const input = JSON.parse(raw);
  assert.deepEqual(input.tools.map(t => t.name).sort(), ['mcp__smart__list_files', 'mcp__smart__read_file', 'mcp__smart__run_command', 'mcp__smart__write_file']);
  const step = steps[requests++], id = 'fixture-message-' + requests;
  const block = step ? { type: 'tool_use', id: 'fixture-tool-' + requests, name: step.name, input: {} } : { type: 'text', text: '' };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, value) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n');
  event('message_start', { message: { id, type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  event('content_block_start', { index: 0, content_block: block });
  event('content_block_delta', { index: 0, delta: step ? { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } : { type: 'text_delta', text: 'Local fixture finished' } });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: step ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  event('message_stop', {}); res.end();
})().catch(error => { protocolError = error; res.destroy(); child?.kill(); }); });
try {
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
  await writeFile(join(root, 'value.txt'), 'prior');
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node check.cjs' } }));
  await writeFile(join(root, 'check.cjs'), "require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt','utf8'),'preserved');");
  await writeFile(join(root, 'settings.json'), JSON.stringify(claudeSettings()), { mode: 0o600 });
  await writeFile(join(root, 'mcp.json'), JSON.stringify({ mcpServers: { smart: { command: process.execPath, args: [resolve('dist/continuity-mcp.js'), `http://127.0.0.1:${port}/bridge`, 'local-fixture-token'] } } }), { mode: 0o600 });
  const env = { ...subscriptionEnvironment(), CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: 'local-fixture-only-not-a-real-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', '--max-turns', '5', '--restricted', '--tools', '', '--setting-sources', '', '--settings', join(root, 'settings.json'), '--strict-mcp-config', '--mcp-config', join(root, 'mcp.json'), '--permission-mode', 'default', '--permission-prompt-tool', 'mcp__smart__permission', '--system-prompt', 'Deterministic local policy fixture.'];
  child = spawn(executable, args, { cwd: root, env, stdio: 'pipe' });
  const parser = new JsonLines(event => { if (event.type === 'system' && event.subtype === 'init') { verifyClaudeTools(event, 'sonnet'); assert.ok(event.mcp_servers.every(s => s.name === 'smart' && s.status === 'connected')); init = event; } });
  child.stdout.on('data', b => { try { parser.push(b.toString()); } catch (error) { protocolError = error; child.kill(); } }); child.stderr.on('data', () => {}); child.stdin.on('error', () => {}); child.stdin.end('Local initialization fixture only.');
  timerHandles.push(setTimeout(() => { protocolError = new Error('Native Claude smoke timeout'); child.kill(); }, 20000));
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (protocolError) throw protocolError; assert.ok(init); assert.equal(requests, 4); assert.equal(approvals, 2);
  assert.equal(await readFile(join(root, 'value.txt'), 'utf8'), 'preserved'); await assert.rejects(readFile(join(root, '.env')));
  assert.equal(broker.evidence.length, 1); assert.ok(broker.evidence[0].endsWith(':passed')); assert.equal(broker.denied, true);
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = home;
    const { getSessionInfo } = await import('@anthropic-ai/claude-agent-sdk');
    const info = await getSessionInfo(init.session_id, { dir: await realpath(root) });
    assert.ok(info && info.sessionId === init.session_id && await realpath(info.cwd) === await realpath(root));
  } finally { if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfig; }
  const active = JSON.parse(execFileSync(executable, ['agents', '--json', '--cwd', root, '--setting-sources', '', '--restricted'], { env, encoding: 'utf8', timeout: 10000 }));
  assert.deepEqual(active, []);
  const originalSession = init.session_id; let resumed = false;
  child = spawn(executable, [...args, '--resume', originalSession], { cwd: root, env, stdio: 'pipe' });
  const resumedParser = new JsonLines(event => { if (event.type === 'system' && event.subtype === 'init') { verifyClaudeTools(event, 'sonnet'); assert.equal(event.session_id, originalSession); resumed = true; } });
  child.stdout.on('data', b => { try { resumedParser.push(b.toString()); } catch (error) { protocolError = error; child.kill(); } }); child.stderr.on('data', () => {}); child.stdin.on('error', () => {}); child.stdin.end('Explicit local fixture continuation.');
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (protocolError) throw protocolError; assert.equal(resumed, true); assert.equal(requests, 5);
  console.log(JSON.stringify({ version, candidate: !!candidate, status: 'passed', kind: 'native-claude-policy-local-provider', advertisedTools: init.tools, plugins: init.plugins.length, approvedSmartTools: approvals, independentToolExitEvidence: broker.evidence.length, secretWriteDenied: broker.denied, sessionRestart: 'passed', pinnedSdkMetadata: 'passed', realProviderInferenceRequests: 0, billableCostUsd: 0 }));
} finally { abort.abort(); for (const timer of timerHandles) clearTimeout(timer); child?.kill(); server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }); }
