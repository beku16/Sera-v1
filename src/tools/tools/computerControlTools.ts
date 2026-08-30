import { ACTION_ERROR_CODES } from '../../actions/errors';
import { ActionManager } from '../../actions/ActionManager';
import { ToolDefinition, ToolPermissionLevel } from '../types';

type InputOperation = 'type' | 'press' | 'hotkey' | 'click' | 'move' | 'scroll' | 'drag';
interface InputArgs {
  operation: InputOperation;
  text?: string;
  key?: string;
  keys?: string[];
  button?: 'left' | 'middle' | 'right';
  clicks?: number;
  x?: number;
  y?: number;
  delta?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  // When provided, the executor brings a window matching this application
  // name (or window title, see focusWindow) to the foreground BEFORE the
  // keystroke/mouse action is dispatched. Critical for getting reliable
  // input into a specific app — without this, robotjs faithfully types
  // into whatever window currently has focus (often SERA itself).
  focusApplication?: string;
  focusWindow?: string;
}

const inputOperations: InputOperation[] = ['type', 'press', 'hotkey', 'click', 'move', 'scroll', 'drag'];

export const computerInputTool: ToolDefinition<InputArgs> = {
  name: 'controlComputerInput',
  description: 'Performs one validated keyboard or mouse operation on the local Windows computer. Use focusApplication (e.g. "Calculator", "Notepad") to target a specific app — the window is brought to the foreground before the input is sent, which is required for the keystroke to land in the intended window.',
  permissionLevel: ToolPermissionLevel.SENSITIVE_ACTION,
  capability: 'MOUSE_CONTROL',
  capabilityForArgs: (args) => ((args as { operation?: string })?.operation === 'type' || (args as { operation?: string })?.operation === 'press' || (args as { operation?: string })?.operation === 'hotkey') ? 'KEYBOARD_CONTROL' : 'MOUSE_CONTROL',
  parameters: {
    type: 'OBJECT',
    properties: {
      operation: { type: 'STRING', description: 'Input operation to perform.', enum: inputOperations },
      text: { type: 'STRING', description: 'Text for type.' },
      key: { type: 'STRING', description: 'Recognized key for press.' },
      keys: { type: 'ARRAY', description: 'Recognized keys for a hotkey.', items: { type: 'STRING' } },
      button: { type: 'STRING', description: 'Mouse button.', enum: ['left', 'middle', 'right'] },
      clicks: { type: 'INTEGER', description: 'One click or double click.' },
      x: { type: 'INTEGER', description: 'Screen x coordinate.' },
      y: { type: 'INTEGER', description: 'Screen y coordinate.' },
      delta: { type: 'INTEGER', description: 'Scroll amount.' },
      fromX: { type: 'INTEGER', description: 'Drag start x coordinate.' },
      fromY: { type: 'INTEGER', description: 'Drag start y coordinate.' },
      toX: { type: 'INTEGER', description: 'Drag end x coordinate.' },
      toY: { type: 'INTEGER', description: 'Drag end y coordinate.' },
      focusApplication: { type: 'STRING', description: 'Application name to bring to the foreground before sending input. Use this whenever the keystroke should land in a specific app (e.g. "Calculator").' },
      focusWindow: { type: 'STRING', description: 'Window title (or substring) to bring to the foreground before sending input. Use this when the application name is ambiguous or the window title is more specific.' },
    },
    required: ['operation'],
  },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object') return { valid: false, error: 'Input arguments are required.' };
    const value = args as Record<string, unknown>;
    if (!inputOperations.includes(value.operation as InputOperation)) return { valid: false, error: 'Unknown input operation.' };
    return {
      valid: true,
      parsedArgs: {
        ...value,
        operation: value.operation as InputOperation,
        focusApplication: typeof value.focusApplication === 'string' ? value.focusApplication : undefined,
        focusWindow: typeof value.focusWindow === 'string' ? value.focusWindow : undefined,
      } as unknown as InputArgs,
    };
  },
  async execute(args, context) {
    const manager: ActionManager | undefined = context?.actionManager;
    if (!manager) return { success: false, error: `${ACTION_ERROR_CODES.INPUT_PROVIDER_UNAVAILABLE}: Input control is unavailable.` };
    const action = manager.createAction({ taskId: context?.sessionId, actionId: context?.executionId, type: `input.${args.operation}`, parameters: args });
    const result = await manager.execute(action);
    return result.status === 'succeeded'
      ? { success: true, data: result.result }
      : { success: false, error: `${result.error?.code || ACTION_ERROR_CODES.INPUT_EXECUTION_FAILED}: ${result.error?.message || 'Input operation was not verified.'}` };
  },
};

type ScreenOperation = 'startSharing' | 'stopSharing' | 'inspect';
interface ScreenArgs { operation: ScreenOperation; displayId?: string; }

export const screenControlTool: ToolDefinition<ScreenArgs> = {
  name: 'controlScreen',
  description: 'Explicitly starts or stops local screen access, or inspects the current screen after sharing is enabled.',
  permissionLevel: ToolPermissionLevel.SENSITIVE_ACTION,
  capability: 'SCREEN_INSPECTION',
  capabilityForArgs: (args) => (args as { operation?: string })?.operation === 'startSharing' ? 'SCREEN_CAPTURE' : 'SCREEN_INSPECTION',
  parameters: {
    type: 'OBJECT',
    properties: {
      operation: { type: 'STRING', description: 'Screen operation.', enum: ['startSharing', 'stopSharing', 'inspect'] },
      displayId: { type: 'STRING', description: 'Optional display identifier for a future display-specific capture.' },
    },
    required: ['operation'],
  },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object') return { valid: false, error: 'Screen arguments are required.' };
    const value = args as Record<string, unknown>;
    if (!['startSharing', 'stopSharing', 'inspect'].includes(String(value.operation))) return { valid: false, error: 'Unknown screen operation.' };
    return { valid: true, parsedArgs: { operation: value.operation as ScreenOperation, displayId: typeof value.displayId === 'string' ? value.displayId : undefined } };
  },
  async execute(args, context) {
    const manager: ActionManager | undefined = context?.actionManager;
    if (!manager) return { success: false, error: `${ACTION_ERROR_CODES.SCREEN_PROVIDER_UNAVAILABLE}: Screen control is unavailable.` };
    const action = manager.createAction({ taskId: context?.sessionId, actionId: context?.executionId, type: `screen.${args.operation}`, parameters: { displayId: args.displayId } });
    const result = await manager.execute(action);
    return result.status === 'succeeded'
      ? { success: true, data: result.result }
      : { success: false, error: `${result.error?.code || ACTION_ERROR_CODES.SCREEN_PROVIDER_UNAVAILABLE}: ${result.error?.message || 'Screen operation failed.'}` };
  },
};
export const listDisplaysTool: ToolDefinition<Record<string, never>> = {
  name: 'listDisplays',
  description: 'Lists connected displays with stable IDs, desktop bounds, and primary-display status.',
  permissionLevel: ToolPermissionLevel.READ_ONLY,
  capability: 'COMPUTER_READ',
  parameters: { type: 'OBJECT', properties: {} },
  validateArgs: () => ({ valid: true, parsedArgs: {} }),
  async execute(_args, context) {
    const manager: ActionManager | undefined = context?.actionManager;
    if (!manager) return { success: false, error: `${ACTION_ERROR_CODES.SCREEN_PROVIDER_UNAVAILABLE}: Display enumeration is unavailable.` };
    const action = manager.createAction({ taskId: context?.sessionId, actionId: context?.executionId, type: 'screen.listDisplays', parameters: {} });
    const result = await manager.execute(action);
    return result.status === 'succeeded'
      ? { success: true, data: result.result }
      : { success: false, error: result.error?.message || 'Display enumeration failed.' };
  },
};
