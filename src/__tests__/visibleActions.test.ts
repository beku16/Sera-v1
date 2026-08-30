import { describe, it, expect, vi } from 'vitest';

import { EventEmitter } from 'node:events';
import {
  BrowserExecutor,
  defaultBrowserOpenCommand,
  openUrlInDefaultBrowser,
} from '../actions/BrowserExecutor';
import { openWebsiteTool } from '../tools/tools/openWebsite';
import { searchWebTool } from '../tools/tools/searchWeb';
import { openApplicationTool } from '../tools/tools/openApplication';
import { LocalAgentEngine } from '../local/LocalAgentEngine';
import type { ToolManager } from '../tools/ToolManager';
import type { ActionManager } from '../actions/ActionManager';

/* ────────────────────────────────────────────────────────────────── */
/* Helpers                                                             */
/* ────────────────────────────────────────────────────────────────── */

/** Fake ActionManager that records requested actions and answers with
 * a scripted status per action type. */
function makeFakeActionManager(script: Record<string, 'succeeded' | 'failed'> = {}) {
  const requested: Array<{ type: string; parameters: Record<string, unknown> }> = [];
  const manager = {
    createAction: vi.fn((input: { type: string; parameters: Record<string, unknown> }) => ({
      taskId: 'task-1',
      actionId: `action-${requested.length + 1}`,
      type: input.type,
      parameters: input.parameters,
      status: 'queued',
      createdAt: new Date().toISOString(),
    })),
    execute: vi.fn(async (action: { type: string; parameters: Record<string, unknown> }) => {
      requested.push({ type: action.type, parameters: action.parameters });
      const status = script[action.type] ?? 'succeeded';
      return status === 'succeeded'
        ? { status, result: { url: action.parameters.url } }
        : { status, error: { message: `${action.type} failed (scripted)` } };
    }),
  };
  return { manager: manager as unknown as ActionManager, requested, raw: manager };
}

/** Fake ToolManager that records executeTool calls and answers from a
 * script keyed by tool name. `knownTools` controls what getTool() reports
 * as a real, registered tool (used by the textual tool-call recovery). */
function makeFakeToolManager(script: Record<string, { success: boolean; data?: unknown; error?: string; userMessage?: string }>, knownTools: string[] = []) {
  const calls: Array<{ name: string; args: Record<string, unknown>; contextSessionId?: string }> = [];
  const fake = {
    executeTool: vi.fn(async (name: string, args: unknown, context?: { sessionId?: string }) => {
      const call = { name, args: args as Record<string, unknown>, contextSessionId: context?.sessionId };
      calls.push(call);
      const entry = script[name];
      return entry ?? { success: false, error: `no script for ${name}` };
    }),
    getAllTools: vi.fn(() => []),
    getTool: vi.fn((name: string) => (knownTools.includes(name) ? { name } : undefined)),
  };
  return { toolManager: fake as unknown as ToolManager, calls, raw: fake };
}

/** Fake OllamaClient - fails the test if the LLM is ever called. */
function makeForbiddenOllama() {
  return {
    chat: vi.fn(async () => {
      throw new Error('LLM must NOT be called for quick commands');
    }),
  };
}

function makeOllamaReplying(reply: string) {
  return { chat: vi.fn(async () => ({ content: reply, toolCalls: [] })) };
}

/** A spawn double: records invocations, never actually spawns. */
function makeSpawnDouble() {
  const invoked: Array<{ cmd: string; args: string[] }> = [];
  const fn = vi.fn(((cmd: string, args: string[]) => {
    invoked.push({ cmd, args });
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    return child;
  }) as unknown as import('../actions/BrowserExecutor').UrlSpawnFn);
  return { fn, invoked };
}

/* ────────────────────────────────────────────────────────────────── */
/* OS default-browser open (BrowserExecutor)                           */
/* ────────────────────────────────────────────────────────────────── */

describe('defaultBrowserOpenCommand', () => {
  it('maps win32 to rundll32 FileProtocolHandler (no cmd.exe parsing quirks)', () => {
    const command = defaultBrowserOpenCommand('win32');
    expect(command?.cmd).toBe('rundll32');
    expect(command?.args[0]).toBe('url.dll,FileProtocolHandler');
  });

  it('maps darwin to open and linux to xdg-open', () => {
    expect(defaultBrowserOpenCommand('darwin')?.cmd).toBe('open');
    expect(defaultBrowserOpenCommand('linux')?.cmd).toBe('xdg-open');
    expect(defaultBrowserOpenCommand('sunos')).toBeNull();
  });
});

describe('openUrlInDefaultBrowser', () => {
  it('substitutes the URL and fires the OS command', () => {
    const { fn, invoked } = makeSpawnDouble();
    openUrlInDefaultBrowser('https://www.youtube.com/', 'win32', fn);
    expect(invoked).toHaveLength(1);
    expect(invoked[0].cmd).toBe('rundll32');
    expect(invoked[0].args).toContain('https://www.youtube.com/');
  });

  it('rejects non-http(s) protocols', () => {
    const { fn, invoked } = makeSpawnDouble();
    expect(() => openUrlInDefaultBrowser('file:///C:/Windows/System32', 'win32', fn)).toThrow(/http\/https/);
    expect(() => openUrlInDefaultBrowser('javascript:alert(1)', 'linux', fn)).toThrow(/http\/https/);
    expect(invoked).toHaveLength(0);
  });

  it('throws on unsupported platforms so callers can fall back', () => {
    expect(() => openUrlInDefaultBrowser('https://x.com', 'sunos', makeSpawnDouble().fn)).toThrow(/not supported/);
  });
});

describe('BrowserExecutor browser.openDefault', () => {
  it('opens via the OS and reports success', () => {
    const executor = new BrowserExecutor();
    const result = executor.execute({
      taskId: 't', actionId: 'a', type: 'browser.openDefault',
      parameters: { url: 'https://www.youtube.com/' }, status: 'queued', createdAt: new Date().toISOString(),
    } as never, {} as never);
    // On this Linux CI host xdg-open may be absent; both a success and a
    // well-formed ActionError are acceptable, but it must never hang or
    // touch the managed session.
    expect(result).toBeInstanceOf(Promise);
  });

  it('rejects dangerous protocols before spawning', async () => {
    const executor = new BrowserExecutor();
    await expect(executor.execute({
      taskId: 't', actionId: 'a', type: 'browser.openDefault',
      parameters: { url: 'file:///etc/passwd' }, status: 'queued', createdAt: new Date().toISOString(),
    } as never, {} as never)).rejects.toThrow(/default browser/i);
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* openWebsite - the VISIBLE open                                      */
/* ────────────────────────────────────────────────────────────────── */

describe('openWebsite visible-open policy', () => {
  it('routes through browser.openDefault first (user sees the page)', async () => {
    const { manager, requested } = makeFakeActionManager();
    const result = await openWebsiteTool.execute({ url: 'youtube' }, { sessionId: 's', executionId: 'e', actionManager: manager } as never);
    expect(result.success).toBe(true);
    expect(requested[0].type).toBe('browser.openDefault');
    expect(requested[0].parameters.url).toBe('https://www.youtube.com/');
    const data = result.data as { openedVia?: string; opened?: boolean };
    expect(data.openedVia).toBe('default-browser');
    expect(data.opened).toBe(true);
    expect((result.userMessage || '')).toMatch(/default browser/i);
  });

  it('falls back to the managed browser when the OS open fails', async () => {
    const { manager, requested } = makeFakeActionManager({ 'browser.openDefault': 'failed' });
    const result = await openWebsiteTool.execute({ url: 'github.com' }, { sessionId: 's', executionId: 'e', actionManager: manager } as never);
    expect(result.success).toBe(true);
    expect(requested.map((r) => r.type)).toEqual(['browser.openDefault', 'browser.open']);
    const data = result.data as { openedVia?: string };
    expect(data.openedVia).toBe('managed-browser');
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* searchWeb - visible search results                                  */
/* ────────────────────────────────────────────────────────────────── */

describe('searchWeb visible-open policy', () => {
  it('opens the search URL in the default browser', async () => {
    const { manager, requested } = makeFakeActionManager();
    const result = await searchWebTool.execute({ query: 'cute cats' }, { sessionId: 's', executionId: 'e', actionManager: manager } as never);
    expect(result.success).toBe(true);
    expect(requested[0].type).toBe('browser.openDefault');
    expect(String(requested[0].parameters.url)).toContain('google.com/search?q=cute%20cats');
  });

  it('honors the youtube engine', async () => {
    const { manager, requested } = makeFakeActionManager();
    await searchWebTool.execute({ query: 'lofi beats', engine: 'youtube' }, { sessionId: 's', executionId: 'e', actionManager: manager } as never);
    expect(String(requested[0].parameters.url)).toContain('youtube.com/results?search_query=lofi%20beats');
  });

  it('falls back to the managed session when no default browser exists', async () => {
    const { manager, requested } = makeFakeActionManager({ 'browser.openDefault': 'failed' });
    const result = await searchWebTool.execute({ query: 'ai news' }, { sessionId: 's', executionId: 'e', actionManager: manager } as never);
    expect(requested.map((r) => r.type)).toEqual(['browser.openDefault', 'browser.open']);
    expect(result.success).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* openApplication - website route must be visible too                 */
/* ────────────────────────────────────────────────────────────────── */

describe('openApplication visible-open policy', () => {
  it('"open youtube" (website name, auto intent) uses browser.openDefault', async () => {
    const { manager, requested } = makeFakeActionManager();
    const result = await openApplicationTool.execute({ application: 'youtube' }, { sessionId: 's', executionId: 'e', actionManager: manager } as never);
    expect(result.success).toBe(true);
    expect(requested[0].type).toBe('browser.openDefault');
    expect(requested[0].parameters.url).toBe('https://www.youtube.com/');
  });

  it('website route falls back to the managed browser when OS open fails', async () => {
    const { manager, requested } = makeFakeActionManager({ 'browser.openDefault': 'failed' });
    const result = await openApplicationTool.execute({ application: 'wikipedia' }, { sessionId: 's', executionId: 'e', actionManager: manager } as never);
    expect(result.success).toBe(true);
    expect(requested.map((r) => r.type)).toEqual(['browser.openDefault', 'browser.open']);
  });

  it('desktop-first brands still try application.launch first', async () => {
    const { manager, requested } = makeFakeActionManager();
    await openApplicationTool.execute({ application: 'discord' }, { sessionId: 's', executionId: 'e', actionManager: manager } as never);
    expect(requested[0].type).toBe('application.launch');
  });

  it('desktop-launch failure falls back to a visible browser open', async () => {
    const { manager, requested } = makeFakeActionManager({ 'application.launch': 'failed' });
    const result = await openApplicationTool.execute({ application: 'discord' }, { sessionId: 's', executionId: 'e', actionManager: manager } as never);
    expect(result.success).toBe(true);
    expect(requested[1].type).toBe('browser.openDefault');
    expect(requested[1].parameters.url).toBe('https://discord.com/');
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* LocalAgentEngine quick commands (offline, no LLM)                   */
/* ────────────────────────────────────────────────────────────────── */

describe('LocalAgentEngine quick commands', () => {
  it('"open youtube" runs openApplication directly - the LLM is never called', async () => {
    const { toolManager, calls } = makeFakeToolManager({
      openApplication: { success: true, userMessage: 'Opening YouTube (youtube.com) in your default browser.', data: { url: 'https://www.youtube.com/', siteName: 'YouTube', domain: 'youtube.com' } },
    });
    const ollama = makeForbiddenOllama();
    const engine = new LocalAgentEngine(toolManager, ollama as never);
    const events: Array<{ type: string; name?: string }> = [];
    const result = await engine.processTurn('sess-1', 'open youtube', { emit: (e) => events.push(e as { type: string; name?: string }) });

    expect(result.toolCallsExecuted).toBe(1);
    expect(calls[0].name).toBe('openApplication');
    expect(calls[0].args).toEqual({ application: 'youtube' });
    expect(result.reply).toMatch(/Opening YouTube/);
    expect(events.some((e) => e.type === 'tool_call' && e.name === 'openApplication')).toBe(true);
    expect(events.some((e) => e.type === 'browser_action')).toBe(true);
  });

  it('passes the stable authorization ID to tool calls', async () => {
    const { toolManager, calls } = makeFakeToolManager({
      openApplication: { success: true, data: { siteName: 'YouTube' } },
    });
    const engine = new LocalAgentEngine(toolManager, makeForbiddenOllama() as never);
    await engine.processTurn('sess-1', 'open youtube', { toolSessionId: 'auth-123' });
    expect(calls[0].contextSessionId).toBe('auth-123');
  });

  it('"hey sera, search for cute cats" runs searchWeb without the LLM', async () => {
    const { toolManager, calls } = makeFakeToolManager({
      searchWeb: { success: true, userMessage: 'Opened Google Search results for "cute cats" in your default browser.', data: { url: 'https://www.google.com/search?q=cute+cats' } },
    });
    const engine = new LocalAgentEngine(toolManager, makeForbiddenOllama() as never);
    const result = await engine.processTurn('sess-1', 'hey sera, search for cute cats');
    expect(calls[0].name).toBe('searchWeb');
    expect(calls[0].args).toMatchObject({ query: 'cute cats' });
    expect(result.reply).toMatch(/default browser/);
  });

  it('"search youtube for lofi" sets the engine', async () => {
    const { toolManager, calls } = makeFakeToolManager({
      searchWeb: { success: true, data: { url: 'https://www.youtube.com/results?search_query=lofi' } },
    });
    const engine = new LocalAgentEngine(toolManager, makeForbiddenOllama() as never);
    await engine.processTurn('sess-1', 'search youtube for lofi');
    expect(calls[0].args).toMatchObject({ query: 'lofi', engine: 'youtube' });
  });

  it('"play lofi beats" searches youtube; "on spotify" opens the app', async () => {
    const { toolManager, calls } = makeFakeToolManager({
      searchWeb: { success: true, data: { url: 'https://www.youtube.com/results?search_query=lofi+beats' } },
      openApplication: { success: true, data: { displayName: 'Spotify' } },
    });
    const engine = new LocalAgentEngine(toolManager, makeForbiddenOllama() as never);
    await engine.processTurn('sess-1', 'play lofi beats');
    expect(calls[0]).toMatchObject({ name: 'searchWeb', args: { query: 'lofi beats', engine: 'youtube' } });
    await engine.processTurn('sess-2', 'play some jazz on spotify');
    expect(calls[1]).toMatchObject({ name: 'openApplication', args: { application: 'spotify' } });
  });

  it('falls back to the LLM when the text is not a simple command', async () => {
    const { toolManager, raw } = makeFakeToolManager({});
    const ollama = makeOllamaReplying('The capital of France is Paris.');
    const engine = new LocalAgentEngine(toolManager, ollama as never);
    const result = await engine.processTurn('sess-1', "what's the capital of France?");
    expect(raw.executeTool).not.toHaveBeenCalled();
    expect(ollama.chat).toHaveBeenCalled();
    expect(result.reply).toContain('Paris');
  });

  it('falls back to the LLM when the quick tool fails', async () => {
    const { toolManager, raw } = makeFakeToolManager({
      openApplication: { success: false, error: 'Capability "APPLICATION_LAUNCH" requires authorization.' },
    });
    const ollama = makeOllamaReplying('I could not open that - here is why...');
    const engine = new LocalAgentEngine(toolManager, ollama as never);
    const result = await engine.processTurn('sess-1', 'open notepad');
    expect(raw.executeTool).toHaveBeenCalled();
    expect(ollama.chat).toHaveBeenCalled();
    expect(result.reply).toContain('here is why');
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* LocalAgentEngine: raw-JSON tool-call recovery + wake greeting       */
/* (regression: 3B model answered the wake greeting with               */
/*  {"name":"sayHello",...} — shown raw in chat and spoken aloud)      */
/* ────────────────────────────────────────────────────────────────── */

describe('LocalAgentEngine textual tool-call recovery', () => {
  it('never shows raw JSON — a hallucinated sayHello becomes the spoken line', async () => {
    const { toolManager } = makeFakeToolManager({}, ['openApplication']);
    const ollama = makeOllamaReplying('{"name":"sayHello","parameters":{"text":"Hey, I\'m here! What\'s up?"}}');
    const engine = new LocalAgentEngine(toolManager, ollama as never);
    const events: Array<Record<string, unknown>> = [];
    const result = await engine.processTurn('sess-json', 'hello', { emit: (e) => events.push(e as Record<string, unknown>) });

    expect(result.reply).toBe("Hey, I'm here! What's up?");
    expect(result.toolCallsExecuted).toBe(0);
    const transcripts = events.filter((e) => e.type === 'transcript');
    expect(transcripts.some((t) => String((t as { text?: string }).text ?? '').includes('sayHello'))).toBe(false);
    expect(transcripts.some((t) => String((t as { text?: string }).text ?? '').includes('{'))).toBe(false);
  });

  it('executes a textual tool call for a REAL tool through the normal path', async () => {
    const { toolManager, calls } = makeFakeToolManager(
      { openApplication: { success: true, data: { siteName: 'Spotify' } } },
      ['openApplication'],
    );
    const textualCall = { content: '{"tool":"openApplication","args":{"application":"spotify"}}', toolCalls: [] as unknown[] };
    const spoken = { content: 'Spotify is opening now.', toolCalls: [] as unknown[] };
    const ollama = { chat: vi.fn().mockResolvedValueOnce(textualCall).mockResolvedValueOnce(spoken) };
    const engine = new LocalAgentEngine(toolManager, ollama as never);
    // A sentence that does NOT match the offline quick commands so the
    // request actually reaches the LLM loop.
    const result = await engine.processTurn('sess-json2', 'could you get spotify running for me please', { emit: () => undefined });

    expect(calls[0].name).toBe('openApplication');
    expect(calls[0].args).toEqual({ application: 'spotify' });
    expect(result.reply).toBe('Spotify is opening now.');
    expect(result.toolCallsExecuted).toBe(1);
  });

  it('hallucinated tool without a text payload falls back to a friendly line', async () => {
    const { toolManager } = makeFakeToolManager({}, []);
    const ollama = makeOllamaReplying('{"name":"doMagic","parameters":{}}');
    const engine = new LocalAgentEngine(toolManager, ollama as never);
    const result = await engine.processTurn('sess-json3', 'do the thing');
    expect(result.reply).not.toMatch(/[{}]/);
    expect(result.reply).toMatch(/listening/i);
  });
});

describe('LocalAgentEngine wake greeting', () => {
  it('answers the wake greeting deterministically — LLM never called, no JSON', async () => {
    const { toolManager } = makeFakeToolManager({}, []);
    const ollama = makeForbiddenOllama();
    const engine = new LocalAgentEngine(toolManager, ollama as never);
    const events: Array<Record<string, unknown>> = [];
    const result = await engine.processTurn(
      'sess-hello',
      "Hey! Someone just called your name. Please say a short, warm, natural greeting to let them know you're listening.",
      { emit: (e) => events.push(e as Record<string, unknown>) },
    );
    expect(ollama.chat).not.toHaveBeenCalled();
    // v1.6.10 FLAKE FIX: the greeting pool has 6 entries, randomly picked.
    // "Yes? I'm all ears." matched none of /here|listening|what/ — one run
    // in six failed. Accept every deterministic greeting instead.
    expect(result.reply).toMatch(/here|listening|what|ears|hear|need|next/i);
    expect(result.reply).not.toMatch(/^\s*\{/);
    expect(events.some((e) => e.type === 'transcript' && String((e as { text?: string }).text).includes('{'))).toBe(false);
  });

  it('normal chat still reaches the LLM (the greeting guard is narrow)', async () => {
    const { toolManager } = makeFakeToolManager({}, []);
    const ollama = makeOllamaReplying('A very good morning to you!');
    const engine = new LocalAgentEngine(toolManager, ollama as never);
    const result = await engine.processTurn('sess-hello2', 'hey sera, good morning');
    expect(result.reply).toBe('A very good morning to you!');
  });
});
