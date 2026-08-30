import { ACTION_ERROR_CODES } from '../../actions/errors';
import { ActionManager } from '../../actions/ActionManager';
import { ToolDefinition, ToolPermissionLevel } from '../types';
import { ScreenshotResult } from '../../actions/ScreenshotExecutor';

interface CaptureScreenshotArgs {
  displayId?: string;
  format?: 'png';
}

interface CaptureWindowScreenshotArgs {
  windowHandle?: number;
  processId?: number;
}

export const captureScreenshotTool: ToolDefinition<CaptureScreenshotArgs> = {
  name: 'captureScreenshot',
  description: 'Captures a screenshot of the full desktop or specific display and returns base64-encoded image data.',
  permissionLevel: ToolPermissionLevel.SENSITIVE_ACTION,
  capability: 'SCREEN_CAPTURE',
  parameters: {
    type: 'OBJECT',
    properties: {
      displayId: { type: 'STRING', description: 'Optional display identifier for multi-monitor setup.' },
      format: { type: 'STRING', description: 'Image format: png.', enum: ['png'] },
    },
  },
  validateArgs(args: unknown) {
    if (!args) return { valid: true, parsedArgs: {} };
    if (typeof args !== 'object') return { valid: false, error: 'Screenshot arguments must be an object.' };
    const value = args as Record<string, unknown>;
    const displayId = typeof value.displayId === 'string' ? value.displayId : undefined;
    const format = typeof value.format === 'string' && value.format === 'png' ? 'png' : 'png';
    return { valid: true, parsedArgs: { displayId, format } };
  },
  async execute(args, context) {
    const manager: ActionManager | undefined = context?.actionManager;
    if (!manager) return { success: false, error: `${ACTION_ERROR_CODES.SCREEN_PROVIDER_UNAVAILABLE}: Screenshot service is unavailable.` };
    
    const action = manager.createAction({
      taskId: context?.sessionId,
      actionId: context?.executionId,
      type: 'screenshot.capture',
      parameters: args,
    });
    
    const result = await manager.execute(action);
    if (result.status !== 'succeeded') {
      return { success: false, error: result.error?.message || 'Screenshot capture failed.' };
    }
    
    const screenshot = result.result as ScreenshotResult | undefined;
    if (!screenshot) return { success: false, error: 'Screenshot data is missing.' };
    
    // Return metadata; actual image data should be accessed directly from user if needed
    return {
      success: true,
      userMessage: `Screenshot captured: ${screenshot.width}x${screenshot.height} (${screenshot.format})`,
      data: {
        width: screenshot.width,
        height: screenshot.height,
        format: screenshot.format,
        capturedAt: screenshot.capturedAt,
        displayId: screenshot.displayId,
        data: screenshot.data,
        dataLength: screenshot.data.length,
      },
    };
  },
};

export const captureWindowScreenshotTool: ToolDefinition<CaptureWindowScreenshotArgs> = {
  name: 'captureWindowScreenshot',
  description: 'Captures a screenshot of a specific window by handle or process ID.',
  permissionLevel: ToolPermissionLevel.SENSITIVE_ACTION,
  capability: 'SCREEN_CAPTURE',
  parameters: {
    type: 'OBJECT',
    properties: {
      windowHandle: { type: 'INTEGER', description: 'Window handle (HWND) to capture.' },
      processId: { type: 'INTEGER', description: 'Process ID to capture window for.' },
    },
  },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object') return { valid: false, error: 'Window screenshot arguments are required.' };
    const value = args as Record<string, unknown>;
    if (!value.windowHandle && !value.processId) return { valid: false, error: 'Either windowHandle or processId must be provided.' };
    return { valid: true, parsedArgs: value as CaptureWindowScreenshotArgs };
  },
  async execute(args, context) {
    const manager: ActionManager | undefined = context?.actionManager;
    if (!manager) return { success: false, error: `${ACTION_ERROR_CODES.SCREEN_PROVIDER_UNAVAILABLE}: Screenshot service is unavailable.` };
    
    const action = manager.createAction({
      taskId: context?.sessionId,
      actionId: context?.executionId,
      type: 'screenshot.captureWindow',
      parameters: args,
    });
    
    const result = await manager.execute(action);
    if (result.status !== 'succeeded') {
      return { success: false, error: result.error?.message || 'Window screenshot capture failed.' };
    }
    
    const screenshot = result.result as ScreenshotResult | undefined;
    if (!screenshot) return { success: false, error: 'Screenshot data is missing.' };
    
    return {
      success: true,
      userMessage: `Window screenshot captured: ${screenshot.width}x${screenshot.height}`,
      data: {
        width: screenshot.width,
        height: screenshot.height,
        format: screenshot.format,
        capturedAt: screenshot.capturedAt,
        data: screenshot.data,
        dataLength: screenshot.data.length,
      },
    };
  },
};


