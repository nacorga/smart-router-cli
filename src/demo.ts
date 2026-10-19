import type { Backend, Model, Result, StageKind } from './types.js';
// Offline demonstration only: no files edited, no provider called, no quality/cost claims.
export class DemoBackend implements Backend {
  async catalog(): Promise<Model[]> { return ['fast', 'balanced', 'deep'].map(t => ({ id: `demo/${t}`, tools: true, context: 128000, inputPrice: 0, outputPrice: 0 })); }
  async create() { return 'demo-session'; }
  async prompt(_id: string, model: string, _prompt: string, stage: StageKind, onText: (s: string) => void): Promise<Result> {
    const text = `SIMULATION: ${stage} using ${model}. No real tools or validation are executed.`; onText(text);
    return { text, usage: [{ messageId: crypto.randomUUID(), inputTokens: 0, outputTokens: 0, costUsd: 0, source: 'backend' }], validation: 'none', evidence: [] };
  }
  async abort() { return true; }
  close() {}
}
