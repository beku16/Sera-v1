/**
 * SERA — Multi-Model Orchestration: shared types.
 *
 * The orchestrator lets SERA pick the best AVAILABLE brain for each task
 * across three tiers: LOCAL (Ollama), FREE (documented free-tier cloud
 * APIs), and PAID (user-authorized cloud APIs). FREE-FIRST is the law:
 * paid providers are hard-locked OFF unless the user explicitly opens them.
 */

/** Which tier a provider belongs to. */
export type ProviderType = 'local' | 'free' | 'paid';

/**
 * How confident we are that a provider's free tier is real:
 * - vendor_documented: the vendor publicly documents a free tier (may still
 *   change — the UI shows a "verify terms" hint).
 * - user_confirmed: the user explicitly marked this endpoint free.
 * - unverified: unknown terms — treated as potentially costing money and
 *   NEVER advertised as free.
 */
export type FreeTierStatus = 'vendor_documented' | 'user_confirmed' | 'unverified';

/** Health states tracked per provider (spec: PROVIDER HEALTH MONITOR). */
export type HealthState =
  | 'healthy'
  | 'degraded'
  | 'rate_limited'
  | 'offline'
  | 'invalid_key'
  | 'unavailable'
  | 'unknown';

/** Task categories the classifier can emit (spec: TASK ROUTING). */
export type TaskCategory =
  | 'conversation'
  | 'voice'
  | 'wake_response'
  | 'simple_qa'
  | 'complex_reasoning'
  | 'coding'
  | 'debugging'
  | 'vision'
  | 'screen_control'
  | 'browser_automation'
  | 'tool_execution'
  | 'planning'
  | 'memory'
  | 'summarization'
  | 'translation'
  | 'classification'
  | 'extraction'
  | 'local_private_task'
  | 'long_context'
  | 'multimodal';

/** Privacy classification for privacy-aware routing (spec). */
export type PrivacyLevel = 'public' | 'normal' | 'private' | 'highly_private';

/** Routing modes the user can pick in Settings (spec: USER CONTROL). */
export type RoutingMode = 'free_first' | 'local_first' | 'balanced' | 'performance_first' | 'custom';

/** Capability axes every model advertises, scored 0..10 (0 = unsupported). */
export type CapabilityKey =
  | 'fast_response'
  | 'reasoning'
  | 'coding'
  | 'vision'
  | 'tool_calling'
  | 'long_context'
  | 'multimodal'
  | 'stt'
  | 'tts'
  | 'summarization'
  | 'translation';

export type CapabilityMatrix = Record<CapabilityKey, number>;

/** A single model advertised by a provider. */
export interface ModelDescriptor {
  /** Model id as sent to the provider API (e.g. "llama-3.3-70b-versatile"). */
  id: string;
  label: string;
  caps: CapabilityMatrix;
  /** Context window in tokens (used for context-fit routing). */
  contextWindow: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  /** Rough latency class — refined live by the health monitor. */
  latencyClass: 'lightning' | 'fast' | 'moderate' | 'slow';
}

/** A provider (a reachable API endpoint / local runtime) and its models. */
export interface ProviderDescriptor {
  id: string;
  name: string;
  type: ProviderType;
  /** OpenAI-compatible base URL, Gemini base URL, or Ollama base URL. */
  endpoint: string;
  authMethod: 'none' | 'bearer' | 'x-goog-api-key';
  /** Which ApiKeyVault provider id holds the credential (if any). */
  keyProviderId?: string;
  models: ModelDescriptor[];
  enabled: boolean;
  /** Lower = tried earlier within the same tier. */
  priority: number;
  freeTier: FreeTierStatus;
  /**
   * Whether the user trusts this provider with PRIVATE-level tasks.
   * Cloud providers default to false — private content prefers LOCAL.
   */
  trustedForPrivate: boolean;
  /** True only when the user explicitly added/authorized this provider. */
  userAuthorized: boolean;
  notes?: string;
}

/** Context handed to the router for one request. */
export interface RoutingContext {
  text: string;
  taskType?: TaskCategory;
  privacy?: PrivacyLevel;
  /** Extra hard capability requirements (e.g. ['vision']). */
  requires?: CapabilityKey[];
  /** Estimated prompt size in tokens (for context-fit routing). */
  estimatedTokens?: number;
  /** True when the request carries images (needs vision > 0). */
  hasImages?: boolean;
  sessionId?: string;
}

/** One scored candidate in the router's ranked shortlist. */
export interface ScoredCandidate {
  providerId: string;
  providerName: string;
  providerType: ProviderType;
  modelId: string;
  score: number;
  breakdown: {
    capabilityMatch: number;
    taskSuitability: number;
    latencyScore: number;
    reliabilityScore: number;
    availabilityScore: number;
    freePriority: number;
    contextFit: number;
    costPenalty: number;
  };
  health: HealthState;
  reasons: string[];
}

/** The router's final decision for one request. */
export interface RoutingDecision {
  requestId: string;
  taskType: TaskCategory;
  privacy: PrivacyLevel;
  requires: CapabilityKey[];
  routingMode: RoutingMode;
  selected: ScoredCandidate | null;
  candidates: ScoredCandidate[];
  rejected: Array<{ providerId: string; modelId: string; reason: string }>;
  rationale: string;
  createdAt: string;
}

/** Failure taxonomy (spec: FAILURE CLASSIFICATION). */
export type FailureKind =
  | 'network_failure'
  | 'auth_failure'
  | 'rate_limit'
  | 'timeout'
  | 'server_error'
  | 'model_unavailable'
  | 'invalid_request'
  | 'context_too_large'
  | 'tool_call_failure'
  | 'vision_unavailable'
  | 'provider_offline'
  | 'unknown';

/** Error thrown by adapters, carrying the classified failure kind. */
export class ProviderError extends Error {
  readonly kind: FailureKind;
  readonly providerId: string;
  readonly modelId: string;
  readonly status?: number;

  constructor(kind: FailureKind, providerId: string, modelId: string, message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.providerId = providerId;
    this.modelId = modelId;
    this.status = status;
  }
}

/** Normalized chat request handed to a provider adapter. */
export interface AdapterChatRequest {
  model: string;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
  maxTokens?: number;
  /** Images (base64, no data: prefix) only sent to vision-capable models. */
  images?: string[];
}

/** Normalized chat reply from a provider adapter. */
export interface AdapterChatReply {
  text: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  /** Time to first token in ms when measurable (non-streaming: total). */
  ttftMs?: number;
}

/** One provider adapter — the ONLY place provider-specific HTTP lives. */
export interface ProviderAdapter {
  readonly providerId: string;
  chat(request: AdapterChatRequest, timeoutMs?: number): Promise<AdapterChatReply>;
  /** Cheap liveness/credential probe used by Test buttons and health checks. */
  probe(): Promise<{ ok: boolean; state: HealthState; message: string; latencyMs?: number }>;
}

/** Structured telemetry for every AI request (spec: OBSERVABILITY). */
export interface TelemetryEvent {
  requestId: string;
  taskType: TaskCategory;
  providerId: string;
  modelId: string;
  localOrCloud: 'local' | 'cloud';
  freeOrPaid: 'free' | 'paid';
  latencyMs: number;
  ttftMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  success: boolean;
  fallbackUsed: boolean;
  fallbackReason?: string;
  failureKind?: FailureKind;
  at: string;
}

/** Cost controller state persisted to disk. */
export interface CostLedger {
  allowPaidProviders: boolean;
  dailyBudgetUsd: number | null;
  monthlyBudgetUsd: number | null;
  /** ISO date (YYYY-MM-DD) -> estimated USD spent that day. */
  daily: Record<string, number>;
  /** ISO month (YYYY-MM) -> estimated USD spent that month. */
  monthly: Record<string, number>;
  updatedAt: string;
}

/** Per model×task performance stats (spec: MODEL PERFORMANCE MEMORY). */
export interface PerformanceStat {
  modelId: string;
  providerId: string;
  taskType: TaskCategory;
  successes: number;
  failures: number;
  /** EWMA of latency in ms. */
  avgLatencyMs: number;
  lastUsedAt: string;
}

/** Startup audit recommendation (spec: STARTUP MODEL AUDIT). */
export interface ModelAudit {
  hardwareTier: string;
  primaryLocalModel: string | null;
  fastVoiceModel: string | null;
  reasoningModel: string | null;
  visionModel: string | null;
  emergencyFallback: string | null;
  ollamaRunning: boolean;
  installedModels: string[];
  recommendations: string[];
}
