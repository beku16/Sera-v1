import { ACTION_ERROR_CODES, ActionError } from './errors';
import { InputController, UnsupportedInputController } from './ControlProviders';
import { Action, ActionExecutionContext, ActionExecutionResult, ActionExecutor, VerificationResult } from './types';
import type { WindowControlProvider } from './WindowExecutor';

export type InputActionVerifier = (action: Action, execution: ActionExecutionResult) => Promise<VerificationResult>;
export interface InputActionObserver {
  observe(): Promise<unknown>;
  verify(action: Action, before: unknown, after: unknown, execution: ActionExecutionResult): Promise<VerificationResult>;
}

const INPUT_ACTIONS = new Set(['input.type', 'input.press', 'input.hotkey', 'input.click', 'input.move', 'input.scroll', 'input.drag']);
const VALID_KEYS = new Set([
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
  'enter', 'escape', 'tab', 'backspace', 'delete', 'up', 'down', 'left', 'right',
  'home', 'end', 'pageup', 'pagedown', 'insert', 'space', 'capslock', 'printscreen',
  'control', 'ctrl', 'alt', 'shift', 'win',
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
]);

// Models routinely send decorated button names — "left click", "Left",
// "the left mouse button", "secondary" — instead of the bare token. Words
// that carry no button meaning are stripped before matching; what remains
// is matched against common synonyms so a near-miss never hard-fails the
// whole action (a failed click used to surface as INVALID_ARGUMENT and the
// assistant had to re-ask the user for permission to try again).
const BUTTON_NOISE_WORDS = new Set(['click', 'button', 'mouse', 'key', 'the', 'a', 'an', 'on', 'press']);

const BUTTON_ALIASES: Record<string, 'left' | 'middle' | 'right'> = {
  left: 'left', l: 'left', primary: 'left', main: 'left', normal: 'left', standard: 'left', regular: 'left', '1': 'left',
  middle: 'middle', mid: 'middle', center: 'middle', wheel: 'middle', '2': 'middle',
  right: 'right', r: 'right', secondary: 'right', context: 'right', contextmenu: 'right', '3': 'right',
};

export class InputExecutor implements ActionExecutor {
  public readonly name = 'InputExecutor';

  constructor(
    private readonly controller: InputController = new UnsupportedInputController(),
    private readonly actionVerifier?: InputActionVerifier,
    private readonly observer?: InputActionObserver,
    // Optional window provider used to bring a target application back to
    // the foreground before sending keystrokes/mouse events. Windows
    // delivers all keyboard input to whichever top-level window currently
    // has focus; if focus has drifted (the user clicked the SERA window,
    // a notification popped up, etc.) keystrokes go to the wrong window.
    // Allowing the caller to specify `focusApplication` per-call makes
    // input reliable regardless of intervening focus changes.
    private readonly windowProvider?: WindowControlProvider,
  ) {}

  public canHandle(action: Action): boolean {
    return INPUT_ACTIONS.has(action.type);
  }

  private async focusTargetApplication(parameters: Record<string, unknown>): Promise<void> {
    const focusApp = parameters.focusApplication;
    const focusTitle = parameters.focusWindow;
    if (!this.windowProvider || (typeof focusApp !== 'string' && typeof focusTitle !== 'string')) return;
    try {
      const windows = await this.windowProvider.list();
      const target = windows.find((windowInfo) => {
        const app = windowInfo.application.toLowerCase();
        const title = windowInfo.title.toLowerCase();
        return (typeof focusApp === 'string' && (app.includes(focusApp.toLowerCase()) || title.includes(focusApp.toLowerCase())))
          || (typeof focusTitle === 'string' && title.includes(focusTitle.toLowerCase()));
      });
      if (target) await this.windowProvider.focus(target);
    } catch {
      // Best-effort — input will still be attempted on whatever has focus.
    }
  }

  public async execute(action: Action, _context: ActionExecutionContext): Promise<ActionExecutionResult> {
    const parameters = action.parameters as Record<string, unknown>;
    // If the caller asked us to target a specific application, bring it to
    // the foreground before any keyboard/mouse I/O. This is the only
    // reliable way to guarantee keystrokes land in the intended window
    // after focus has drifted between the launch and the input call.
    await this.focusTargetApplication(parameters);
    const before = this.observer ? await this.observer.observe() : undefined;
    let execution: ActionExecutionResult;
    switch (action.type) {
      case 'input.type': {
        const text = this.requireString(parameters.text, 'text');
        await this.controller.type(text);
        execution = { result: { operation: 'type', length: text.length } }; break;
      }
      case 'input.press':
        await this.controller.press(this.requireKey(parameters.key));
        execution = { result: { operation: 'press' } }; break;
      case 'input.hotkey': {
        if (!Array.isArray(parameters.keys) || parameters.keys.length === 0 || parameters.keys.some((key) => typeof key !== 'string')) {
          throw new ActionError(ACTION_ERROR_CODES.INVALID_ARGUMENT, 'Hotkeys require a non-empty array of key names.');
        }
        const keys = (parameters.keys as string[]).map((key) => this.requireKey(key));
        await this.controller.hotkey(keys);
        execution = { result: { operation: 'hotkey', keys } }; break;
      }
      case 'input.click': {
        const button = this.normalizeButton(parameters.button, 'Click', 'left');
        const rawClicks = parameters.clicks === undefined ? 1 : parameters.clicks;
        const clicks = typeof rawClicks === 'string' ? Number(rawClicks) : rawClicks;
        if (clicks !== 1 && clicks !== 2) throw new ActionError(ACTION_ERROR_CODES.INVALID_ARGUMENT, 'Click count must be one or two.');
        const x = parameters.x === undefined ? undefined : this.requireNumber(parameters.x, 'x');
        const y = parameters.y === undefined ? undefined : this.requireNumber(parameters.y, 'y');
        if ((x === undefined) !== (y === undefined)) throw new ActionError(ACTION_ERROR_CODES.INVALID_COORDINATES, 'Click coordinates must include both x and y.');
        if (x !== undefined && y !== undefined) await this.validateCoordinates(x, y);
        await this.controller.click(button, clicks, x, y);
        execution = { result: { operation: 'click', button, clicks, ...(x === undefined ? {} : { x, y }) } }; break;
      }
      case 'input.move':
        {
          const x = this.requireNumber(parameters.x, 'x');
          const y = this.requireNumber(parameters.y, 'y');
          await this.validateCoordinates(x, y);
          await this.controller.move(x, y);
          execution = { result: { operation: 'move', x, y } }; break;
        }
      case 'input.scroll':
        await this.controller.scroll(this.requireNumber(parameters.delta, 'delta'));
        execution = { result: { operation: 'scroll', delta: parameters.delta } }; break;
      case 'input.drag': {
        const fromX = this.requireNumber(parameters.fromX, 'fromX');
        const fromY = this.requireNumber(parameters.fromY, 'fromY');
        const toX = this.requireNumber(parameters.toX, 'toX');
        const toY = this.requireNumber(parameters.toY, 'toY');
        const button = this.normalizeButton(parameters.button, 'Drag', 'left');
        await this.validateCoordinates(fromX, fromY);
        await this.validateCoordinates(toX, toY);
        await this.controller.drag(fromX, fromY, toX, toY, button);
        execution = { result: { operation: 'drag', fromX, fromY, toX, toY, button } }; break;
      }
      default:
        throw new ActionError(ACTION_ERROR_CODES.ACTION_NOT_SUPPORTED, `Input action "${action.type}" is not supported.`);
    }

    if (this.observer) {
      const after = await this.observer.observe();
      execution.verification = await this.observer.verify(action, before, after, execution);
    }
    return execution;
  }

  public async verify(action: Action, execution: ActionExecutionResult): Promise<VerificationResult> {
    if (this.actionVerifier) return this.actionVerifier(action, execution);
    return this.controller.verify(action.type, execution.result);
  }

  private requireString(value: unknown, name: string): string {
    if (typeof value !== 'string' || !value) throw new ActionError(ACTION_ERROR_CODES.INVALID_ARGUMENT, `${name} must be a non-empty string.`);
    return value;
  }

  private requireNumber(value: unknown, name: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new ActionError(ACTION_ERROR_CODES.INVALID_ARGUMENT, `${name} must be a finite number.`);
    return value;
  }

  /**
   * Accept any reasonably unambiguous mouse-button value. Only truly
   * unknown values are rejected, and the message names the offending value
   * so the model can self-correct on the next turn.
   */
  private normalizeButton(value: unknown, action: 'Click' | 'Drag', fallback: 'left' | 'middle' | 'right'): 'left' | 'middle' | 'right' {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'string') {
      const words = value.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== '' && !BUTTON_NOISE_WORDS.has(word));
      for (const word of words) {
        const mapped = BUTTON_ALIASES[word];
        if (mapped) return mapped;
      }
    }
    throw new ActionError(ACTION_ERROR_CODES.INVALID_ARGUMENT, `${action} button "${String(value)}" is not recognized — use left, middle, or right.`);
  }

  private requireKey(value: unknown): string {
    const key = this.requireString(value, 'key').toLowerCase();
    if (!VALID_KEYS.has(key)) throw new ActionError(ACTION_ERROR_CODES.INVALID_KEY, `Key "${key}" is not supported.`);
    return key;
  }

  private async validateCoordinates(x: number, y: number): Promise<void> {
    if (this.controller.validateCoordinates) await this.controller.validateCoordinates(x, y);
  }
}
