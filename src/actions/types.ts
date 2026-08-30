export type ActionStatus = 'queued' | 'executing' | 'verifying' | 'succeeded' | 'failed' | 'inconclusive' | 'cancelled';

export type VerificationStatus = 'success' | 'failure' | 'inconclusive';

export type ActionType =
  | 'application.launch'
  | 'application.close'
  | 'input.type'
  | 'input.press'
  | 'input.hotkey'
  | 'input.click'
  | 'input.move'
  | 'input.scroll'
  | 'input.drag'
  | 'clipboard.get'
  | 'clipboard.set'
  | 'clipboard.save'
  | 'clipboard.restore'
  | 'screen.startSharing'
  | 'screen.stopSharing'
  | 'screen.inspect'
  | 'screen.listDisplays'
  | 'window.getActive'
  | 'window.list'
  | 'window.focus'
  | 'window.minimize'
  | 'window.maximize'
  | 'window.restore'
  | 'window.close'
  | 'vision.inspect'
  | 'vision.locate'
  | 'browser.open'
  | 'browser.navigate'
  | 'browser.back'
  | 'browser.forward'
  | 'browser.reload'
  | 'browser.newTab'
  | 'browser.switchTab'
  | 'browser.closeTab'
  | 'browser.click'
  | 'browser.type'
  | 'browser.press'
  | 'browser.scroll'
  | 'browser.find'
  | 'browser.tabs'
  | 'browser.read'
  | 'browser.media'
  | 'browser.download'
  | 'screenshot.capture'
  | 'screenshot.captureWindow'
  | (string & {});

export interface Action<TParameters = Record<string, unknown>, TResult = unknown> {
  taskId: string;
  actionId: string;
  type: ActionType;
  parameters: TParameters;
  status: ActionStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: TResult;
  error?: ActionErrorDetails;
  verification?: VerificationResult;
}

export interface ActionErrorDetails {
  code: string;
  message: string;
  details?: unknown;
}

export interface VerificationResult {
  status: VerificationStatus;
  message?: string;
  details?: unknown;
}

export interface ActionExecutionContext {
  signal: AbortSignal;
  log: (event: ActionLogEvent) => void;
}

export interface ActionExecutionResult<TResult = unknown> {
  result?: TResult;
  verification?: VerificationResult;
}

export interface ActionExecutor {
  readonly name: string;
  canHandle(action: Action): boolean;
  execute(action: Action, context: ActionExecutionContext): Promise<ActionExecutionResult>;
  verify(
    action: Action,
    execution: ActionExecutionResult,
    context: ActionExecutionContext
  ): Promise<VerificationResult>;
  cancel?(action: Action): Promise<void> | void;
}

export interface ActionLogEvent {
  taskId: string;
  actionId: string;
  type: ActionType;
  executor: string;
  parameters: unknown;
  executionTimeMs?: number;
  verification?: VerificationResult;
  error?: ActionErrorDetails;
  recoveryAttempt?: string;
}

export interface CreateActionInput<TParameters = Record<string, unknown>> {
  taskId?: string;
  actionId?: string;
  type: ActionType;
  parameters: TParameters;
}

export interface ActionManagerOptions {
  idFactory?: () => string;
  now?: () => string;
  logger?: (event: ActionLogEvent) => void;
}






