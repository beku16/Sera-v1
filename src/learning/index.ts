export {
  MistakeMemoryStore,
  type MistakeRecord,
  type MistakeQueryResult,
  type MistakeMemoryStoreOptions,
  buildFailureSignature,
  lexicalSimilarity,
  defaultMistakeMemoryStore,
} from './MistakeMemoryStore';

export {
  ErrorReflectionEngine,
  type ErrorClass,
  type ReflectionResult,
  type PreFlightResult,
  type ReflectionContext,
  defaultErrorReflectionEngine,
} from './ErrorReflectionEngine';

import { defaultErrorReflectionEngine } from './ErrorReflectionEngine';
import type { ErrorReflectionEngine as ErrorReflectionEngineType } from './ErrorReflectionEngine';

/**
 * Process-wide reflection pipeline. Historical note: this used to be a
 * SECOND ErrorReflectionEngine instance over the same store, which meant
 * anything that used it bypassed the engine attached to the ToolManager
 * and could double-record lessons. It is now an alias of the one true
 * process-wide engine, so both names always share identical state.
 */
export const defaultLearningPipeline: ErrorReflectionEngineType = defaultErrorReflectionEngine;
