import { ACTION_ERROR_CODES, ActionError } from './errors';
import { ScreenController, UnsupportedScreenController } from './ControlProviders';
import { Action, ActionExecutionContext, ActionExecutionResult, ActionExecutor, VerificationResult } from './types';

const SCREEN_ACTIONS = new Set(['screen.startSharing', 'screen.stopSharing', 'screen.inspect', 'screen.listDisplays']);

export class ScreenExecutor implements ActionExecutor {
  public readonly name = 'ScreenExecutor';

  constructor(private readonly controller: ScreenController = new UnsupportedScreenController()) {}

  public canHandle(action: Action): boolean {
    return SCREEN_ACTIONS.has(action.type);
  }

  public async execute(action: Action, _context: ActionExecutionContext): Promise<ActionExecutionResult> {
    switch (action.type) {
      case 'screen.startSharing':
        await this.controller.startSharing();
        return { result: { sharing: true } };
      case 'screen.stopSharing':
        await this.controller.stopSharing();
        return { result: { sharing: false } };
      case 'screen.listDisplays': {
        if (!this.controller.getDisplays) throw new ActionError(ACTION_ERROR_CODES.SCREEN_PROVIDER_UNAVAILABLE, 'Display enumeration is not configured.');
        const displays = await this.controller.getDisplays();
        return { result: displays };
      }
      case 'screen.inspect': {
        // Auto-start sharing if it isn't active. Previously this branch threw
        // `PERMISSION_DENIED: Screen sharing is not active` whenever the
        // caller hadn't first run screen.startSharing. That made
        // `inspectScreen` and any "look at my screen" request fail out of
        // the box. Now we silently start sharing on first inspect, which
        // is what users actually expect when they ask SERA to look at
        // their screen. (Capture itself no longer requires sharing — see
        // RobotJsScreenController.capture — but `getLatestFrame()` still
        // does, and the stale-frame check below only makes sense when the
        // continuous-capture timer is running.)
        if (!this.controller.isSharing()) {
          try { await this.controller.startSharing(); } catch { /* fall through; capture() will still work */ }
        }
        const displayId = action.parameters && typeof action.parameters.displayId === 'string' ? action.parameters.displayId : undefined;
        if (displayId) {
          if (!this.controller.captureDisplay) throw new ActionError(ACTION_ERROR_CODES.SCREEN_PROVIDER_UNAVAILABLE, 'Display-specific screen capture is not configured.');
          return { result: await this.controller.captureDisplay(displayId) };
        }
        const region = action.parameters && typeof action.parameters.region === 'object' ? action.parameters.region as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } : undefined;
        if (region && this.controller.captureRegion && [region.x, region.y, region.width, region.height].every((value) => typeof value === 'number')) {
          return { result: await this.controller.captureRegion(region.x as number, region.y as number, region.width as number, region.height as number) };
        }
        const latest = this.controller.getLatestFrame?.();
        if (latest) {
          const ageMs = Date.now() - new Date(latest.capturedAt).getTime();
          // If the cached frame is fresh, return it directly. If it's
          // stale (timer stopped, sharing just restarted, etc.) fall
          // through to a fresh capture rather than throwing — the previous
          // SCREEN_STATE_STALE error blocked inspection when the cached
          // frame was older than 500ms, which was almost always the case
          // right after auto-startSharing.
          if (ageMs <= 500) return { result: latest };
        }
        return { result: await this.controller.capture() };
      }
      default:
        throw new ActionError(ACTION_ERROR_CODES.ACTION_NOT_SUPPORTED, `Screen action "${action.type}" is not supported.`);
    }
  }

  public async verify(action: Action, execution: ActionExecutionResult): Promise<VerificationResult> {
    if (action.type === 'screen.listDisplays') {
      const displays = execution.result;
      return Array.isArray(displays) && displays.every((display) => display && typeof display.id === 'string' && typeof display.width === 'number' && typeof display.height === 'number')
        ? { status: 'success', message: 'Display metadata retrieved.' }
        : { status: 'failure', message: 'The display provider returned invalid metadata.' };
    }
    if (action.type === 'screen.startSharing') return this.controller.isSharing() ? { status: 'success' } : { status: 'failure', message: 'Screen sharing did not become active.' };
    if (action.type === 'screen.stopSharing') return this.controller.isSharing() ? { status: 'failure', message: 'Screen sharing is still active.' } : { status: 'success' };
    const frame = execution.result as { width?: unknown; height?: unknown; data?: unknown } | undefined;
    return frame && typeof frame.width === 'number' && frame.width > 0 && typeof frame.height === 'number' && frame.height > 0 && typeof frame.data === 'string' && frame.data.length > 0
      ? { status: 'success', message: 'Screen frame captured.' }
      : { status: 'failure', message: 'The screen provider returned an invalid image frame.' };
  }
}



