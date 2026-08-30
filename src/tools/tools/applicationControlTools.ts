import { ACTION_ERROR_CODES } from '../../actions/errors';
import { ActionManager } from '../../actions/ActionManager';
import { ToolDefinition, ToolPermissionLevel } from '../types';

interface CloseApplicationArgs { processId?: number; application?: string; }

export const closeApplicationTool: ToolDefinition<CloseApplicationArgs> = {
  name: 'closeApplication',
  description: 'Force-closes an identified Windows application process. Use only after graceful window close is unavailable or has failed.',
  permissionLevel: ToolPermissionLevel.DANGEROUS_ACTION,
  capability: 'APPLICATION_CLOSE',
  parameters: {
    type: 'OBJECT',
    properties: {
      processId: { type: 'INTEGER', description: 'Exact process ID from window or application metadata.' },
      application: { type: 'STRING', description: 'Application name to resolve from an open window.' },
    },
  },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object') return { valid: false, error: 'Application close arguments are required.' };
    const value = args as Record<string, unknown>;
    if (value.processId === undefined && (typeof value.application !== 'string' || !value.application.trim())) return { valid: false, error: 'Provide a process ID or application name.' };
    if (value.processId !== undefined && (typeof value.processId !== 'number' || !Number.isInteger(value.processId) || value.processId <= 0)) return { valid: false, error: 'Process ID must be a positive integer.' };
    return { valid: true, parsedArgs: { processId: value.processId as number | undefined, application: typeof value.application === 'string' ? value.application.trim() : undefined } };
  },
  async execute(args, context) {
    const manager: ActionManager | undefined = context?.actionManager;
    if (!manager) return { success: false, error: `${ACTION_ERROR_CODES.APPLICATION_CLOSE_FAILED}: Application control is unavailable.` };
    const action = manager.createAction({ taskId: context?.sessionId, actionId: context?.executionId, type: 'application.close', parameters: args });
    const result = await manager.execute(action);
    return result.status === 'succeeded'
      ? { success: true, userMessage: 'Application termination was verified.', data: result.result }
      : { success: false, error: result.error?.message || 'Application termination was not verified.' };
  },
};
