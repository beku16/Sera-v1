import { ACTION_ERROR_CODES, ActionError } from './errors';
import type { VerificationResult } from './types';

export interface InputController {
  type(text: string): Promise<void>;
  press(key: string): Promise<void>;
  hotkey(keys: string[]): Promise<void>;
  click(button: 'left' | 'middle' | 'right', clicks: number, x?: number, y?: number): Promise<void>;
  move(x: number, y: number): Promise<void>;
  scroll(delta: number): Promise<void>;
  drag(fromX: number, fromY: number, toX: number, toY: number, button: 'left' | 'middle' | 'right'): Promise<void>;
  verify(operation: string, result: unknown): Promise<VerificationResult>;
  validateCoordinates?(x: number, y: number): Promise<void> | void;
}

export interface ScreenFrame {
  frameId?: number;
  width: number;
  height: number;
  displayId?: string;
  originX?: number;
  originY?: number;
  scaleX?: number;
  scaleY?: number;
  capturedAt: string;
  cursor?: { x: number; y: number; visible: boolean; displayId?: string } | null;
  // 'raw-bgra' is the format robotjs.screen.capture() returns on Windows
  // (4 bytes per pixel, byte order B, G, R, A — see rawBgraFrameToPng).
  // 'png' is the format the Linux scrot / gnome-screenshot / ImageMagick
  // `import` path returns (already-encoded PNG bytes, base64-encoded as a
  // string for transport). frameToPng handles both formats.
  format?: 'raw-bgra' | 'png';
  bytesPerPixel?: number;
  data?: string;
}

export interface DisplayInfo {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isPrimary: boolean;
}

export type ScreenSharingState = 'OFF' | 'STARTING' | 'ON' | 'STOPPING' | 'ERROR';

export interface ScreenController {
  startSharing(): Promise<void>;
  stopSharing(): Promise<void>;
  isSharing(): boolean;
  getSharingState?(): ScreenSharingState;
  capture(): Promise<ScreenFrame>;
  getLatestFrame?(): ScreenFrame | null;
  getDisplays?(): Promise<DisplayInfo[]> | DisplayInfo[];
  captureDisplay?(displayId: string): Promise<ScreenFrame>;
  captureRegion?(x: number, y: number, width: number, height: number): Promise<ScreenFrame>;
}

export class UnsupportedInputController implements InputController {
  private unsupported(): never {
    throw new ActionError(ACTION_ERROR_CODES.ACTION_NOT_SUPPORTED, 'Native keyboard and mouse control is not configured.');
  }
  async type(_text: string): Promise<void> { this.unsupported(); }
  async press(_key: string): Promise<void> { this.unsupported(); }
  async hotkey(_keys: string[]): Promise<void> { this.unsupported(); }
  async click(_button: 'left' | 'middle' | 'right', _clicks: number, _x?: number, _y?: number): Promise<void> { this.unsupported(); }
  async move(_x: number, _y: number): Promise<void> { this.unsupported(); }
  async scroll(_delta: number): Promise<void> { this.unsupported(); }
  async drag(_fromX: number, _fromY: number, _toX: number, _toY: number, _button: 'left' | 'middle' | 'right'): Promise<void> { this.unsupported(); }
  async verify(_operation: string, _result: unknown): Promise<VerificationResult> { this.unsupported(); }
}

export class UnsupportedScreenController implements ScreenController {
  private sharing = false;

  async startSharing(): Promise<void> {
    throw new ActionError(ACTION_ERROR_CODES.PERMISSION_DENIED, 'Screen sharing requires explicit capture permission and is not configured.');
  }

  async stopSharing(): Promise<void> {
    this.sharing = false;
  }

  isSharing(): boolean {
    return this.sharing;
  }

  async capture(): Promise<ScreenFrame> {
    throw new ActionError(ACTION_ERROR_CODES.ACTION_NOT_SUPPORTED, 'Screen capture is not configured.');
  }
}
