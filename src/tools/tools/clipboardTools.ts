import { ACTION_ERROR_CODES } from '../../actions/errors';
import { ActionManager } from '../../actions/ActionManager';
import { ToolDefinition, ToolPermissionLevel } from '../types';

interface ClipboardGetArgs { }
interface ClipboardSetArgs { content: string; }

export const getClipboardTool: ToolDefinition<ClipboardGetArgs> = {
  name: 'getClipboard',
  description: 'Retrieves the current system clipboard content as text.',
  permissionLevel: ToolPermissionLevel.SENSITIVE_ACTION,
  capability: 'CLIPBOARD_READ',
  parameters: { type: 'OBJECT', properties: {} },
  validateArgs: () => ({ valid: true, parsedArgs: {} }),
  async execute(_args, context) {
    const manager: ActionManager | undefined = context?.actionManager;
    if (!manager) return { success: false, error: `${ACTION_ERROR_CODES.CLIPBOARD_UNAVAILABLE}: Clipboard control is unavailable.` };
    const action = manager.createAction({ taskId: context?.sessionId, actionId: context?.executionId, type: 'clipboard.get', parameters: {} });
    const result = await manager.execute(action);
    if (result.status !== 'succeeded') return { success: false, error: result.error?.message || 'Clipboard read failed.' };
    const clipboardResult = result.result as { content?: unknown; length?: unknown } | undefined;
    if (!clipboardResult || typeof clipboardResult.content !== 'string') return { success: false, error: 'Clipboard content was not returned.' };
    return { success: true, userMessage: 'Clipboard content retrieved.', data: { content: clipboardResult.content, length: clipboardResult.length } };
  },
};

export const setClipboardTool: ToolDefinition<ClipboardSetArgs> = {
  name: 'setClipboard',
  description: 'Sets the system clipboard content to the specified text.',
  permissionLevel: ToolPermissionLevel.SENSITIVE_ACTION,
  capability: 'CLIPBOARD_WRITE',
  parameters: {
    type: 'OBJECT',
    properties: {
      content: { type: 'STRING', description: 'Text content to set in the clipboard.' },
    },
    required: ['content'],
  },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object') return { valid: false, error: 'Clipboard arguments are required.' };
    const value = args as Record<string, unknown>;
    if (typeof value.content !== 'string' || !value.content.trim()) return { valid: false, error: 'Clipboard content must be a non-empty string.' };
    return { valid: true, parsedArgs: { content: value.content } };
  },
  async execute(args, context) {
    const manager: ActionManager | undefined = context?.actionManager;
    if (!manager) return { success: false, error: `${ACTION_ERROR_CODES.CLIPBOARD_UNAVAILABLE}: Clipboard control is unavailable.` };
    const action = manager.createAction({ taskId: context?.sessionId, actionId: context?.executionId, type: 'clipboard.set', parameters: { content: args.content } });
    const result = await manager.execute(action);
    return result.status === 'succeeded'
      ? { success: true, userMessage: 'Clipboard content set and verified.', data: { success: true } }
      : { success: false, error: result.error?.message || 'Clipboard write or verification failed.' };
  },
};

export const pasteClipboardTool: ToolDefinition<Record<string, never>> = {
  name: 'pasteClipboard',
  description: 'Pastes the current clipboard content at the focused input using Ctrl+V.',
  permissionLevel: ToolPermissionLevel.SENSITIVE_ACTION,
  capability: 'KEYBOARD_CONTROL',
  parameters: { type: 'OBJECT', properties: {} },
  validateArgs: () => ({ valid: true, parsedArgs: {} }),
  async execute(_args, context) {
    const manager: ActionManager | undefined = context?.actionManager;
    if (!manager) return { success: false, error: `${ACTION_ERROR_CODES.INPUT_PROVIDER_UNAVAILABLE}: Input control is unavailable.` };
    const action = manager.createAction({ taskId: context?.sessionId, actionId: context?.executionId, type: 'input.hotkey', parameters: { keys: ['control', 'v'] } });
    const result = await manager.execute(action);
    return result.status === 'succeeded'
      ? { success: true, userMessage: 'Paste command sent.' }
      : { success: false, error: result.error?.message || 'Paste operation failed.' };
  },
};

