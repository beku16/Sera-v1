export {
  HardwareInspector,
  type HardwareReport,
  type GpuInfo,
  parseNvidiaSmiCsv,
  parseCudaCapability,
  defaultHardwareInspector,
} from './HardwareInspector';

export {
  LOCAL_MODEL_CATALOG,
  type LocalModelSpec,
  type ModelRecommendation,
  recommendLocalModel,
} from './ModelRecommender';

export {
  OllamaClient,
  type OllamaStatus,
  type OllamaModelSummary,
  type OllamaChatMessage,
  type OllamaChatResponse,
  type PullProgressEvent,
  defaultOllamaClient,
} from './OllamaClient';

export {
  LocalWhisperStt,
  LocalPiperTts,
  type EngineAvailability,
  type WhisperTranscribeResult,
  type PiperSynthesizeResult,
  wrapWavHeader,
} from './LocalSpeechEngines';

export {
  LocalAgentEngine,
  type LocalAgentEvent,
  toOllamaToolDeclarations,
} from './LocalAgentEngine';
