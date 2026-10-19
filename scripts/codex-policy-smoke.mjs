import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcProcess, subscriptionEnvironment } from '../dist/native-transport.js';
import { featureNames, codexPolicyArgs, codexPolicyVersion, inactiveCodexMcp, restrictedCodexModel, verifyCodexPolicy } from '../dist/codex-policy.js';
import { NativeTools } from '../dist/native-tools.js';
import { smartTools } from '../dist/continuity-mcp.js';
// The installed native binary talks ONLY to a deterministic loopback Responses server.
// No account, auth file, model cache, external inference, or real model credential is used.
const executable = process.env.SMART_CODEX_EXECUTABLE ?? 'codex';
const version = execFileSync(executable, ['--version'], { encoding: 'utf8', env: subscriptionEnvironment() }).trim();
assert.equal(version, codexPolicyVersion);
const features = featureNames(execFileSync(executable, ['features', 'list'], { encoding: 'utf8', env: subscriptionEnvironment() }));
const root = await mkdtemp(join(tmpdir(), 'smart-codex-native-')), previousHome = process.env.CODEX_HOME;
let rpc, server, timeout; const abort = new AbortController();
try {
  const home = join(root, 'home'); await mkdir(home); process.env.CODEX_HOME = home;
  await writeFile(join(home, 'config.toml'), '[mcp_servers.fixture_disabled]\ncommand = '+JSON.stringify(process.execPath)+'\nargs = ["-e", '+JSON.stringify("require('node:fs').writeFileSync('forbidden-mcp','executed')")+']\nenabled = true\n');
  await writeFile(join(root, 'value.txt'), 'prior');
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node check.cjs' } }));
  await writeFile(join(root, 'check.cjs'), "require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt','utf8'),'preserved');");
  const catalog = join(root, 'models.json');
  const metadata = restrictedCodexModel({ slug: 'smart-fixture', display_name: 'Local fixture', model_messages: {instructions_template:'Deterministic local fixture.'}, description: null, default_reasoning_level: null, supported_reasoning_levels: [], visibility: 'list', supported_in_api: true, priority: 0, additional_speed_tiers: [], service_tiers: [], default_reasoning_summary: 'auto', support_verbosity: false, default_verbosity: null, web_search_tool_type: 'text', truncation_policy: { mode: 'bytes', limit: 10000 }, context_window: 200000, effective_context_window_percent: 95, input_modalities: ['text'] });
  await writeFile(catalog, JSON.stringify({ models: [metadata] }), { mode: 0o600 });
  const tools = smartTools.filter(t => t.name !== 'permission').map(t => ({ name: 'smart_' + t.name, description: t.description, inputSchema: t.inputSchema }));
  const forced = [
    { name: 'spawn_agent', namespace: 'collaboration', arguments: { task_name: 'fixture', message: 'Fixture only' } },
    { name: 'shell_command', namespace: 'functions', arguments: { command: 'touch forbidden' } },
    { name: 'exec_command', namespace: 'functions', arguments: { cmd: 'touch forbidden' } },
    { name: 'write_stdin', namespace: 'functions', arguments: { session_id: 1, chars: 'fixture' } },
    { name: 'view_image', namespace: 'functions', arguments: { path: '.env' } },
    { name: 'apply_patch', namespace: 'functions', arguments: { patch: 'fixture' } },
    { name: 'read_file', namespace: 'functions', arguments: { path: '.env' } },
    { name: 'smart_write_file', namespace: 'functions', arguments: { path: 'value.txt', content: 'preserved' } },
    { name: 'smart_run_command', namespace: 'functions', arguments: { command: 'npm test' } },
  ];
  let requests = 0; const advertised = [], methods = [], approvals = [];
  server = createServer((req, res) => { void (async () => {
    let raw = ''; for await (const chunk of req) raw += chunk; const input = JSON.parse(raw);
    const registry = [...(input.tools ?? []), ...(input.input ?? []).filter(i => i.type === 'additional_tools').flatMap(i => i.tools ?? [])];
    const names = registry.flatMap(t => t.type === 'namespace' ? t.tools.map(x => t.name === 'functions' ? x.name : `${t.name}.${x.name}`) : [t.name ?? t.type]);
    advertised.push(names); assert.deepEqual([...names].sort(), tools.map(t => t.name).sort());
    const step = forced[requests++], id = 'fixture-item-' + requests;
    const item = step ? { id, type: 'function_call', call_id: id, name: step.name, namespace: step.namespace, arguments: JSON.stringify(step.arguments) } : { id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture complete', annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (type, fields) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n');
    event('response.created', { response: { id: 'fixture-response', output: [], status: 'in_progress' } });
    event('response.output_item.added', { output_index: 0, item }); event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response: { id: 'fixture-response', object: 'response', created_at: 1, status: 'completed', model: 'smart-fixture', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end();
  })().catch(error => { console.error(error.message); res.destroy(error); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
  const args = ['app-server', '--stdio', ...codexPolicyArgs(features, ['fixture_disabled']), '-c', `model_catalog_json=${JSON.stringify(catalog)}`, '-c', 'model_provider="fixture"', '-c', `model_providers.fixture={name="Local Fixture",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`];
  rpc = new RpcProcess(executable, args, root);

  await rpc.request('initialize', { clientInfo: { name: 'smart-policy-fixture', version: '1' }, capabilities: { experimentalApi: true } }); rpc.notify('initialized');
  const effective = await rpc.request('config/read', { includeLayers: true });
  assert.equal(verifyCodexPolicy(effective.config, features, catalog, 'fixture', effective.layers), true);
  const broker = new NativeTools(root, 'implement', async text => { approvals.push(text); return true; }, abort.signal);
  rpc.onRequest = async (method, params) => {
    methods.push(method); assert.equal(method, 'item/tool/call'); assert.ok(tools.some(t => t.name === params.tool));
    const result = await broker.call(params.tool.slice(6), params.arguments);
    return { success: !result.isError, contentItems: result.content.map(c => ({ type: 'inputText', text: c.text })) };
  };
  let finish, fail; const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; }); void completed.catch(() => {});
  rpc.onNotification = (method, params) => { if (method === 'item/started' && ['commandExecution', 'fileChange', 'imageView'].includes(params.item?.type)) { fail(new Error('Forbidden native operation attempted')); return; } if (method === 'turn/completed') { if (params.turn.status === 'completed') finish(); else fail(new Error('Native turn did not complete')); } };
  rpc.onClose = () => fail(new Error('Native process closed before completion'));
  timeout = setTimeout(() => fail(new Error('Native policy smoke timed out')), 45000);
  const thread = await rpc.request('thread/start', { cwd: root, model: 'smart-fixture', modelProvider: 'fixture', sandbox: 'read-only', approvalPolicy: 'never', baseInstructions: 'Deterministic local fixture.', dynamicTools: tools });
  const mcp = await rpc.request('mcpServerStatus/list', { threadId: thread.thread.id }); assert.equal(inactiveCodexMcp(mcp), true);
  await rpc.request('turn/start', { threadId: thread.thread.id, model: 'smart-fixture', input: [{ type: 'text', text: 'Local fixture only' }] });
  await completed; rpc.onClose = undefined;
  assert.equal(requests, forced.length + 1); assert.equal(approvals.length, 2); assert.equal(methods.length, 2);
  assert.equal(await readFile(join(root, 'value.txt'), 'utf8'), 'preserved'); await assert.rejects(readFile(join(root, 'forbidden'))); await assert.rejects(readFile(join(root, 'forbidden-mcp')));
  assert.equal(broker.evidence.length, 1); assert.ok(broker.evidence[0].endsWith(':passed'));
  await rpc.close(); rpc = new RpcProcess(executable, args, root);
  await rpc.request('initialize', { clientInfo: { name: 'smart-policy-fixture', version: '1' }, capabilities: { experimentalApi: true } }); rpc.notify('initialized');
  const stored = await rpc.request('thread/read', { threadId: thread.thread.id, includeTurns: false });
  assert.equal(stored.thread.status.type, 'notLoaded');
  const resumed = await rpc.request('thread/resume', { threadId: thread.thread.id, cwd: root, modelProvider: 'fixture', sandbox: 'read-only', approvalPolicy: 'never', baseInstructions: 'Deterministic local fixture.', excludeTurns: true });
  assert.equal(resumed.thread.id, thread.thread.id);
  assert.equal(inactiveCodexMcp(await rpc.request('mcpServerStatus/list', { threadId: thread.thread.id })), true);
  // An explicit new turn verifies that the persisted dynamic tool registry survives restart.
  const resumedDone = new Promise((resolve, reject) => {
    rpc.onClose = () => reject(new Error('Resumed fixture process closed'));
    rpc.onNotification = (method, params) => { if (method === 'turn/completed') params.turn.status === 'completed' ? resolve() : reject(new Error('Resumed turn failed')); };
  }); void resumedDone.catch(() => {});
  await rpc.request('turn/start', { threadId: thread.thread.id, model: 'smart-fixture', input: [{ type: 'text', text: 'Explicit continuation of local fixture' }] }); await resumedDone; rpc.onClose = undefined;
  assert.equal(requests, forced.length + 2);
  console.log(JSON.stringify({ sessionRestart: 'passed', status: 'passed', kind: 'native-codex-policy-local-provider', advertisedTools: advertised[0], rejectedNativeTools: forced.length - 2, approvedSmartTools: methods.length, realProviderInferenceRequests: 0, billableCostUsd: 0 }));
} finally {
  clearTimeout(timeout); abort.abort(); if (rpc) { rpc.onClose = undefined; await rpc.close(); }
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
}
