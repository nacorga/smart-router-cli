export const tiers = ['fast', 'balanced', 'deep'] as const;
export type Tier = typeof tiers[number];
export type StageKind = 'explore' | 'plan' | 'implement' | 'validate' | 'review';
export type Outcome = 'completed' | 'unverified' | 'failed' | 'blocked' | 'cancelled';
export interface Config {
  schemaVersion?: 2; destinations?: Destination[];
  mode: 'auto' | 'manual'; provider: string; models: Record<Tier, string>;
  fallbacks?: Partial<Record<Tier, string>>;
  limits: { maxCostUsd: number; maxModelCalls: number; maxEscalationsPerStage: number; repairAttemptsBeforeEscalation: number; maxInfrastructureRetries: number };
  minContext: number;
}
export interface Classification { kind: 'read' | 'simple' | 'change' | 'complex'; sensitive: boolean; confidence: 'high' | 'low'; reasons: string[] }
export interface Decision { destinationId?: string; taskId: string; stepId: string; tier: Tier; modelId: string; reasonCodes: string[]; confidence: 'high' | 'low'; isOverride: boolean; estimatedCostUsd?: number; timestamp: string }
export interface StageAttempt { destinationId?: string; modelId:string; startedAt:string; durationMs:number; validation:Result['validation']; failure?:Result['failure']; evidence:string[]; reviewVerdict?:Result['reviewVerdict']; responseUncertain?:boolean; protocolError?:string }
export interface Stage { id: string; kind: StageKind; status: 'pending' | 'running' | 'done' | 'failed' | 'interrupted'; decisions: Decision[]; attempts?:StageAttempt[]; durationMs?: number }
export interface Usage { billing?: 'api' | 'subscription'; destinationId?: string; messageId: string; inputTokens: number; outputTokens: number; costUsd?: number; source: 'backend' | 'provider' | 'local' | 'unknown'; modelId?: string; stageId?: string }
export interface Result { toolEvents?: ToolEvent[]; text: string; usage: Usage[]; validation: 'passed' | 'failed' | 'none'; failure?: 'implementation' | 'infrastructure' | 'permission' | 'limit' | 'quota' | 'authentication' | 'uncertain'; toolsExecuted?: boolean; rejectedBeforeTools?: boolean; evidence: string[]; retryable?: boolean; reviewVerdict?: 'passed' | 'issues' | 'unknown' }
export interface Model { id: string; tools: boolean; context: number; outputLimit?: number; inputPrice?: number; outputPrice?: number }
export interface Task { id: string; sessionId?: string; projectPath: string; project?: { git:boolean; branch:string|null; dirty:boolean|null; instructionFiles:string[] }; status: 'created' | 'running' | Outcome; mode: Config['mode']; override?: Tier | string; budget: number; spent: number; unknownCost: boolean; calls: number; stages: Stage[]; classification: Classification; usage: Usage[]; createdAt: string; updatedAt: string; note?: string }
export interface Backend {
  identity?: string;
  capabilities?: BackendCapabilities;
  billing?: 'api' | 'subscription';
  availability?(): Promise<Availability>;
  probe?(): Promise<BackendProbe>;
  catalog(): Promise<Model[]>;
  create(): Promise<string>;
  prompt(sessionId: string, model: string, prompt: string, stage: StageKind, onText: (text: string) => void): Promise<Result>;
  prepare?(sessionId: string): Promise<void>;
  abort(sessionId: string): Promise<boolean>;
  close(): void | Promise<void>;
}

export interface Destination { id: string; backend: 'opencode' | 'codex' | 'claude'; billing: 'api' | 'subscription'; models: Record<Tier, string>; executable?: string }
export interface Availability { state: 'available' | 'exhausted' | 'unavailable' | 'unknown'; source: string; observedAt: string; resetsAt?: string }
export interface BackendCapabilities { sessions: boolean; cancellation: boolean; tools: 'smart-broker' | 'native-policy'; quota: 'official-rpc' | 'structured-events' | 'unknown' }
export interface BackendProbe { capabilities?: BackendCapabilities; authenticated: boolean; policyEnforced: boolean; version?: string; reason?: string; availability: Availability }
export interface PortableTask extends Task {
  schemaVersion: 2;
  activeDestination?: string;
  sessions: Record<string, string>;
  availability: Record<string, Availability>;
  transitions: { id: string; from?: string; to: string; state: 'prepared' | 'committed'; reason: string; at: string }[];
  requestState: 'idle' | 'inflight' | 'uncertain';
  exhausted: string[];
  stageCounters: Record<string, { repairs: number; escalations: number; retries: number; escalated?: Tier; failureKeys: string[] }>;
}
export interface Handoff {
  schemaVersion: 2; taskId: string; objective: string; constraints: string[];
  observations: string; observationsTrusted: false; fingerprint: string;
  nextStage?: string; evidence: string[];
  baseRevision?: string; filesAffected?: string[]; sourceSessions?: Record<string, string>; pendingStages?: { id: string; kind: StageKind }[];
}

export interface ToolEvent { id: string; kind: 'read' | 'write' | 'command'; status: 'completed' | 'failed'; commandHash?: string; exitCode?: number }
