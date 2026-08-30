import { ACTION_ERROR_CODES, ActionError } from './errors';
import { ScreenController, UnsupportedScreenController } from './ControlProviders';
import { Action, ActionExecutionContext, ActionExecutionResult, ActionExecutor, VerificationResult } from './types';
import type { WindowControlProvider, WindowInfo } from './WindowExecutor';
import { frameToPng } from '../vision/screenImage';

export interface ScreenshotResult {
  width: number;
  height: number;
  format: 'png';
  data: string;
  capturedAt: string;
  displayId?: string;
  windowHandle?: string;
}

const SCREENSHOT_ACTIONS = new Set(['screenshot.capture', 'screenshot.captureWindow']);

export class ScreenshotExecutor implements ActionExecutor {
  public readonly name = 'ScreenshotExecutor';

  constructor(
    private readonly controller: ScreenController = new UnsupportedScreenController(),
    private readonly windows?: WindowControlProvider,
  ) {}

  public canHandle(action: Action): boolean {
    return SCREENSHOT_ACTIONS.has(action.type);
  }

  public async execute(action: Action, _context: ActionExecutionContext): Promise<ActionExecutionResult> {
    const parameters = action.parameters as Record<string, unknown>;
    if (!SCREENSHOT_ACTIONS.has(action.type)) {
      throw new ActionError(ACTION_ERROR_CODES.ACTION_NOT_SUPPORTED, `Screenshot action "${action.type}" is not supported.`);
    }

    try {
      let frame;
      let windowHandle: string | undefined;
      const displayId = typeof parameters.displayId === 'string' ? parameters.displayId : undefined;

      if (action.type === 'screenshot.captureWindow') {
        const target = await this.findWindow(parameters);
        if (!this.controller.captureRegion) {
          throw new ActionError(ACTION_ERROR_CODES.ACTION_NOT_SUPPORTED, 'Window-region screenshot capture is not configured.');
        }
        const bounds = target.bounds;
        if (bounds.width <= 0 || bounds.height <= 0) {
          throw new ActionError(ACTION_ERROR_CODES.TARGET_NOT_FOUND, 'The requested window has no capturable bounds.');
        }
        frame = await this.controller.captureRegion(bounds.x, bounds.y, bounds.width, bounds.height);
        windowHandle = target.handle;
      } else if (displayId) {
        if (!this.controller.captureDisplay) throw new ActionError(ACTION_ERROR_CODES.SCREEN_PROVIDER_UNAVAILABLE, 'Display-specific screenshot capture is not configured.');
        frame = await this.controller.captureDisplay(displayId);
      } else {
        frame = await this.controller.capture();
      }

      // Unified frame-to-PNG conversion: handles Windows (robotjs BGRA),
      // Linux (scrot returns base64 PNG directly), and legacy/mock
      // frames (no format set, data is already a base64-encoded string
      // or a mock placeholder).
      //
      // For real frames (raw-bgra or png format), frameToPng produces
      // the correct PNG bytes and we re-encode them as base64 for the
      // JSON wire format.
      //
      // For legacy frames with no format set, we use frame.data
      // directly — frameToPng would decode/re-encode the base64,
      // which is idempotent for real PNG bytes but breaks for mock
      // placeholder strings like 'base64-image-data'. Using data
      // directly preserves the original behaviour for tests and any
      // other unset-format producers.
      let data: string;
      if (frame.format === 'raw-bgra' || frame.format === 'png') {
        data = frameToPng(frame).toString('base64');
      } else {
        data = frame.data || '';
      }
      if (!data) throw new Error('Screen provider returned no image data.');
      return {
        result: {
          width: frame.width,
          height: frame.height,
          format: 'png',
          data,
          capturedAt: new Date().toISOString(),
          ...(displayId ? { displayId } : {}),
          ...(windowHandle ? { windowHandle } : {}),
        },
      };
    } catch (error) {
      if (error instanceof ActionError) throw error;
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new ActionError(ACTION_ERROR_CODES.SCREEN_CAPTURE_FAILED, `Failed to capture screenshot: ${message}`);
    }
  }

  public async verify(_action: Action, execution: ActionExecutionResult): Promise<VerificationResult> {
    const result = execution.result as ScreenshotResult | undefined;
    if (!result || result.width <= 0 || result.height <= 0 || !result.data || result.format !== 'png') {
      return { status: 'failure', message: 'The screenshot provider returned an invalid image frame.' };
    }
    return {
      status: 'success',
      message: 'Screenshot captured successfully.',
      details: { width: result.width, height: result.height, format: result.format, size: result.data.length },
    };
  }

  private async findWindow(parameters: Record<string, unknown>): Promise<WindowInfo> {
    const windowHandle = typeof parameters.windowHandle === 'number' ? String(parameters.windowHandle) : typeof parameters.windowHandle === 'string' ? parameters.windowHandle : undefined;
    const processId = typeof parameters.processId === 'number' ? parameters.processId : undefined;
    if (!windowHandle && processId === undefined) {
      throw new ActionError(ACTION_ERROR_CODES.INVALID_ARGUMENT, 'Either windowHandle or processId must be provided.');
    }
    if (!this.windows) throw new ActionError(ACTION_ERROR_CODES.ACTION_NOT_SUPPORTED, 'Window lookup is not configured.');
    const windows = await this.windows.list();
    const target = windows.find((entry) => (windowHandle && entry.handle === windowHandle) || (processId !== undefined && entry.processId === processId));
    if (!target) throw new ActionError(ACTION_ERROR_CODES.TARGET_NOT_FOUND, 'The requested window was not found.');
    return target;
  }
}
