export const ACTION_ERROR_CODES = {
  ACTION_NOT_SUPPORTED: 'ACTION_NOT_SUPPORTED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  NETWORK_REQUIRED: 'NETWORK_REQUIRED',
  APPLICATION_NOT_FOUND: 'APPLICATION_NOT_FOUND',
  APPLICATION_CLOSE_FAILED: 'APPLICATION_CLOSE_FAILED',
  BROWSER_NOT_AVAILABLE: 'BROWSER_NOT_AVAILABLE',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  ACTION_CANCELLED: 'ACTION_CANCELLED',
  INPUT_PROVIDER_UNAVAILABLE: 'INPUT_PROVIDER_UNAVAILABLE',
  SCREEN_PROVIDER_UNAVAILABLE: 'SCREEN_PROVIDER_UNAVAILABLE',
  INVALID_KEY: 'INVALID_KEY',
  INVALID_COORDINATES: 'INVALID_COORDINATES',
  CAPTURE_FAILED: 'CAPTURE_FAILED',
  SCREEN_STATE_STALE: 'SCREEN_STATE_STALE',
  INPUT_EXECUTION_FAILED: 'INPUT_EXECUTION_FAILED',
  FOCUS_FAILED: 'FOCUS_FAILED',
  CLIPBOARD_UNAVAILABLE: 'CLIPBOARD_UNAVAILABLE',
  CLIPBOARD_READ_FAILED: 'CLIPBOARD_READ_FAILED',
  CLIPBOARD_WRITE_FAILED: 'CLIPBOARD_WRITE_FAILED',
  SCREEN_CAPTURE_FAILED: 'SCREEN_CAPTURE_FAILED',
  PLATFORM_NOT_SUPPORTED: 'PLATFORM_NOT_SUPPORTED',
} as const;

export type ActionErrorCode = (typeof ACTION_ERROR_CODES)[keyof typeof ACTION_ERROR_CODES];

export class ActionError extends Error {
  public readonly code: ActionErrorCode;
  public readonly details?: unknown;

  constructor(code: ActionErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ActionError';
    this.code = code;
    this.details = details;
  }

  public toDetails(): { code: ActionErrorCode; message: string; details?: unknown } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function toActionError(error: unknown, fallbackCode: ActionErrorCode = ACTION_ERROR_CODES.EXECUTION_FAILED): ActionError {
  if (error instanceof ActionError) return error;
  return new ActionError(fallbackCode, error instanceof Error ? error.message : String(error));
}



