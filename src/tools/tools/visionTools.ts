import { ActionManager } from '../../actions/ActionManager';
import { ACTION_ERROR_CODES } from '../../actions/errors';
import { ToolDefinition, ToolPermissionLevel } from '../types';

interface InspectScreenArgs { region?: { x: number; y: number; width: number; height: number }; }
export const inspectScreenTool: ToolDefinition<InspectScreenArgs> = {
  name: 'inspectScreen',
  description: 'Inspects the currently shared screen and returns structured visible text, controls, errors, and active-window context.',
  permissionLevel: ToolPermissionLevel.SENSITIVE_ACTION,
  capability: 'SCREEN_INSPECTION',
  parameters: { type: 'OBJECT', properties: { region: { type: 'OBJECT', description: 'Optional screen region with integer x, y, width, and height.' } } },
  validateArgs: (args: unknown) => {
    if (!args || typeof args !== 'object') return { valid: true, parsedArgs: {} };
    const region = (args as Record<string, unknown>).region;
    if (region === undefined) return { valid: true, parsedArgs: {} };
    if (!region || typeof region !== 'object' || !Object.values(region).every((value) => typeof value === 'number' && Number.isInteger(value))) return { valid: false, error: 'region requires integer x, y, width, and height.' };
    return { valid: true, parsedArgs: { region: region as InspectScreenArgs['region'] } };
  },
  async execute(args, context) {
    const manager: ActionManager | undefined = context?.actionManager;
    if (!manager) return { success: false, error: `${ACTION_ERROR_CODES.SCREEN_PROVIDER_UNAVAILABLE}: Vision is unavailable.` };
    const action = manager.createAction({ taskId: context?.sessionId, actionId: context?.executionId, type: 'vision.inspect', parameters: args });
    const result = await manager.execute(action);
    return result.status === 'succeeded' ? { success: true, data: result.result } : { success: false, error: result.error?.message || 'Screen inspection failed.' };
  },
};

interface LocateElementArgs { query: string; minimumConfidence?: number; }
export const locateElementTool: ToolDefinition<LocateElementArgs> = {
  name: 'locateElement',
  description: 'Finds a visible screen element by its text or semantic description and returns its confidence and bounds.',
  permissionLevel: ToolPermissionLevel.SENSITIVE_ACTION,
  capability: 'SCREEN_INSPECTION',
  parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'Visible text or semantic element description.' }, minimumConfidence: { type: 'NUMBER', description: 'Optional confidence threshold from 0 to 1.' } }, required: ['query'] },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object' || typeof (args as Record<string, unknown>).query !== 'string' || !(args as Record<string, unknown>).query) return { valid: false, error: 'A non-empty element query is required.' };
    const minimumConfidence = (args as Record<string, unknown>).minimumConfidence === undefined ? undefined : Number((args as Record<string, unknown>).minimumConfidence);
    if (minimumConfidence !== undefined && (!Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1)) return { valid: false, error: 'minimumConfidence must be between 0 and 1.' };
    return { valid: true, parsedArgs: { query: (args as Record<string, unknown>).query as string, minimumConfidence } };
  },
  async execute(args, context) {
    const manager: ActionManager | undefined = context?.actionManager;
    if (!manager) return { success: false, error: `${ACTION_ERROR_CODES.SCREEN_PROVIDER_UNAVAILABLE}: Vision is unavailable.` };
    const action = manager.createAction({ taskId: context?.sessionId, actionId: context?.executionId, type: 'vision.locate', parameters: args });
    const result = await manager.execute(action);
    return result.status === 'succeeded' ? { success: true, data: result.result } : { success: false, error: result.error?.message || 'Element location failed.' };
  },
};
