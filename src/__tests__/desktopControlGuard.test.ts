import { describe, it, expect, vi } from 'vitest';
import { LocalAgentEngine, desktopControlGuardBlock } from '../local/LocalAgentEngine';
import { OllamaClient, OllamaChatResponse } from '../local/OllamaClient';
import { ToolManager } from '../tools/ToolManager';
import { ToolPermissionLevel } from '../tools/types';

/* ────────────────────────────────────────────────────────────────── */
/* desktopControlGuardBlock — the "random clipboard" killer            */
/*                                                                     */
/* Real bug: a small local model hallucinated control+c, SERA pressed  */
/* it, and the OS copied whatever text the user had selected. The      */
/* guard lets keyboard/clipboard tools run ONLY on explicit requests.  */
/* ────────────────────────────────────────────────────────────────── */

describe('desktopControlGuardBlock', () => {
  it('blocks an unsolicited ctrl+c hotkey (the clipboard ghost)', () => {
    const reason = desktopControlGuardBlock('controlComputerInput', { operation: 'hotkey', keys: ['control', 'c'] }, "what's the weather like?");
    expect(reason).toBeTruthy();
    expect(reason).toContain('safety guard');
  });

  it('allows the hotkey when the user explicitly asks for it', () => {
    expect(desktopControlGuardBlock('controlComputerInput', { operation: 'hotkey', keys: ['control', 'c'] }, 'press control c to copy this')).toBeNull();
    expect(desktopControlGuardBlock('controlComputerInput', { operation: 'hotkey', keys: ['control', 'c'] }, 'copy the selected text to the clipboard')).toBeNull();
  });

  it('allows typing only when asked to type/write', () => {
    expect(desktopControlGuardBlock('controlComputerInput', { operation: 'type', text: 'hello' }, "what's up?")).toBeTruthy();
    expect(desktopControlGuardBlock('controlComputerInput', { operation: 'type', text: 'hello' }, 'type hello into notepad')).toBeNull();
    expect(desktopControlGuardBlock('controlComputerInput', { operation: 'type', text: 'hello' }, 'write this down for me')).toBeNull();
  });

  it('never blocks mouse operations (established visual automation)', () => {
    expect(desktopControlGuardBlock('controlComputerInput', { operation: 'click', button: 'left' }, 'open youtube')).toBeNull();
    expect(desktopControlGuardBlock('controlComputerInput', { operation: 'scroll', direction: 'down' }, '')).toBeNull();
    expect(desktopControlGuardBlock('controlComputerInput', { operation: 'move' }, undefined)).toBeNull();
  });

  it('gates clipboard writes but allows clipboard reads', () => {
    expect(desktopControlGuardBlock('setClipboard', { text: 'hi' }, 'tell me a joke')).toBeTruthy();
    expect(desktopControlGuardBlock('pasteClipboard', {}, 'do the thing')).toBeTruthy();
    expect(desktopControlGuardBlock('setClipboard', { text: 'hi' }, 'copy this to the clipboard')).toBeNull();
    expect(desktopControlGuardBlock('getClipboard', {}, 'what did I copy?')).toBeNull();
  });

  it('ignores tools that cannot touch the desktop', () => {
    expect(desktopControlGuardBlock('openApplication', { application: 'notepad' }, 'hey')).toBeNull();
    expect(desktopControlGuardBlock('searchWeb', { query: 'cats' }, '')).toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* Engine integration — the guard inside the local agent loop          */
/* ────────────────────────────────────────────────────────────────── */

type ChatCall = { content: string; toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }> };

function makeEngine(chatScript: ChatCall[]) {
  const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
  const manager = new ToolManager();
  const registerStub = (name: string) => {
    manager.registerTool({
      name,
      description: name,
      permissionLevel: ToolPermissionLevel.LOW_RISK_ACTION,
      parameters: { type: 'OBJECT', properties: {} },
      validateArgs: (args) => ({ valid: true, parsedArgs: args as Record<string, unknown> }),
      execute: async (args) => {
        executed.push({ name, args: args as Record<string, unknown> });
        return { success: true, data: { done: true } };
      },
    });
  };
  registerStub('controlComputerInput');
  registerStub('setClipboard');
  registerStub('openApplication');

  let call = 0;
  const chat = vi.fn(async (): Promise<OllamaChatResponse> => {
    const step = chatScript[Math.min(call, chatScript.length - 1)];
    call += 1;
    return { content: step.content, toolCalls: step.toolCalls || [], model: 'test-model', totalDurationMs: 1, evalCount: 1 };
  });
  const engine = new LocalAgentEngine(manager, { chat } as unknown as OllamaClient);
  return { engine, executed, chat };
}

describe('LocalAgentEngine desktop-control guard', () => {
  it('does NOT execute a hallucinated ctrl+c and tells the model why', async () => {
    const { engine, executed } = makeEngine([
      { content: '', toolCalls: [{ name: 'controlComputerInput', arguments: { operation: 'hotkey', keys: ['control', 'c'] } }] },
      { content: 'I need a clearer request before pressing keys.' },
    ]);
    const events: Array<Record<string, unknown>> = [];
    const result = await engine.processTurn('s1', 'do something for me', {
      emit: (e) => events.push(e as unknown as Record<string, unknown>),
    });

    expect(executed).toEqual([]); // nothing touched the user's desktop
    expect(result.blockedToolCalls).toBe(1);
    expect(result.toolCallsExecuted).toBe(0);
    const blocked = events.find((e) => e.type === 'tool_result') as Record<string, unknown> | undefined;
    expect(blocked).toBeTruthy();
    expect(String(blocked!.error)).toContain('safety guard');
    expect(result.reply).toContain('clearer request');
  });

  it('executes the hotkey when the user explicitly requested it', async () => {
    const { engine, executed } = makeEngine([
      { content: '', toolCalls: [{ name: 'controlComputerInput', arguments: { operation: 'hotkey', keys: ['control', 'c'] } }] },
      { content: 'Copied.' },
    ]);
    const result = await engine.processTurn('s2', 'press control c to copy the selected text', {});

    expect(result.blockedToolCalls).toBe(0);
    expect(executed).toHaveLength(1);
    expect(executed[0].name).toBe('controlComputerInput');
    expect(result.reply).toBe('Copied.');
  });

  it('leaves ordinary tools untouched', async () => {
    const { engine, executed } = makeEngine([
      { content: '', toolCalls: [{ name: 'openApplication', arguments: { application: 'notepad' } }] },
      { content: 'Opened.' },
    ]);
    const result = await engine.processTurn('s3', 'open notepad', {});
    expect(executed).toHaveLength(1);
    expect(result.blockedToolCalls).toBe(0);
  });

  it('still salvages hallucinated sayHello JSON into a spoken reply', async () => {
    const { engine, executed } = makeEngine([
      { content: '{"name":"sayHello","parameters":{"text":"Hey, I\'m here!"}}' },
    ]);
    const result = await engine.processTurn('s4', 'hey sera', {});
    expect(result.reply).toBe("Hey, I'm here!");
    expect(executed).toEqual([]);
  });
});
