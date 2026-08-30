import { ACTION_ERROR_CODES } from '../../actions/errors';
import { ActionManager } from '../../actions/ActionManager';
import { ToolDefinition, ToolPermissionLevel } from '../types';

interface WindowTargetArgs {
  handle?: string;
  processId?: number;
  title?: string;
  application?: string;
}

type WindowStateOperation = 'minimize' | 'maximize' | 'restore';

function managerOrError(manager: ActionManager | undefined) {
  return manager || null;
}

export const getActiveWindowTool: ToolDefinition<Record<string, never>> = {
  name: 'getActiveWindow',
  description: 'Returns the current active Windows application and window metadata.',
  permissionLevel: ToolPermissionLevel.READ_ONLY,
  parameters: { type: 'OBJECT', properties: {} },
  validateArgs: () => ({ valid: true, parsedArgs: {} }),
  async execute(_args, context) {
    const manager = managerOrError(context?.actionManager);
    if (!manager) return { success: false, error: `${ACTION_ERROR_CODES.INPUT_PROVIDER_UNAVAILABLE}: Window control is unavailable.` };
    const action = manager.createAction({ taskId: context?.sessionId, actionId: context?.executionId, type: 'window.getActive', parameters: {} });
    const result = await manager.execute(action);
    return result.status === 'succeeded' ? { success: true, data: result.result } : { success: false, error: result.error?.message || 'Active window lookup failed.' };
  },
};

export const listWindowsTool: ToolDefinition<Record<string, never>> = {
  name: 'listWindows',
  description: 'Lists visible top-level Windows applications and their window metadata.',
  permissionLevel: ToolPermissionLevel.READ_ONLY,
  parameters: { type: 'OBJECT', properties: {} },
  validateArgs: () => ({ valid: true, parsedArgs: {} }),
  async execute(_args, context) {
    const manager = managerOrError(context?.actionManager);
    if (!manager) return { success: false, error: `${ACTION_ERROR_CODES.INPUT_PROVIDER_UNAVAILABLE}: Window control is unavailable.` };
    const action = manager.createAction({ taskId: context?.sessionId, actionId: context?.executionId, type: 'window.list', parameters: {} });
    const result = await manager.execute(action);
    return result.status === 'succeeded' ? { success: true, data: result.result } : { success: false, error: result.error?.message || 'Window listing failed.' };
  },
};

export const focusWindowTool: ToolDefinition<WindowTargetArgs> = {
  name: 'focusWindow',
  description: 'Focuses one identified window by handle, process ID, exact title, or application name.',
  permissionLevel: ToolPermissionLevel.SENSITIVE_ACTION,
  capability: 'WINDOW_CONTROL',
  parameters: {
    type: 'OBJECT',
    properties: {
      handle: { type: 'STRING', description: 'Exact native window handle returned by getActiveWindow or listWindows.' },
      processId: { type: 'INTEGER', description: 'Process ID returned by window metadata.' },
      title: { type: 'STRING', description: 'Exact window title.' },
      application: { type: 'STRING', description: 'Application name.' },
    },
  },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object') return { valid: false, error: 'Window identity is required.' };
    const value = args as Record<string, unknown>;
    if (!value.handle && value.processId === undefined && !value.title && !value.application) return { valid: false, error: 'Provide a handle, process ID, title, or application.' };
    if (value.processId !== undefined && (typeof value.processId !== 'number' || !Number.isInteger(value.processId))) return { valid: false, error: 'Process ID must be an integer.' };
    return { valid: true, parsedArgs: { handle: typeof value.handle === 'string' ? value.handle : undefined, processId: value.processId as number | undefined, title: typeof value.title === 'string' ? value.title : undefined, application: typeof value.application === 'string' ? value.application : undefined } };
  },
  async execute(args, context) {
    const manager = managerOrError(context?.actionManager);
    if (!manager) return { success: false, error: `${ACTION_ERROR_CODES.INPUT_PROVIDER_UNAVAILABLE}: Window control is unavailable.` };
    const action = manager.createAction({ taskId: context?.sessionId, actionId: context?.executionId, type: 'window.focus', parameters: args });
    const result = await manager.execute(action);
    return result.status === 'succeeded' ? { success: true, data: result.result } : { success: false, error: result.error?.message || 'Window focus failed.' };
  },
};

export const windowStateTool: ToolDefinition<WindowTargetArgs & { operation: WindowStateOperation }> = {
  name: 'setWindowState',
  description: 'Minimizes, maximizes, or restores an identified Windows application window.',
  permissionLevel: ToolPermissionLevel.SENSITIVE_ACTION,
  capability: 'WINDOW_CONTROL',
  parameters: {
    type: 'OBJECT',
    properties: {
      operation: { type: 'STRING', description: 'Window state operation.', enum: ['minimize', 'maximize', 'restore'] },
      handle: { type: 'STRING', description: 'Exact native window handle.' },
      processId: { type: 'INTEGER', description: 'Window process ID.' },
      title: { type: 'STRING', description: 'Exact window title.' },
      application: { type: 'STRING', description: 'Application name.' },
    },
    required: ['operation'],
  },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object') return { valid: false, error: 'Window state arguments are required.' };
    const value = args as Record<string, unknown>;
    if (!['minimize', 'maximize', 'restore'].includes(String(value.operation))) return { valid: false, error: 'Unknown window state operation.' };
    if (!value.handle && value.processId === undefined && !value.title && !value.application) return { valid: false, error: 'Provide a window handle, process ID, title, or application.' };
    return {
      valid: true,
      parsedArgs: {
        operation: value.operation as WindowStateOperation,
        handle: typeof value.handle === 'string' ? value.handle : undefined,
        processId: typeof value.processId === 'number' ? value.processId : undefined,
        title: typeof value.title === 'string' ? value.title : undefined,
        application: typeof value.application === 'string' ? value.application : undefined,
      },
    };
  },
  async execute(args, context) {
    const manager = managerOrError(context?.actionManager);
    if (!manager) return { success: false, error: `${ACTION_ERROR_CODES.INPUT_PROVIDER_UNAVAILABLE}: Window control is unavailable.` };
    const action = manager.createAction({
      taskId: context?.sessionId,
      actionId: context?.executionId,
      type: `window.${args.operation}`,
      parameters: args,
    });
    const result = await manager.execute(action);
    return result.status === 'succeeded' ? { success: true, data: result.result } : { success: false, error: result.error?.message || 'Window state change was not verified.' };
  },
};

export const closeWindowTool: ToolDefinition<WindowTargetArgs> = {
  name: 'closeWindow',
  description: 'Gracefully closes one identified Windows application window by its stable handle or identity.',
  permissionLevel: ToolPermissionLevel.SENSITIVE_ACTION,
  capability: 'WINDOW_CONTROL',
  parameters: {
    type: 'OBJECT',
    properties: {
      handle: { type: 'STRING', description: 'Exact native window handle.' },
      processId: { type: 'INTEGER', description: 'Window process ID.' },
      title: { type: 'STRING', description: 'Exact window title.' },
      application: { type: 'STRING', description: 'Application name.' },
    },
  },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object') return { valid: false, error: 'Window identity is required.' };
    const value = args as Record<string, unknown>;
    if (!value.handle && value.processId === undefined && !value.title && !value.application) return { valid: false, error: 'Provide a window handle, process ID, title, or application.' };
    return { valid: true, parsedArgs: { handle: typeof value.handle === 'string' ? value.handle : undefined, processId: typeof value.processId === 'number' ? value.processId : undefined, title: typeof value.title === 'string' ? value.title : undefined, application: typeof value.application === 'string' ? value.application : undefined } };
  },
  async execute(args, context) {
    const manager = managerOrError(context?.actionManager);
    if (!manager) return { success: false, error: `${ACTION_ERROR_CODES.INPUT_PROVIDER_UNAVAILABLE}: Window control is unavailable.` };
    const action = manager.createAction({ taskId: context?.sessionId, actionId: context?.executionId, type: 'window.close', parameters: args });
    const result = await manager.execute(action);
    return result.status === 'succeeded' ? { success: true, data: result.result } : { success: false, error: result.error?.message || 'Window close was not verified.' };
  },
};

interface AuthorizationArgs { enabled?: boolean; mode?: 'STANDARD' | 'TRUSTED' | 'FULL_CONTROL'; }
export const computerControlAuthorizationTool: ToolDefinition<AuthorizationArgs> = {
  name: 'setComputerControlAuthorization',
  description: 'Enable or revoke SERA computer control for the current local control session. Use only when the user explicitly requests it.',
  permissionLevel: ToolPermissionLevel.LOW_RISK_ACTION,
  parameters: { type: 'OBJECT', properties: { enabled: { type: 'BOOLEAN', description: 'Legacy toggle. True selects TRUSTED; false selects STANDARD.' }, mode: { type: 'STRING', description: 'Authorization mode.', enum: ['STANDARD', 'TRUSTED', 'FULL_CONTROL'] } } },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object') return { valid: false, error: 'Authorization arguments are required.' };
    const value = args as Record<string, unknown>;
    if (value.mode !== undefined && !['STANDARD', 'TRUSTED', 'FULL_CONTROL'].includes(String(value.mode))) return { valid: false, error: 'Unknown authorization mode.' };
    if (value.mode === undefined && typeof value.enabled !== 'boolean') return { valid: false, error: 'Provide mode or enabled.' };
    return { valid: true, parsedArgs: { mode: value.mode as AuthorizationArgs['mode'], enabled: value.enabled as boolean | undefined } };
  },
  async execute(args, context) {
    const manager = context?.actionManager;
    if (!manager) return { success: false, error: 'Control authorization is unavailable.' };
    const mode = args.mode || (args.enabled ? 'TRUSTED' : 'STANDARD');
    const authorization = context?.authorizationManager || (await import('../../authorization/ComputerAuthorizationManager')).defaultComputerAuthorizationManager;
    const state = authorization.setAuthorizationMode(mode, context?.sessionId || 'default');
    if (mode === 'STANDARD') manager.revokeComputerControl(context?.sessionId);
    else manager.authorizeComputerControl(context?.sessionId);
    return { success: true, data: state, userMessage: `Computer control mode set to ${mode}.` };
  },
};

