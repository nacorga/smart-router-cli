import { startDedicatedServer } from './server.js';
import { createHash } from 'node:crypto';
import { createOpencodeClient, type OpencodeClient, type Part, type AssistantMessage } from '@opencode-ai/sdk/v2';
import type { Backend, Model, Result, StageKind, Usage } from './types.js';
import { permissions, stagePermissions, systemPolicy, forbiddenCommand } from './safety.js';
export type Approve = (description: string) => Promise<boolean>;
export class OpenCodeBackend implements Backend {
  constructor(readonly client: OpencodeClient, readonly directory: string, readonly approve: Approve, private shutdown: () => void | Promise<void> = () => {}) {}
  static async start(directory: string, approve: Approve, options?: { openrouterBaseURL: string }) {
    // Only a dedicated server with wrapper-owned policy is used; arbitrary servers may weaken it.
    const server=await startDedicatedServer(directory,{...(options ? {provider:{openrouter:{options:{baseURL:options.openrouterBaseURL}}}}:{}),permission:{'*':'ask',task:'deny',external_directory:'deny'},share:'disabled',autoupdate:false,agent:{smart:{mode:'primary',prompt:systemPolicy,steps:8}}});
    const client=createOpencodeClient({baseUrl:server.url});
    return new OpenCodeBackend(client,directory,approve,async()=>{
      try{await client.global.dispose({signal:AbortSignal.timeout(2000),throwOnError:true});}
      catch{/* Still stop our dedicated child when disposal is unavailable. */}
      finally{await server.close();}
    });
  }

  async catalog(): Promise<Model[]> {
    const { data } = await this.client.provider.list({ directory: this.directory }, { throwOnError: true });
    return data.all.filter(p => data.connected.includes(p.id)).flatMap(p => Object.values(p.models).filter(m => m.status !== 'deprecated').map(m => ({ id: `${p.id}/${m.id}`, tools: m.capabilities.toolcall, context: m.limit.context, outputLimit: m.limit.output, inputPrice: m.cost?.input, outputPrice: m.cost?.output })));
  }
  async create() {
    const { data } = await this.client.session.create({ directory: this.directory, title: 'Smart Router', permission: permissions }, { throwOnError: true });
    return data.id;
  }
  async prepare(sessionId: string) {
    const query = { directory: this.directory, sessionID: sessionId };
    const { data: session } = await this.client.session.get(query, { throwOnError: true });
    if (session.directory !== this.directory) throw new Error('The session belongs to another project');
    const { data: statuses } = await this.client.session.status({ directory: this.directory }, { throwOnError: true });
    if (statuses[sessionId] && statuses[sessionId]?.type !== 'idle') throw new Error('Session still active: inspect or cancel before continuing');
    await this.client.session.update({ ...query, permission: permissions }, { throwOnError: true });
  }
  async prepareStage(sessionId: string, stage: StageKind) {
    await this.client.session.update({ sessionID: sessionId, directory: this.directory, permission: stagePermissions(stage) }, { throwOnError: true });
  }
  async abort(sessionId: string) {
    const { data } = await this.client.session.abort({ sessionID: sessionId, directory: this.directory }, { throwOnError: true });
    return data === true;
  }
  async prompt(sessionId: string, model: string, prompt: string, stage: StageKind, onText: (text: string) => void): Promise<Result> {
    const slash = model.indexOf('/'); if (slash < 1) throw new Error('Model must be provider/model');
    const providerID = model.slice(0, slash), modelID = model.slice(slash + 1);
    const query = { sessionID: sessionId, directory: this.directory };
    // OpenCode 1.19.3 replaces session permissions when prompt.tools is provided.
    // Set the complete stage policy explicitly and omit that legacy field.
    await this.prepareStage(sessionId, stage);
    const before = await this.client.session.messages(query, { throwOnError: true });
    const seen = new Set(before.data.map(m => m.info.id));
    const streamAbort = new AbortController();
    const events = await this.client.event.subscribe({ directory: this.directory }, { signal: streamAbort.signal, throwOnError: true });
    let permissionDenied = false;
    const eventLoop = (async () => {
      for await (const event of events.stream) {
        if (event.type === 'message.part.delta' && event.properties.sessionID === sessionId && event.properties.field === 'text') onText(event.properties.delta);
        if (event.type === 'permission.asked' && event.properties.sessionID === sessionId) {
          const p = event.properties;
          const description = `${p.permission}: ${p.patterns.join(', ')}\n${JSON.stringify(p.metadata, null, 2)}`;
          const approved = !forbiddenCommand(description) && await this.approve(description);
          if (!approved) permissionDenied = true;
          await this.client.permission.reply({ requestID: p.id, directory: this.directory, reply: approved ? 'once' : 'reject' }, { throwOnError: true });
        }
      }
    })();
    // Capture errors promptly and abort the request rather than leave an unhandled stream rejection.
    let streamError: unknown;
    const watching = eventLoop.catch(async error => { if (!streamAbort.signal.aborted) { streamError = error; await this.abort(sessionId).catch(() => false); } });
    try {
      const { data } = await this.client.session.prompt({ ...query, model: { providerID, modelID }, agent: 'smart', system: systemPolicy,
        parts: [{ type: 'text', text: stage === 'review' ? `${prompt}\nREVIEW OUTPUT: After inspecting the code and prior validation, return ONLY a JSON object with exactly verdict (passed or issues) and findings (array of strings). A passed verdict requires no findings. Do not use markdown fences or native structured-output tools.` : prompt }] }, { throwOnError: true });
      if (streamError) throw new Error('Event stream interrupted; execution aborted');
      const messages = await this.client.session.messages(query, { throwOnError: true });
      const newMessages = messages.data.filter(m => !seen.has(m.info.id));
      const assistants = newMessages.filter((m): m is typeof m & { info: AssistantMessage } => m.info.role === 'assistant');
      if (assistants.some(m => m.info.modelID !== modelID || m.info.providerID !== providerID)) throw new Error('Backend used a model different from the selection');
      const usage: Usage[] = assistants.map(({ info }) => ({ messageId: info.id, inputTokens: info.tokens.input, outputTokens: info.tokens.output,
        costUsd: Number.isFinite(info.cost) && info.cost > 0 ? info.cost : undefined, source: info.cost > 0 ? 'backend' : 'unknown' }));
      const parts = newMessages.flatMap(m => m.parts);
      const evidence = validationEvidence(parts);
      const error = assistants.find(m => m.info.error)?.info.error ?? data.info.error;
      const failedTool = parts.some(p => p.type === 'tool' && p.state.status === 'error');
      return { text: data.parts.filter(p => p.type === 'text').map(p => p.text).join('\n'), usage,
        validation: evidence.some(e => e.endsWith(':failed')) ? 'failed' : evidence.length ? 'passed' : 'none',
        failure: permissionDenied ? 'permission' : error ? (error.name === 'APIError' || /auth|api|rate|provider|network/i.test(error.name) ? 'infrastructure' : 'implementation') : failedTool ? 'implementation' : undefined,
        reviewVerdict: stage === 'review' ? parseReview(data.parts.filter(p=>p.type==='text').map(p=>p.text).join('\n')) : undefined,
        evidence, retryable: !parts.some(p => p.type === 'tool') && !!error && /rate|429|503|overload/i.test(JSON.stringify(error)) };
    } finally { streamAbort.abort(); await watching; }
  }
  private closing?:Promise<void>;
  close():Promise<void> { return this.closing??=(async()=>{await this.shutdown();})(); }
}
export function validationEvidence(parts: Part[]): string[] {
  const lastWrite = parts.findLastIndex(p => p.type === 'tool' && ['edit', 'write', 'apply_patch'].includes(p.tool));
  return parts.slice(lastWrite + 1).flatMap(p => {
    if (p.type !== 'tool' || p.tool !== 'bash' || p.state.status !== 'completed') return [];
    const cmd = String(p.state.input.command ?? '');
    // Evidence requires structured exit status from an actual validation command, never prose.
    if (!/^(?:npm (?:test|run (?:test(?::[A-Za-z0-9_-]+)?|check|lint|type-?check))|pnpm (?:test|lint|typecheck)|yarn (?:test|lint|typecheck)|pytest|cargo test|go test)(?:\s|$)/.test(cmd) || /[;&|`<>\r\n\x00]|\$[({]/.test(cmd)) return [];
    const exit = p.state.metadata.exit;
    if (typeof exit !== 'number' || !Number.isSafeInteger(exit) || exit < 0) return [];
    return [`${createHash('sha256').update(cmd).digest('hex')}:${exit === 0 ? 'passed' : 'failed'}`];
  });
}
export { createOpencodeClient };

/** Reject malformed or contradictory review output; prose is never a success signal. */
export function parseReview(text:string):'passed'|'issues'|'unknown' {
  try {
    const value:unknown=JSON.parse(text);
    if(!value||typeof value!=='object'||Array.isArray(value))return 'unknown';
    const r=value as Record<string,unknown>;
    if(Object.keys(r).sort().join(',')!=='findings,verdict'||!Array.isArray(r.findings)||!r.findings.every(f=>typeof f==='string'))return 'unknown';
    if(r.verdict==='issues')return 'issues';
    return r.verdict==='passed'&&r.findings.length===0?'passed':'unknown';
  }catch{return 'unknown';}
}
