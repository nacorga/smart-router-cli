export const tiers = ['fast', 'balanced', 'deep'] as const;
export type Tier = typeof tiers[number];
export type StageKind = 'explore' | 'plan' | 'implement' | 'validate' | 'review';
export type Outcome = 'completed' | 'unverified' | 'failed' | 'blocked' | 'cancelled';
export interface Config {
  mode: 'auto' | 'manual'; provider: string; models: Record<Tier, string>;
  fallbacks?: Partial<Record<Tier, string>>;
  limits: { maxCostUsd: number; maxModelCalls: number; maxEscalationsPerStage: number; repairAttemptsBeforeEscalation: number; maxInfrastructureRetries: number };
  minContext: number;
}
export interface Classification { kind: 'read' | 'simple' | 'change' | 'complex'; sensitive: boolean; confidence: 'high' | 'low'; reasons: string[] }
export interface Decision { taskId: string; stepId: string; tier: Tier; modelId: string; reasonCodes: string[]; confidence: 'high' | 'low'; isOverride: boolean; estimatedCostUsd?: number; timestamp: string }
export interface StageAttempt { modelId:string; startedAt:string; durationMs:number; validation:Result['validation']; failure?:Result['failure']; evidence:string[]; reviewVerdict?:Result['reviewVerdict']; responseUncertain?:boolean }
export interface Stage { id: string; kind: StageKind; status: 'pending' | 'running' | 'done' | 'failed' | 'interrupted'; decisions: Decision[]; attempts?:StageAttempt[]; durationMs?: number }
export interface Usage { messageId: string; inputTokens: number; outputTokens: number; costUsd?: number; source: 'backend' | 'provider' | 'local' | 'unknown'; modelId?: string; stageId?: string }
export interface Result { text: string; usage: Usage[]; validation: 'passed' | 'failed' | 'none'; failure?: 'implementation' | 'infrastructure' | 'permission' | 'limit'; evidence: string[]; retryable?: boolean; reviewVerdict?: 'passed' | 'issues' | 'unknown' }
export interface Model { id: string; tools: boolean; context: number; outputLimit?: number; inputPrice?: number; outputPrice?: number }
export interface Task { id: string; sessionId?: string; projectPath: string; project?: { git:boolean; branch:string|null; dirty:boolean|null; instructionFiles:string[] }; status: 'created' | 'running' | Outcome; mode: Config['mode']; override?: Tier | string; budget: number; spent: number; unknownCost: boolean; calls: number; stages: Stage[]; classification: Classification; usage: Usage[]; createdAt: string; updatedAt: string; note?: string }
export interface Backend {
  catalog(): Promise<Model[]>;
  create(): Promise<string>;
  prompt(sessionId: string, model: string, prompt: string, stage: StageKind, onText: (text: string) => void): Promise<Result>;
  prepare?(sessionId: string): Promise<void>;
  abort(sessionId: string): Promise<boolean>;
  close(): void | Promise<void>;
}
