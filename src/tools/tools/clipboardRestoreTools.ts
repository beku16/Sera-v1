import { ACTION_ERROR_CODES } from '../../actions/errors';
import { ActionManager } from '../../actions/ActionManager';
import { ToolDefinition, ToolPermissionLevel } from '../types';

export const saveClipboardTool: ToolDefinition<Record<string, never>> = {
  name: 'saveClipboard',
  description: 'Saves the current text clipboard so it can be restored after automation.',
  permissionLevel: ToolPermissionLevel.SENSITIVE_ACTION,
  capability: 'CLIPBOARD_READ',
  parameters: { type: 'OBJECT', properties: {} },
  validateArgs: () => ({ valid: true, parsedArgs: {} }),
  async execute(_args, context) {
    const manager: ActionManager | undefined = context?.actionManager;
    if (!manager) return { success: false, error: `${ACTION_ERROR_CODES.CLIPBOARD_UNAVAILABLE}: Clipboard control is unavailable.` };
    const result = await manager.execute(manager.createAction({ taskId: context?.sessionId, actionId: context?.executionId, type: 'clipboard.save', parameters: {} }));
    return result.status === 'succeeded' ? { success: true, userMessage: 'Clipboard snapshot saved.', data: result.result } : { success: false, error: result.error?.message || 'Clipboard snapshot failed.' };
  },
};

export const restoreClipboardTool: ToolDefinition<Record<string, never>> = {
  name: 'restoreClipboard',
  description: 'Restores the clipboard snapshot saved before automation.',
  permissionLevel: ToolPermissionLevel.SENSITIVE_ACTION,
  capability: 'CLIPBOARD_WRITE',
  parameters: { type: 'OBJECT', properties: {} },
  validateArgs: () => ({ valid: true, parsedArgs: {} }),
  async execute(_args, context) {
    const manager: ActionManager | undefined = context?.actionManager;
    if (!manager) return { success: false, error: `${ACTION_ERROR_CODES.CLIPBOARD_UNAVAILABLE}: Clipboard control is unavailable.` };
    const result = await manager.execute(manager.createAction({ taskId: context?.sessionId, actionId: context?.executionId, type: 'clipboard.restore', parameters: {} }));
    return result.status === 'succeeded' ? { success: true, userMessage: 'Clipboard snapshot restored.', data: result.result } : { success: false, error: result.error?.message || 'Clipboard restoration failed.' };
  },
};
