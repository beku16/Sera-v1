import { ACTION_ERROR_CODES, ActionError } from './errors';
import { Action, ActionExecutionContext, ActionExecutionResult, ActionExecutor, VerificationResult } from './types';
import { ClipboardProvider, defaultClipboardProvider } from '../clipboard/ClipboardManager';

export class ClipboardExecutor implements ActionExecutor {
  public readonly name = 'ClipboardExecutor';
  private readonly savedClipboard: string[] = [];

  constructor(private readonly provider: ClipboardProvider = defaultClipboardProvider) {}

  public canHandle(action: Action): boolean {
    return ['clipboard.get', 'clipboard.set', 'clipboard.save', 'clipboard.restore'].includes(action.type);
  }

  public async execute(action: Action, _context: ActionExecutionContext): Promise<ActionExecutionResult> {
    if (action.type === 'clipboard.get') {
      const content = await this.provider.get();
      if (content === null) throw new ActionError(ACTION_ERROR_CODES.CLIPBOARD_UNAVAILABLE, 'Clipboard read failed or is unavailable.');
      return { result: { operation: 'get', content, length: content.length } };
    }

    if (action.type === 'clipboard.save') {
      const content = await this.provider.get();
      if (content === null) throw new ActionError(ACTION_ERROR_CODES.CLIPBOARD_UNAVAILABLE, 'Clipboard could not be saved.');
      this.savedClipboard.push(content);
      return { result: { operation: 'save', length: content.length, depth: this.savedClipboard.length } };
    }

    if (action.type === 'clipboard.restore') {
      const content = this.savedClipboard.at(-1);
      if (content === undefined) throw new ActionError(ACTION_ERROR_CODES.CLIPBOARD_UNAVAILABLE, 'No saved clipboard snapshot is available.');
      if (!await this.provider.set(content)) throw new ActionError(ACTION_ERROR_CODES.CLIPBOARD_WRITE_FAILED, 'Clipboard restoration failed.');
      this.savedClipboard.pop();
      return { result: { operation: 'restore', length: content.length, depth: this.savedClipboard.length } };
    }

    if (action.type === 'clipboard.set') {
      const parameters = action.parameters as Record<string, unknown>;
      const content = typeof parameters.content === 'string' ? parameters.content : String(parameters.content || '');
      if (!content) throw new ActionError(ACTION_ERROR_CODES.INVALID_ARGUMENT, 'Clipboard content must be a non-empty string.');
      if (!await this.provider.set(content)) throw new ActionError(ACTION_ERROR_CODES.CLIPBOARD_WRITE_FAILED, 'Clipboard write operation failed.');
      return { result: { operation: 'set', length: content.length } };
    }

    throw new ActionError(ACTION_ERROR_CODES.ACTION_NOT_SUPPORTED, `Clipboard action "${action.type}" is not supported.`);
  }

  public async verify(action: Action, execution: ActionExecutionResult): Promise<VerificationResult> {
    const result = execution.result as { operation?: string; length?: number } | undefined;
    if (action.type === 'clipboard.get') {
      return result?.operation === 'get' && typeof result.length === 'number' && result.length > 0
        ? { status: 'success', message: 'Clipboard content retrieved.', details: { length: result.length } }
        : { status: 'failure', message: 'Clipboard appears to be empty or invalid.' };
    }
    if (action.type === 'clipboard.save' || action.type === 'clipboard.restore') {
      const expected = action.type === 'clipboard.save' ? 'save' : 'restore';
      return result?.operation === expected && typeof result.length === 'number'
        ? { status: 'success', message: 'Clipboard ' + expected + ' operation completed.' }
        : { status: 'failure', message: 'Clipboard ' + expected + ' result was invalid.' };
    }
    if (action.type === 'clipboard.set') {
      const parameters = action.parameters as Record<string, unknown>;
      const expected = typeof parameters.content === 'string' ? parameters.content : String(parameters.content || '');

      // CRITICAL FIX: The previous implementation called `provider.get()`
      // exactly once after `provider.set()` and compared the result. On
      // Windows, `Set-Clipboard` posts to the OLE clipboard
      // asynchronously; the next `Get-Clipboard` call (in a separate
      // PowerShell process) may return the OLD clipboard contents
      // because the new content hasn't propagated yet. The verify then
      // mismatches and returns 'failure' — exactly the user-reported
      // "clipboard write verification fails" symptom.
      //
      // We now do a bounded retry loop: 5 attempts × 80ms = up to 400ms
      // total. On each attempt, read the clipboard and compare to the
      // expected value. If any attempt matches, return success. If all
      // 5 attempts mismatch, return failure with a detailed message
      // showing the last observed value.
      //
      // We also use `=== null` (not `!verification`) so that empty-
      // string clipboard reads are correctly distinguished from "no
      // clipboard available." Previously `if (!verification)` treated an
      // empty string as falsy and returned the wrong failure reason.
      const MAX_ATTEMPTS = 5;
      const RETRY_DELAY_MS = 80;
      let lastObserved: string | null = null;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const observed = await this.provider.get();
        if (observed === null) {
          // Clipboard backend reported unavailable — no point retrying,
          // the underlying OLE / X11 / Wayland backend is broken.
          return { status: 'failure', message: 'Clipboard verification failed: clipboard backend returned null after set.' };
        }
        if (observed === expected) {
          return {
            status: 'success',
            message: 'Clipboard content verified after set.',
            details: { length: expected.length, attempts: attempt + 1 },
          };
        }
        lastObserved = observed;
        if (attempt < MAX_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
      return {
        status: 'failure',
        message: `Clipboard content did not match expected value after ${MAX_ATTEMPTS} retries (last observed length ${lastObserved?.length ?? 0}, expected length ${expected.length}). This is likely a clipboard backend race condition; the write itself succeeded.`,
        details: {
          expectedLength: expected.length,
          lastObservedLength: lastObserved?.length ?? 0,
          attempts: MAX_ATTEMPTS,
        },
      };
    }
    return { status: 'failure', message: 'Clipboard verification is not supported for this action.' };
  }
}
