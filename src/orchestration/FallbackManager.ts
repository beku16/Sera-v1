/**
 * SERA — FallbackManager: failure classification + recovery strategy.
 *
 * Different failures demand different reactions (spec: FAILURE CLASSIFICATION):
 *  - auth_failure      -> stop retrying this provider entirely (needs a human
 *                         to fix the key), move to the next candidate.
 *  - rate_limit        -> cool the provider down, prefer another provider.
 *  - timeout           -> immediately try the next (faster) candidate.
 *  - network_failure   -> strongly prefer LOCAL next (the internet is unhappy).
 *  - model_unavailable -> same provider, different model, then next provider.
 *  - context_too_large -> next candidate must have a bigger context window.
 *  - invalid_request   -> the request is ours: do not retry identical payload
 *                         on the same model, move on.
 */
import { ProviderError } from './types';
import type { FailureKind } from './types';

export interface RawFailure {
  error: unknown;
  providerId: string;
  modelId: string;
  status?: number;
}

/** Classify any thrown error into the failure taxonomy. */
export function classifyFailure(raw: RawFailure): FailureKind {
  if (raw.error instanceof ProviderError) return raw.error.kind;
  const err = raw.error as { code?: string; message?: string; status?: number; statusCode?: number } | null;
  const status = raw.status ?? err?.status ?? err?.statusCode;
  const message = String(err?.message ?? raw.error ?? '').toLowerCase();
  const code = String(err?.code ?? '').toLowerCase();

  if (status === 401 || status === 403) return 'auth_failure';
  if (status === 429) return 'rate_limit';
  if (status === 404) return 'model_unavailable';
  if (status === 400 && /context|maximum.*tokens|too (long|large|many)/.test(message)) return 'context_too_large';
  if (status >= 500) return 'server_error';

  if (/context length|context window|too many tokens|maximum context/.test(message)) return 'context_too_large';
  if (/api key|unauthorized|forbidden|invalid[_ ]key|authentication/i.test(message)) return 'auth_failure';
  if (/rate limit|too many requests|quota/.test(message)) return 'rate_limit';
  if (/aborted|aborterror|etimedout|timeout|timed out/.test(message) || /etimedout/.test(code)) return 'timeout';
  if (/enotfound|econnrefused|econnreset|epipe|eai_again|network|socket|fetch failed|dns/.test(message) || /enotfound|econnrefused/.test(code)) {
    return 'network_failure';
  }
  if (/model.*(not found|does not exist|unavailable)|no such model/.test(message)) return 'model_unavailable';
  if (/screenshot|vision|image.*not supported/.test(message)) return 'vision_unavailable';
  if (/invalid|bad request/.test(message)) return 'invalid_request';
  return 'unknown';
}

/** How the orchestrator should react (used for telemetry + health bookkeeping). */
export function recoveryStrategy(kind: FailureKind): {
  retrySameProvider: boolean;
  preferLocalNext: boolean;
  needsBiggerContext: boolean;
  needsVision: boolean;
  userActionRequired: boolean;
} {
  switch (kind) {
    case 'auth_failure':
      return { retrySameProvider: false, preferLocalNext: true, needsBiggerContext: false, needsVision: false, userActionRequired: true };
    case 'rate_limit':
      return { retrySameProvider: false, preferLocalNext: false, needsBiggerContext: false, needsVision: false, userActionRequired: false };
    case 'timeout':
      return { retrySameProvider: false, preferLocalNext: false, needsBiggerContext: false, needsVision: false, userActionRequired: false };
    case 'network_failure':
    case 'provider_offline':
      return { retrySameProvider: false, preferLocalNext: true, needsBiggerContext: false, needsVision: false, userActionRequired: false };
    case 'model_unavailable':
      return { retrySameProvider: true, preferLocalNext: false, needsBiggerContext: false, needsVision: false, userActionRequired: false };
    case 'context_too_large':
      return { retrySameProvider: false, preferLocalNext: false, needsBiggerContext: true, needsVision: false, userActionRequired: false };
    case 'vision_unavailable':
      return { retrySameProvider: false, preferLocalNext: false, needsBiggerContext: false, needsVision: true, userActionRequired: false };
    case 'invalid_request':
    case 'tool_call_failure':
      return { retrySameProvider: false, preferLocalNext: false, needsBiggerContext: false, needsVision: false, userActionRequired: false };
    default:
      return { retrySameProvider: false, preferLocalNext: false, needsBiggerContext: false, needsVision: false, userActionRequired: false };
  }
}

/** Human-readable one-liner for a failure kind (safe to show in UI). */
export function describeFailure(kind: FailureKind): string {
  const map: Record<FailureKind, string> = {
    network_failure: 'network unreachable',
    auth_failure: 'API key rejected — update it in Settings',
    rate_limit: 'free-tier rate limit hit — cooled down, using another brain',
    timeout: 'provider too slow — failed over',
    server_error: 'provider server error',
    model_unavailable: 'model unavailable right now',
    invalid_request: 'request rejected by provider',
    context_too_large: 'input too long for that model',
    tool_call_failure: 'tool call failed',
    vision_unavailable: 'model cannot process images',
    provider_offline: 'provider offline',
    unknown: 'unknown failure',
  };
  return map[kind];
}
