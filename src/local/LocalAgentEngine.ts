import { ToolManager } from '../tools/ToolManager';
import { defaultMemoryManager } from '../memory/MemoryManager';
import { defaultErrorReflectionEngine } from '../learning';
import { OllamaClient, OllamaChatMessage, defaultOllamaClient } from './OllamaClient';

/**
 * Tool call event forwarded to the client over WebSocket — mirrors the
 * Gemini Live tool_call / tool_result payload shapes so the frontend can
 * render local-mode tool activity identically.
 */
export interface LocalAgentEvent {
  type: 'transcript' | 'tool_call' | 'tool_result' | 'browser_action' | 'error' | 'status';
  [key: string]: unknown;
}

/**
 * Converts SERA's Gemini-style tool declarations to Ollama's function
 * calling format (OpenAI-compatible "type: function" wrappers).
 */
export function toOllamaToolDeclarations(toolManager: ToolManager): unknown[] {
  return toolManager.getAllTools().map((tool) => {
    const properties: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(tool.parameters.properties)) {
      const entry: Record<string, unknown> = { type: prop.type.toLowerCase(), description: prop.description };
      if (prop.enum) entry.enum = prop.enum;
      if (prop.items) entry.items = { type: prop.items.type.toLowerCase() };
      if (prop.properties) {
        entry.properties = Object.fromEntries(
          Object.entries(prop.properties).map(([k, nested]) => [k, { type: nested.type.toLowerCase(), description: nested.description }]),
        );
      }
      if (prop.required) entry.required = prop.required;
      properties[key] = entry;
    }
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties,
          required: tool.parameters.required || [],
        },
      },
    };
  });
}

/**
 * Small local models sometimes emit a tool call as a plain JSON string in
 * `message.content` instead of using the native tool_calls array — the
 * real-world log showed `{"name":"sayHello","parameters":{"text":"…"}}`
 * where "sayHello" is not even a real SERA tool. Detect that shape so the
 * engine can either execute the intended tool or salvage the spoken text,
 * instead of showing raw JSON to the user and speaking it aloud.
 */
export function parseTextualToolCall(content: string): { name: string; arguments: Record<string, unknown> } | null {
  const trimmed = content.trim();
  if (trimmed.length < 8 || !trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const fn = parsed.function as { name?: unknown; arguments?: unknown } | undefined;
  const name = typeof parsed.name === 'string'
    ? parsed.name
    : typeof parsed.tool === 'string'
      ? parsed.tool
      : typeof fn?.name === 'string'
        ? fn.name
        : null;
  if (!name) return null;
  const rawArgs = parsed.parameters ?? parsed.args ?? fn?.arguments ?? parsed.arguments ?? {};
  if (typeof rawArgs === 'string') {
    try {
      const parsedArgs = JSON.parse(rawArgs);
      return { name, arguments: parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs) ? parsedArgs as Record<string, unknown> : { text: String(rawArgs) } };
    } catch {
      return { name, arguments: { text: rawArgs } };
  }
  }
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    return { name, arguments: rawArgs as Record<string, unknown> };
  }
  return { name, arguments: {} };
}

/* ------------------------------------------------------------------ */
/* Desktop-control safety guard                                        */
/* ------------------------------------------------------------------ */

/**
 * Real-world bug report: "random things keep getting copied into my
 * clipboard after I start SERA." Root cause: a small local model
 * hallucinated a keyboard shortcut tool call (control+c), SERA pressed
 * it on the user's desktop, and the OS copied whatever text happened to
 * be selected. Keyboard input and clipboard writes are destructive when
 * unsolicited — they land in whatever window has focus.
 *
 * The guard allows these tools ONLY when the user's own words in the
 * current utterance clearly ask for keyboard / clipboard action. Mouse
 * input (click/scroll/move/drag) stays ungated — visual automation is
 * the established local-mode workflow.
 */
const KEYBOARD_INPUT_TOOLS = new Set(['controlComputerInput']);
const CLIPBOARD_WRITE_TOOLS = new Set(['setClipboard', 'pasteClipboard', 'saveClipboard', 'restoreClipboard']);
const KEYBOARD_OPERATIONS = new Set(['type', 'press', 'hotkey']);

/** Utterance phrases that legitimately request keyboard/clipboard action. */
const DESKTOP_INTENT_RE = new RegExp(
  [
    '\\b(cop(?:y|ied|ying)|paste[dS]?|cut(?:ting)?|clipboard)\\b',
    '\\b(press(?:ed|es|ing)?|hotkey|hot\\s+key|shortcut|keyboard|key\\s?stroke)\\b',
    '\\b(ctrl|control\\s*[+-]?\\s*c|control\\s*[+-]?\\s*v|control\\s*[+-]?\\s*x|control\\s*alt|select\\s+all)\\b',
    '\\b(type|typing|wrote|write|writing)\\b',
    '\\b(enter|fill\\s+in|write\\s+into)\\b',
  ].join('|'),
  'i',
);

/**
 * Returns a block reason when a tool call touches the keyboard or the
 * clipboard without an explicit request in the user's utterance, or null
 * when the call may proceed.
 */
export function desktopControlGuardBlock(
  toolName: string,
  args: Record<string, unknown>,
  utterance: string | undefined,
): string | null {
  const isKeyboardTool = KEYBOARD_INPUT_TOOLS.has(toolName);
  const isClipboardTool = CLIPBOARD_WRITE_TOOLS.has(toolName);
  if (!isKeyboardTool && !isClipboardTool) return null;

  if (isKeyboardTool) {
    const operation = String((args as { operation?: unknown }).operation || '').toLowerCase();
    // Only gate keyboard operations — mouse automation stays allowed.
    if (!KEYBOARD_OPERATIONS.has(operation)) return null;
  }

  if (utterance && DESKTOP_INTENT_RE.test(utterance)) return null;
  return (
    'Blocked by the desktop-control safety guard: SERA only presses keys or modifies the clipboard when your own words clearly ask for it '
    + '(for example "press control c", "copy this to the clipboard", "type hello into notepad"). '
    + 'Do not retry automatically — ask the user which exact keys or clipboard action they want, or simply answer in words.'
  );
}

/**
 * The Local Agent Engine — SERA's 100% offline brain.
 *
 * Replaces the Gemini Live reasoning loop when running in Local Mode:
 *   user text → persistent memory recall → Ollama chat (with the full
 *   SERA tool catalog exposed as native function tools) → tool execution
 *   through ToolManager (with the mistake-learning pre-flight +
 *   reflection pipeline) → iterative refinement → final spoken reply.
 */
export class LocalAgentEngine {
  private readonly ollama: OllamaClient;
  private readonly toolManager: ToolManager;
  private readonly maxIterations: number;
  private histories = new Map<string, OllamaChatMessage[]>();
  /**
   * v1.6.11: every WS local session gets a unique session-<ts>-<rand> id and
   * the server never calls clearHistory — entries (24 messages each) used to
   * accumulate for the entire process lifetime. The map is now capped with
   * oldest-session eviction (each entry is re-inserted on use, so active
   * sessions are never the eviction victim).
   */
  private readonly maxSessions: number;
  private systemInstruction: string;

  constructor(
    toolManager: ToolManager,
    ollama: OllamaClient = defaultOllamaClient,
    options: { maxIterations?: number; systemInstruction?: string; maxSessions?: number } = {},
  ) {
    this.toolManager = toolManager;
    this.ollama = ollama;
    this.maxIterations = options.maxIterations ?? 6;
    this.maxSessions = options.maxSessions ?? 32;
    this.systemInstruction = options.systemInstruction ?? '';
  }

  public setSystemInstruction(instruction: string): void {
    this.systemInstruction = instruction;
  }

  public getModel(model?: string): string {
    return model || process.env.SERA_LOCAL_MODEL || 'llama3.2:3b-instruct-q4_K_M';
  }

  /** Session history size (diagnostics). */
  public historyLength(sessionId: string): number {
    return this.histories.get(sessionId)?.length ?? 0;
  }

  public clearHistory(sessionId: string): void {
    this.histories.delete(sessionId);
  }

  /** v1.6.11: LRU bookkeeping — re-inserting a key refreshes its recency. */
  private touchHistory(sessionId: string, history: OllamaChatMessage[]): void {
    this.histories.delete(sessionId);
    this.histories.set(sessionId, history);
    while (this.histories.size > this.maxSessions) {
      const oldestKey = this.histories.keys().next().value;
      if (oldestKey === undefined) break;
      this.histories.delete(oldestKey);
    }
  }

  /**
   * Runs one full agent turn. Yields events (transcript deltas, tool
   * calls/results) so the server can stream them to the client live,
   * and resolves with the final spoken reply.
   */
  public async processTurn(
    sessionId: string,
    userText: string,
    options: {
      model?: string;
      emit?: (event: LocalAgentEvent) => void;
      speakerId?: string;
      /** Stable authorization ID (auth-...) used for tool capability
       * checks. Falls back to the ephemeral sessionId when absent —
       * which would deny capability-gated tools, so callers (server.ts)
       * pass the same authorizationId the online mode uses. */
      toolSessionId?: string;
      /** The raw user utterance this turn came from — powers the
       * desktop-control guard (keyboard/clipboard need explicit intent). */
      utterance?: string;
    } = {},
  ): Promise<{ reply: string; iterations: number; toolCallsExecuted: number; blockedToolCalls: number }> {
    const emit = options.emit || (() => undefined);
    const model = this.getModel(options.model);

    // 0. Deterministic quick commands: "open youtube", "search cats",
    //    "play lofi on spotify" are executed directly through the tool
    //    layer — no LLM round-trip. A 3B local model unreliably emits
    //    tool calls (real-world log: toolCallsExecuted: 0 on every
    //    turn), so simple everyday commands MUST NOT depend on it. If
    //    the rule doesn't match or the tool fails, fall through to the
    //    normal Ollama agent loop below.
    const quick = await this.tryQuickCommand(sessionId, userText, options);
    if (quick) return quick;

    // 1. Semantic + keyword memory recall, injected into the system prompt.
    let memoryBlock = '';
    try {
      const recalled = await defaultMemoryManager.recall(userText, 3);
      memoryBlock = recalled.length
        ? `\n\n[PERSISTENT USER CONTEXT]\n${recalled.map(({ item }) => `- [${item.category}] ${item.fact}`).join('\n')}`
        : '';
    } catch {
      memoryBlock = '';
    }

    const systemPrompt = `${this.systemInstruction}${memoryBlock}\n\nYou are running 100% locally on the user's machine. Use the provided tools to actually perform desktop actions. When you intend to call a tool, emit the native tool call — never invent results. After tool results arrive, verify them before claiming success.`;

    const history = this.histories.get(sessionId) || [];
    history.push({ role: 'user', content: userText });

    const tools = toOllamaToolDeclarations(this.toolManager);
    let iterations = 0;
    let toolCallsExecuted = 0;
    let blockedToolCalls = 0;
    let finalReply = '';

    try {
      for (iterations = 1; iterations <= this.maxIterations; iterations++) {
        const response = await this.ollama.chat({
          model,
          messages: [{ role: 'system', content: systemPrompt }, ...history],
          tools,
          temperature: 0.4,
        });

        // Salvage tool calls the model wrote as a plain JSON string instead
        // of using the native tool_calls array. Raw JSON must never reach
        // the chat bubble or the speaker.
        const textualCall = parseTextualToolCall(response.content);
        if (textualCall) {
          if (this.toolManager.getTool(textualCall.name)) {
            // Real tool — route it through the native tool-call path below
            // so it executes, emits events, and the model can speak after
            // seeing the result.
            response.toolCalls.push({ name: textualCall.name, arguments: textualCall.arguments });
            response.content = '';
          } else if (typeof textualCall.arguments.text === 'string' && textualCall.arguments.text.trim()) {
            // Hallucinated tool whose parameters carry the intended line —
            // that text IS the reply (e.g. sayHello → "Hey, I'm here!").
            response.content = textualCall.arguments.text.trim();
          } else {
            response.content = "I'm here and listening — could you tell me in a bit more detail?";
          }
        }

        if (response.content.trim()) {
          finalReply = response.content.trim();
          emit({ type: 'transcript', sender: 'sera', text: finalReply, isPartial: false });
        }

        if (response.toolCalls.length === 0) {
          history.push({ role: 'assistant', content: response.content });
          break;
        }

        // Assistant message that triggered tool calls must be preserved
        // so Ollama can correlate the following tool results.
        history.push({
          role: 'assistant',
          content: response.content || '',
          ...(response.toolCalls.length
            ? {
                tool_calls: response.toolCalls.map((call) => ({
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        });

        for (const call of response.toolCalls) {
          const callId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          emit({ type: 'tool_call', id: callId, name: call.name, args: call.arguments });

          // Desktop-control guard: keyboard presses and clipboard writes
          // execute only when the user's own words asked for them. This is
          // what stops a hallucinated control+c from silently replacing the
          // user's clipboard with whatever text they had selected.
          const blockReason = desktopControlGuardBlock(call.name, call.arguments, options.utterance || userText);
          if (blockReason) {
            blockedToolCalls += 1;
            console.warn(`[SERA-LOCAL] 🛡 Blocked unsolicited desktop-control call: ${call.name}`);
            emit({
              type: 'tool_result',
              id: callId,
              name: call.name,
              success: false,
              error: blockReason,
              reflection: {
                analysis: 'Desktop-control safety guard',
                correctiveHint: 'Never retry keyboard or clipboard tools on your own. Ask the user to say exactly which keys to press or what to copy/paste.',
                shouldRetry: false,
              },
            });
            history.push({
              role: 'tool',
              content: JSON.stringify({ ok: false, error: blockReason }).slice(0, 2000),
            });
            continue;
          }

          const result = await this.toolManager.executeTool(call.name, call.arguments, {
            sessionId: options.toolSessionId || sessionId,
            executionId: `${sessionId}:${callId}`,
            speakerId: options.speakerId,
          });
          toolCallsExecuted += 1;

          // Learning loop: reflect on failure, learn the workaround on success.
          if (!result.success && result.error) {
            const reflection = defaultErrorReflectionEngine.reflect(call.name, call.arguments, result.error, { sessionId });
            emit({
              type: 'tool_result',
              id: callId,
              name: call.name,
              success: false,
              error: result.error,
              reflection: {
                analysis: reflection.analysis,
                correctiveHint: reflection.correctiveHint,
                shouldRetry: reflection.shouldRetry,
              },
            });
          } else {
            emit({
              type: 'tool_result',
              id: callId,
              name: call.name,
              success: true,
              data: sanitizeToolData(result.data),
            });
          }

          history.push({
            role: 'tool',
            content: JSON.stringify(result.success ? { ok: true, data: sanitizeToolData(result.data) } : { ok: false, error: result.error }).slice(0, 6000),
          });

          // Browser popups: mirror the online-mode behavior.
          if (result.success && (call.name === 'openWebsite' || call.name === 'browserOpen' || call.name === 'browserNavigate')) {
            const data = result.data as { url?: string; domain?: string; siteName?: string } | undefined;
            if (data?.url) {
              emit({
                type: 'browser_action',
                id: callId,
                action: 'open_url',
                url: data.url,
                domain: data.domain || '',
                siteName: data.siteName || data.domain || 'Website',
              });
            }
          }
        }
      }

      if (iterations > this.maxIterations) {
        finalReply = finalReply || 'I hit my internal step limit while working on that. Here is where things stand — ask me to continue if you want me to keep going.';
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: 'error', error: message });
      finalReply = `Local engine error: ${message}`;
    }

    this.touchHistory(sessionId, trimHistory(history));
    return { reply: finalReply, iterations, toolCallsExecuted, blockedToolCalls };
  }

  /**
   * Deterministic offline intents — the voice fast-path from the spec
   * ("simple commands must not need the big model"). Runs the matching
   * tool directly through ToolManager, emits the same tool_call /
   * tool_result / browser_action events the UI already renders, and
   * returns the spoken result. Returns null when the text is not a
   * simple command (or the tool failed) so the normal LLM loop takes
   * over.
   */
  private async tryQuickCommand(
    sessionId: string,
    userText: string,
    options: {
      emit?: (event: LocalAgentEvent) => void;
      speakerId?: string;
      toolSessionId?: string;
    },
  ): Promise<{ reply: string; iterations: number; toolCallsExecuted: number; blockedToolCalls: number } | null> {
    const emit = options.emit || (() => undefined);
    // Strip a leading wake address ("hey sera, open youtube") and
    // trailing punctuation, then lowercase for matching.
    const text = userText
      .trim()
      .replace(/^(?:hey|hi|yo|ok|okay|please)?\s*,?\s*sera\s*[,:-]\s*/i, '')
      .replace(/[.!]+$/, '')
      .trim()
      .toLowerCase();
    if (!text) return null;

    // ── wake-word greeting ───────────────────────────────────────
    // The wake flow opens every pure-voice session with "someone just
    // called your name … say a short, warm greeting". A 3B model handles
    // that prompt badly (real-world log: it answered with a raw
    // {"name":"sayHello",…} JSON blob that was then displayed and spoken
    // character by character). A greeting needs zero reasoning — answer
    // deterministically and keep the moment natural.
    if (text.includes('someone just called your name') || (text.includes('greet') && text.includes('listening'))) {
      const greetings = [
        "Hey, I'm here. What's up?",
        "I'm listening — go ahead!",
        "Hey! What can I do for you?",
        "Yes? I'm all ears.",
        "Here! What do you need?",
        "I hear you — what's next?",
      ];
      const reply = greetings[Math.floor(Math.random() * greetings.length)];
      const greetingHistory = this.histories.get(sessionId) || [];
      greetingHistory.push({ role: 'user', content: userText });
      greetingHistory.push({ role: 'assistant', content: reply });
      this.touchHistory(sessionId, trimHistory(greetingHistory));
      emit({ type: 'transcript', sender: 'sera', text: reply, isPartial: false });
      return { reply, iterations: 0, toolCallsExecuted: 0, blockedToolCalls: 0 };
    }

    const runTool = async (
      name: string,
      args: Record<string, unknown>,
      composeReply: (data: Record<string, unknown> | undefined, userMessage?: string) => string,
    ): Promise<{ reply: string; iterations: number; toolCallsExecuted: number; blockedToolCalls: number } | null> => {
      const callId = `local-quick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      emit({ type: 'tool_call', id: callId, name, args });
      const result = await this.toolManager.executeTool(name, args, {
        sessionId: options.toolSessionId || sessionId,
        executionId: `${sessionId}:${callId}`,
        speakerId: options.speakerId,
      });
      const data = (result.success ? result.data : undefined) as Record<string, unknown> | undefined;
      emit({
        type: 'tool_result',
        id: callId,
        name,
        success: result.success,
        ...(result.success ? { data: sanitizeToolData(result.data) } : { error: result.error }),
      });
      if (!result.success) return null; // fall through to the LLM loop

      // Browser popups: mirror the main-loop behaviour so the client UI
      // can show what was opened.
      if ((name === 'openWebsite' || name === 'openApplication' || name === 'searchWeb') && data?.url) {
        emit({
          type: 'browser_action',
          id: callId,
          action: 'open_url',
          url: data.url,
          domain: data.domain || '',
          siteName: data.siteName || data.domain || 'Website',
        });
      }

      const reply = composeReply(data, typeof result.userMessage === 'string' ? result.userMessage : undefined);
      const history = this.histories.get(sessionId) || [];
      history.push({ role: 'user', content: userText });
      history.push({ role: 'assistant', content: reply });
      this.touchHistory(sessionId, trimHistory(history));
      emit({ type: 'transcript', sender: 'sera', text: reply, isPartial: false });
      return { reply, iterations: 1, toolCallsExecuted: 1, blockedToolCalls: 0 };
    };

    // ── open / launch / go to / visit ──────────────────────────────
    // Keep the guard tight: short, single-clause targets only — long
    // or compound sentences belong to the LLM.
    const openMatch = text.match(/^(?:open|launch|go\s+to|visit)\s+(.+)$/);
    if (openMatch) {
      const target = openMatch[1].replace(/^(?:the|my)\s+/, '').trim();
      if (target && target.split(/\s+/).length <= 6 && !/\b(?:and|then|while|after)\b/.test(target)) {
        return runTool('openApplication', { application: target }, (data, userMessage) =>
          userMessage || `Opening ${data?.displayName || data?.siteName || target}.`);
      }
    }

    // ── "search youtube for X" style engine-first searches ─────────
    const engineFirst = text.match(/^(?:search|look\s+up)\s+(youtube|reddit|wikipedia|bing|duckduckgo)\s+for\s+(.+)$/);
    if (engineFirst) {
      return runTool('searchWeb', { query: engineFirst[2], engine: engineFirst[1] }, (_data, userMessage) =>
        userMessage || `Searching ${engineFirst[1]} for ${engineFirst[2]}.`);
    }

    // ── "search for X (on engine)?" ────────────────────────────────
    const searchMatch = text.match(/^(?:search(?:\s+for)?|look\s+up|google)\s+(.+?)(?:\s+on\s+(youtube|reddit|wikipedia|bing|duckduckgo))?$/);
    if (searchMatch) {
      const query = searchMatch[1].trim();
      const engine = searchMatch[2];
      if (query.split(/\s+/).length <= 12) {
        return runTool('searchWeb', engine ? { query, engine } : { query }, (_data, userMessage) =>
          userMessage || `Searching for ${query}.`);
      }
    }

    // ── "play X" / "play X on youtube" / "play X on spotify" ───────
    const playMatch = text.match(/^play\s+(.+?)(?:\s+on\s+(youtube|spotify))?$/);
    if (playMatch) {
      const what = playMatch[1].trim();
      const where = playMatch[2];
      if (where === 'spotify') {
        return runTool('openApplication', { application: 'spotify' }, (_data, userMessage) =>
          userMessage || 'Opening Spotify — pick your track there.');
      }
      return runTool('searchWeb', { query: what, engine: 'youtube' }, (_data, userMessage) =>
        userMessage || `Here are YouTube results for ${what}.`);
    }

    return null;
  }
}

/** Strips heavy binary payloads before they enter model context. */
function sanitizeToolData(data: unknown): unknown {
  if (data && typeof data === 'object' && typeof (data as Record<string, unknown>).data === 'string') {
    const { data: heavy, ...rest } = data as Record<string, unknown>;
    if (typeof heavy === 'string' && heavy.length > 256) return { ...rest, dataTruncated: true };
    return data;
  }
  return data;
}

/**
 * Keeps conversation memory bounded (last 24 messages).
 * v1.6.11: after slicing, a leading `tool` message (whose tool_calls partner
 * was cut off) breaks Ollama's message correlation — dropped until the first
 * non-tool message.
 */
function trimHistory(history: OllamaChatMessage[]): OllamaChatMessage[] {
  if (history.length <= 24) return history;
  const trimmed = history.slice(-24);
  const firstNonTool = trimmed.findIndex((m) => m.role !== 'tool');
  return firstNonTool > 0 ? trimmed.slice(firstNonTool) : trimmed;
}
