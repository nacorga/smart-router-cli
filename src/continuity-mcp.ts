import { isMain } from './entrypoint.js';
import { createInterface } from 'node:readline';
/** Private stdio bridge: only the parent owns policy, approvals and actual tool execution. */
export const smartTools = [
  { name: 'read_file', description: 'Read a project file, excluding secrets', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'list_files', description: 'List nonignored project files, excluding secrets', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'write_file', description: 'Write a project file with human approval', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'run_command', description: 'Run one direct validation command with human approval', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } },
  { name: 'permission', description: 'Smart permission host; actual operations are independently checked', inputSchema: { type: 'object', additionalProperties: true } },
];
async function main() {
  const [url, token] = process.argv.slice(2);
  if (!url || !token || new URL(url).hostname !== '127.0.0.1') throw new Error('Invalid private bridge');
  const seen = new Set<string>();
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    let request: any;
    try {
      request = JSON.parse(line); if (request.id === undefined) continue;
      let result: unknown;
      if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'smart', version: '1.0.0' } };
      else if (request.method === 'ping') result = {};
      else if (request.method === 'tools/list') result = { tools: smartTools };
      else if (request.method === 'tools/call') {
        const id = typeof request.id + ':' + String(request.id);
        if (seen.has(id) || seen.size >= 256) throw new Error('Repeated or excessive tool request'); seen.add(id);
        const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(request.params), signal: AbortSignal.timeout(300000) });
        if (!response.ok) throw new Error('Bridge denied'); result = await response.json();
      } else throw new Error('Unsupported MCP operation');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    } catch { if (request?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Smart operation denied' } }) + '\n'); }
  }
}
if (isMain(import.meta.url)) void main();
