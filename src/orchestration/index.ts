/**
 * SERA — Orchestration barrel.
 *
 * Public surface for the multi-model orchestration layer. The server mounts
 * `defaultModelOrchestrator`; tests can construct isolated instances with
 * custom data dirs and fake adapters.
 */
export * from './types';
export { TaskClassifier } from './TaskClassifier';
export type { TaskClassification } from './TaskClassifier';
export { ProviderRegistry, type ProviderOverrides, type RegistryPersistence } from './ProviderRegistry';
export { ProviderHealthMonitor, type ProviderHealthSnapshot } from './ProviderHealthMonitor';
export { CostController } from './CostController';
export { PerformanceMemory, MAX_HISTORY_BONUS } from './PerformanceMemory';
export { classifyFailure, recoveryStrategy, describeFailure } from './FallbackManager';
export { ModelRouter, type RouterDeps } from './ModelRouter';
export { OllamaAdapter, OpenAICompatAdapter, GeminiAdapter, createAdapterFor } from './adapters';
export {
  ModelOrchestrator,
  defaultModelOrchestrator,
  type OrchestratorRequest,
  type OrchestratorResult,
  type OrchestratorStatus,
} from './ModelOrchestrator';
