import {
  MistakeMemoryStore,
  MistakeRecord,
  defaultMistakeMemoryStore,
} from './MistakeMemoryStore';

/**
 * Error taxonomy used to decide how the engine reacts to a failure:
 *  - TRANSIENT: worth retrying as-is (network blip, GPU warmup, focus race).
 *  - AUTH: needs capability/authorization, not a code bug.
 *  - PARAM: arguments were structurally wrong — adjust and retry once.
 *  - ENV: missing dependency (Ollama down, browser not installed, OCR data).
 *  - UNKNOWN: nothing conclusive — reflect generically.
 */
export type ErrorClass = 'transient' | 'auth' | 'param' | 'env' | 'unknown';

export interface ReflectionResult {
  /** What was the goal (the tool + args that failed). */
  goalSummary: string;
  /** What error occurred (verbatim, truncated). */
  observedError: string;
  /** Classified root cause. */
  errorClass: ErrorClass;
  /** "Why did it fail" — best-effort human-readable analysis. */
  analysis: string;
  /** "What fix works" — actionable hint for the retry/next attempt. */
  correctiveHint: string;
  /** Adjusted arguments to use on the retry (if the engine can infer them). */
  adjustedArgs?: Record<string, unknown>;
  /** Should the caller immediately retry with adjusted args? */
  shouldRetry: boolean;
  /** Prior mistake this matched, if any. */
  matchedMistake?: MistakeRecord;
  confidence: number;
}

export interface PreFlightResult {
  /** False only when a known-fatal signature should block execution. */
  allowed: boolean;
  /** Hint injected into the execution context / planner prompt. */
  hint?: string;
  /** Args rewritten based on past failures (e.g. add focusApplication). */
  adjustedArgs?: Record<string, unknown>;
  /** The past mistake(s) that informed this result. */
  basedOn: MistakeRecord[];
}

export interface ReflectionContext {
  sessionId?: string;
  /** Free-form environment snapshot: open windows, active app, etc. */
  environment?: Record<string, unknown>;
}

/** Extracts the most informative line from a raw error string. */
function extractCoreError(error: string): string {
  const lines = error.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return 'unknown error';
  // Prefer lines that look like actual error messages.
  const meaningful = lines.find((l) => /error|fail|denied|not found|invalid|timeout|unable|cannot|refused|no such/i.test(l));
  return (meaningful || lines[0]).slice(0, 300);
}

function classify(errorText: string): ErrorClass {
  const text = errorText.toLowerCase();
  if (/unauthorized|not authorized|requires? authorization|requires user confirmation|permission|denied|capability/.test(text)) {
    return 'auth';
  }
  if (/invalid arguments|validation|schema|expected number|expected string|must be|missing required|parameter/.test(text)) {
    return 'param';
  }
  if (/not installed|enoent|command not found|spawn|module not found|ocr traineddata|chromium|executable|econnrefused|fetch failed|network|socket|timeout|etimedout/.test(text)) {
    return 'env';
  }
  if (/timeout|timed out|eagain|temporar|busy|locked|focus race|did not respond/.test(text)) {
    return 'transient';
  }
  return 'unknown';
}

/**
 * Well-known corrective heuristics. These encode the lessons that the
 * SERA codebase accumulated across its stabilization passes (documented
 * in the audit markdown files) — they double as seeds so the very first
 * occurrence of these classic mistakes already gets a good hint, and the
 * mistake memory refines them per-machine over time.
 */
const HEURISTICS: Array<{
  test: RegExp;
  analysis: string;
  hint: string;
  adjust?: (args: Record<string, unknown>) => Record<string, unknown>;
  errorClass?: ErrorClass;
}> = [
  {
    test: /no observable screen change|window (?:lost|does not have) focus|keystroke (?:went|landed)|not focused/i,
    analysis: 'The target application probably lost keyboard focus, so the input landed elsewhere (often the SERA window itself).',
    hint: 'Call focusWindow({application:"<target>"}) immediately before retrying the input, then re-send the keystrokes.',
    adjust: (args) => ({ ...args, focusApplication: args.focusApplication || args.application || undefined }),
  },
  {
    test: /window.*not found|no (?:visible )?window match|could not find (?:a )?window/i,
    analysis: 'Window enumeration did not find a matching visible window at execution time.',
    hint: 'Re-enumerate windows (listWindows), match by partial title/process name case-insensitively, or launch the application first with openApplication.',
  },
  {
    test: /ocr (?:failed|empty)|no text (?:found|recognized)|traineddata/i,
    analysis: 'OCR could not read the screen region (missing language data, low contrast, or scaled display).',
    hint: 'Capture a fresh screenshot first, ensure the window is restored (not minimized), and retry OCR; if DPI-scaled, prefer inspectScreen over raw OCR.',
    errorClass: 'env',
  },
  {
    test: /econnrefused|fetch failed|connect.*11434|ollama/i,
    analysis: 'A local service (most commonly the Ollama server on 127.0.0.1:11434) is not reachable.',
    hint: 'Verify the local engine is running (ollama serve / autostart) before retrying; switch to online mode if offline work is not required.',
    errorClass: 'env',
  },
  {
    test: /timeout|timed out|etimedout/i,
    analysis: 'The operation exceeded its time budget — typically a slow launch, a busy process, or a transient system stall.',
    hint: 'Retry once after a short delay; for application launches, poll for window readiness instead of failing fast.',
    errorClass: 'transient',
  },
  {
    test: /requires? authorization|requires user confirmation|capability "(?:computer_control|sensitive)/i,
    analysis: 'The tool is gated behind the computer-control capability for this session.',
    hint: 'Call setComputerControlAuthorization({authorized:true}) once per session; SERA auto-authorizes on connection, so this indicates a stale session id.',
    errorClass: 'auth',
  },
  {
    test: /clipboard (?:empty|unavailable)|open clipboard failed/i,
    analysis: 'Another process held the Windows clipboard open at the moment of access.',
    hint: 'Retry after a 150ms backoff; clipboard locks are brief and virtually always released on the second attempt.',
    errorClass: 'transient',
  },
];

/**
 * The Meta-Cognitive Self-Reflection engine.
 *
 * Loop responsibilities (spec section E):
 *  1. POST-MORTEM: on any tool/action failure, produce a structured
 *     ReflectionResult ("what was the goal / what error / why / what fix").
 *  2. MEMORY: persist the failure + workaround into MistakeMemoryStore.
 *  3. PRE-FLIGHT: before any execution, check mistake memory ("have I
 *     failed this before? what worked last time?") and optionally rewrite
 *     the arguments to avoid the known trap.
 */
export class ErrorReflectionEngine {
  constructor(private readonly store: MistakeMemoryStore = defaultMistakeMemoryStore) {}

  /**
   * Pre-flight anti-regression check. Called by ToolManager BEFORE the
   * tool executes. Given the tool name + raw args, it consults mistake
   * memory for prior failures of the same tool and returns a hint plus
   * optionally adjusted arguments from classic-failure heuristics.
   */
  public preFlightCheck(toolName: string, args: unknown, context?: ReflectionContext): PreFlightResult {
    const argRecord = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const operation = typeof argRecord.operation === 'string' ? String(argRecord.operation) : '';
    const probeText = `${toolName} ${operation} ${JSON.stringify(argRecord)}`.slice(0, 400);

    // 1. Lessons learned for this exact tool (most recent first).
    //    Workarounds are known; failures without a known fix are still
    //    surfaced so Sera avoids repeating the same trap.
    const related = this.store
      .all()
      .filter((m) => m.toolName === toolName)
      .sort((a, b) => {
        if (Boolean(a.successfulWorkaround) !== Boolean(b.successfulWorkaround)) {
          return a.successfulWorkaround ? -1 : 1;
        }
        return b.lastSeenAt - a.lastSeenAt;
      })
      .slice(0, 2);

    // 2. Classic-failure heuristics can adjust args proactively.
    for (const heuristic of HEURISTICS) {
      if (!heuristic.test.test(probeText)) continue;
      // Only fire the focus-related heuristic when the user targets an app.
      if (/focus/i.test(heuristic.analysis) && !argRecord.application && !argRecord.focusApplication && !argRecord.windowHandle) {
        continue;
      }
      return {
        allowed: true,
        hint: `${heuristic.hint}${related.length ? ` (learned from ${related.length} past occurrence(s))` : ''}`,
        adjustedArgs: heuristic.adjust ? heuristic.adjust(argRecord) : undefined,
        basedOn: related,
      };
    }

    if (related.length === 0) {
      return { allowed: true, basedOn: [] };
    }

    const best = related[0];
    return {
      allowed: true,
      hint: best.successfulWorkaround
        ? `Known past failure with ${toolName}: ${best.rootCause}. What worked last time: ${best.successfulWorkaround}`
        : `Known past failure with ${toolName}: ${best.rootCause}. Avoid repeating it.`,
      adjustedArgs: undefined,
      basedOn: related,
    };
  }

  /**
   * Post-mortem reflection. Called by ToolManager AFTER a tool fails.
   * Produces the structured analysis, persists the lesson, and computes
   * whether a retry (possibly with adjusted args) is worth attempting.
   */
  public reflect(
    toolName: string,
    rawArgs: unknown,
    error: string,
    context?: ReflectionContext,
  ): ReflectionResult {
    const argRecord = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
    const observedError = extractCoreError(error);
    const errorClass = classify(observedError);
    const goalSummary = `${toolName}(${JSON.stringify(argRecord).slice(0, 180)})`;

    // Consult memory first — the machine may have seen this before.
    const exact = this.store.findExact(toolName, observedError, argRecord);
    const similar = exact ? [] : this.store.query(`${toolName} ${observedError}`, 2);
    const matchedMistake = exact || similar[0]?.record;

    let analysis: string;
    let correctiveHint: string;
    let adjustedArgs: Record<string, unknown> | undefined;
    let shouldRetry = false;

    const heuristic = HEURISTICS.find((h) => h.test.test(observedError) || (matchedMistake && h.test.test(matchedMistake.rootCause)));

    if (exact?.successfulWorkaround) {
      analysis = `Exact failure signature seen ${exact.occurrences} time(s) before: ${exact.rootCause}`;
      correctiveHint = `Reuse the proven workaround: ${exact.successfulWorkaround}`;
      shouldRetry = errorClass === 'transient' || errorClass === 'param';
    } else if (matchedMistake?.successfulWorkaround) {
      analysis = `Similar past failure: ${matchedMistake.rootCause}`;
      correctiveHint = `Previously successful workaround: ${matchedMistake.successfulWorkaround}`;
      shouldRetry = errorClass === 'transient';
    } else if (heuristic) {
      analysis = heuristic.analysis;
      correctiveHint = heuristic.hint;
      adjustedArgs = heuristic.adjust ? heuristic.adjust(argRecord) : undefined;
      shouldRetry = heuristic.errorClass !== 'env' && heuristic.errorClass !== 'auth';
    } else {
      switch (errorClass) {
        case 'auth':
          analysis = 'The failure is an authorization gate, not a logic error.';
          correctiveHint = 'Grant the computer-control capability via setComputerControlAuthorization, then retry.';
          break;
        case 'param':
          analysis = 'The tool rejected its arguments (validation layer).';
          correctiveHint = 'Re-derive the arguments from fresh perception (listWindows/inspectScreen) instead of reusing stale values; ensure numeric coordinates and non-empty text.';
          shouldRetry = true;
          break;
        case 'env':
          analysis = 'A required environment dependency is missing or unreachable.';
          correctiveHint = 'Run system diagnostics (run_system_diagnostics) and repair the affected subsystem before retrying.';
          break;
        case 'transient':
          analysis = 'The failure looks transient (timing/lock/race).';
          correctiveHint = 'Retry once with a short backoff; verify the outcome via perception before escalating.';
          shouldRetry = true;
          break;
        default:
          analysis = 'No prior signature matched this failure.';
          correctiveHint = 'Capture a screenshot + window list, then retry with corrected parameters or choose an alternative tool path.';
          shouldRetry = true;
      }
    }

    // Persist the lesson (workaround may arrive later via recordWorkaround).
    this.store.record({
      toolName,
      error: observedError,
      rootCause: matchedMistake && !heuristic ? matchedMistake.rootCause : analysis,
      successfulWorkaround: exact?.successfulWorkaround,
      context: {
        args: argRecord,
        sessionId: context?.sessionId,
        environment: context?.environment,
        errorClass,
      },
    });

    return {
      goalSummary,
      observedError,
      errorClass,
      analysis,
      correctiveHint,
      adjustedArgs,
      shouldRetry,
      matchedMistake,
      confidence: exact ? 0.9 : matchedMistake ? 0.6 : heuristic ? 0.7 : 0.3,
    };
  }

  /**
   * Called when a retried attempt finally SUCCEEDS — closes the learning
   * loop by storing what actually worked.
   */
  public learnWorkaround(toolName: string, originalError: string, workaround: string, args?: unknown): void {
    this.store.recordWorkaround(toolName, originalError, workaround, args ? { args } : undefined);
  }

  /** Most recent lessons, for surfacing in the UI / diagnostics. */
  public recentLessons(limit = 5): MistakeRecord[] {
    return this.store
      .all()
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, limit);
  }

  /**
   * Total number of retained lessons. v1.6.11: the API layer previously
   * called `recentLessons(Number.MAX_SAFE_INTEGER).length` to count them —
   * cloning and sorting the entire mistake memory on every request.
   */
  public lessonCount(): number {
    return this.store.size();
  }
}

export const defaultErrorReflectionEngine = new ErrorReflectionEngine();
