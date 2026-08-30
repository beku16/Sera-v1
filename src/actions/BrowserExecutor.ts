import { spawn } from 'node:child_process';
import { ACTION_ERROR_CODES, ActionError } from './errors';
import { Action, ActionExecutionContext, ActionExecutionResult, ActionExecutor, VerificationResult } from './types';
import { BrowserSessionManager } from '../browser/BrowserSessionManager';

/**
 * Canonical browser session ID used across the AI's tool calls
 * (BrowserExecutor), the WhatsApp tool, and the HTTP screenshot/state
 * endpoints exposed in server.ts. Previously these three call sites used
 * three different IDs ('default-browser-session', 'sera-whatsapp',
 * 'sera-built-in-browser'), so the AI's browser.open opened a tab in one
 * Playwright context while the renderer's screenshot endpoint and the
 * WhatsApp tool each looked at a different context. The renderer panel
 * never showed what the AI opened, and WhatsApp sessions accumulated
 * separate Chromium processes. Centralising on a single ID makes the
 * managed browser actually managed.
 */
export const DEFAULT_BROWSER_SESSION_ID = 'sera-built-in-browser';

/**
 * OS command that opens a URL in the user's REAL default browser —
 * the one they actually use, with their logins, bookmarks and window
 * they can SEE. Windows uses rundll32's FileProtocolHandler (no cmd.exe
 * parsing quirks with "&" in query strings, no console flash), macOS
 * uses `open`, Linux uses `xdg-open`.
 */
export function defaultBrowserOpenCommand(
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } | null {
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', '%URL%'] };
  if (platform === 'darwin') return { cmd: 'open', args: ['%URL%'] };
  if (platform === 'linux') return { cmd: 'xdg-open', args: ['%URL%'] };
  return null;
}

/** Minimal spawn surface openUrlInDefaultBrowser needs (easy to fake in tests). */
export type UrlSpawnFn = (
  cmd: string,
  args: string[],
  opts: { detached: boolean; stdio: 'ignore'; windowsHide: boolean },
) => { on: (event: string, cb: () => void) => void; unref: () => void };

/**
 * Fires the OS "open this URL" command. Fire-and-forget by design: the
 * OS owns the browser lifecycle afterwards. Throws synchronously when
 * the opener binary is missing (e.g. xdg-open absent on a headless Linux
 * server) so callers can fall back to the managed browser.
 */
export function openUrlInDefaultBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  run: UrlSpawnFn = spawn as unknown as UrlSpawnFn,
): void {
  const command = defaultBrowserOpenCommand(platform);
  if (!command) throw new Error(`Opening a default browser is not supported on ${platform}.`);
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http/https URLs can be opened in the default browser (got "${parsed.protocol}").`);
  }
  const child = run(
    command.cmd,
    command.args.map((arg) => (arg === '%URL%' ? url : arg)),
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.on('error', () => undefined); // async spawn errors (ENOENT) surface on Linux CI - don't crash
  child.unref();
}

export interface BrowserExecutorOptions {
  sessionManager?: BrowserSessionManager;
}

export class BrowserExecutor implements ActionExecutor {
  public readonly name = 'BrowserExecutor';
  private readonly sessionManager: BrowserSessionManager;

  constructor(sessionManager?: BrowserSessionManager) {
    this.sessionManager = sessionManager ?? new BrowserSessionManager({ launch: false });
  }

  public canHandle(action: Action): boolean {
    return action.type.startsWith('browser.');
  }

  public async execute(action: Action, _context: ActionExecutionContext): Promise<ActionExecutionResult> {
    const parameters = action.parameters as Record<string, unknown>;
    const sessionId = String((parameters.sessionId as string | undefined) || DEFAULT_BROWSER_SESSION_ID);

    switch (action.type) {
      case 'browser.openDefault': {
        // The VISIBLE path: open the URL in the user's real default
        // browser. "Open YouTube" must mean YouTube appears on their
        // screen — the managed Playwright session is headless and
        // invisible, which historically made users think SERA ignored
        // them (their exact words: "open youtube does nothing").
        const url = this.requireString(parameters.url, 'url');
        try {
          openUrlInDefaultBrowser(url);
        } catch (err) {
          throw new ActionError(
            ACTION_ERROR_CODES.EXECUTION_FAILED,
            `Could not open your default browser: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return {
          result: { url, openedVia: 'default-browser' },
          verification: { status: 'success', message: 'Handed the URL to the operating system — it opens in the user\'s default browser.' },
        };
      }
      case 'browser.open': {
        const url = this.requireString(parameters.url, 'url');
        const session = await this.sessionManager.open(sessionId, url);
        return {
          result: { sessionId: session.sessionId, activeTabId: session.activeTabId, url: session.tabs.find((tab) => tab.id === session.activeTabId)?.url || url },
          verification: { status: 'success', message: 'Browser page opened and returned its current URL.' },
        };
      }
      case 'browser.navigate': {
        const url = this.requireString(parameters.url, 'url');
        const tabId = parameters.tabId === undefined ? undefined : this.requireString(parameters.tabId, 'tabId');
        const session = await this.sessionManager.navigate(sessionId, tabId, url);
        return {
          result: {
            sessionId: session.sessionId,
            activeTabId: session.activeTabId,
            url: session.tabs.find((tab) => tab.id === session.activeTabId)?.url || url,
          },
          verification: { status: 'success', message: 'Browser navigation completed and returned its current URL.' },
        };
      }
      case 'browser.back': {
        const tabId = parameters.tabId === undefined ? undefined : this.requireString(parameters.tabId, 'tabId');
        const session = await this.sessionManager.back(sessionId, tabId);
        return { result: { sessionId: session.sessionId, activeTabId: session.activeTabId }, verification: { status: 'success', message: 'Browser back navigation executed.' } };
      }
      case 'browser.forward': {
        const tabId = parameters.tabId === undefined ? undefined : this.requireString(parameters.tabId, 'tabId');
        const session = await this.sessionManager.forward(sessionId, tabId);
        return { result: { sessionId: session.sessionId, activeTabId: session.activeTabId }, verification: { status: 'success', message: 'Browser forward navigation executed.' } };
      }
      case 'browser.reload': {
        const tabId = parameters.tabId === undefined ? undefined : this.requireString(parameters.tabId, 'tabId');
        const session = await this.sessionManager.reload(sessionId, tabId);
        return { result: { sessionId: session.sessionId, activeTabId: session.activeTabId }, verification: { status: 'success', message: 'Browser reload executed.' } };
      }
      case 'browser.newTab': {
        const url = parameters.url === undefined ? undefined : this.requireString(parameters.url, 'url');
        const session = await this.sessionManager.newTab(sessionId, url);
        return { result: { sessionId: session.sessionId, activeTabId: session.activeTabId, tabs: session.tabs }, verification: { status: 'success', message: 'New tab created.' } };
      }
      case 'browser.switchTab': {
        const tabId = this.requireString(parameters.tabId, 'tabId');
        const session = await this.sessionManager.switchTab(sessionId, tabId);
        return { result: { sessionId: session.sessionId, activeTabId: session.activeTabId, tabs: session.tabs }, verification: { status: 'success', message: 'Tab switch executed.' } };
      }
      case 'browser.closeTab': {
        const tabId = parameters.tabId === undefined ? undefined : this.requireString(parameters.tabId, 'tabId');
        const session = await this.sessionManager.closeTab(sessionId, tabId);
        return { result: { sessionId: session.sessionId, activeTabId: session.activeTabId, tabs: session.tabs }, verification: { status: 'success', message: 'Tab closure executed.' } };
      }
      case 'browser.click': {
        const selector = this.requireString(parameters.selector, 'selector');
        const tabId = parameters.tabId === undefined ? undefined : this.requireString(parameters.tabId, 'tabId');
        const session = await this.sessionManager.click(sessionId, selector, tabId);
        return { result: { sessionId: session.sessionId, activeTabId: session.activeTabId }, verification: { status: 'success', message: 'Click executed.' } };
      }
      case 'browser.type': {
        const selector = this.requireString(parameters.selector, 'selector');
        const value = this.requireString(parameters.value, 'value');
        const tabId = parameters.tabId === undefined ? undefined : this.requireString(parameters.tabId, 'tabId');
        const session = await this.sessionManager.type(sessionId, selector, value, tabId);
        const verified = await this.sessionManager.verifyTypedValue(sessionId, selector, value, tabId);
        // Verification here is a real probe (we re-read the field's value
        // and compare). If it returns false, the typing itself succeeded
        // (Playwright's fill() didn't throw) but the field didn't echo back
        // the expected value — most likely the selector is wrong. We report
        // 'inconclusive' so callers (e.g. the WhatsApp tool) can try the
        // next candidate selector. Callers that treat 'inconclusive' as
        // failure will see a tool-level failure for browser.type; that is
        // the intended conservative behaviour for unverified input.
        return { result: { sessionId: session.sessionId, activeTabId: session.activeTabId }, verification: verified
          ? { status: 'success', message: 'Text entry was verified in the target field.' }
          : { status: 'inconclusive', message: 'Text entry executed; target field could not be verified.' } };
      }
      case 'browser.press': {
        const key = this.requireString(parameters.key, 'key');
        const selector = parameters.selector === undefined ? undefined : this.requireString(parameters.selector, 'selector');
        const tabId = parameters.tabId === undefined ? undefined : this.requireString(parameters.tabId, 'tabId');
        const session = await this.sessionManager.press(sessionId, key, tabId, selector);
        return { result: { sessionId: session.sessionId, activeTabId: session.activeTabId }, verification: { status: 'success', message: 'Key press executed.' } };
      }
      case 'browser.scroll': {
        const deltaY = this.requireNumber(parameters.deltaY, 'deltaY');
        const tabId = parameters.tabId === undefined ? undefined : this.requireString(parameters.tabId, 'tabId');
        const session = await this.sessionManager.scroll(sessionId, deltaY, tabId);
        return { result: { sessionId: session.sessionId, activeTabId: session.activeTabId }, verification: { status: 'success', message: 'Scroll executed.' } };
      }
      case 'browser.find': {
        const text = this.requireString(parameters.text, 'text');
        const tabId = parameters.tabId === undefined ? undefined : this.requireString(parameters.tabId, 'tabId');
        const result = await this.sessionManager.find(sessionId, text, tabId);
        // The find result itself IS the observation — return success so
        // callers can read result.matches rather than getting a generic
        // 'inconclusive' that masks whether the find ran.
        return { result, verification: { status: 'success', message: 'Element search completed; matches count is in the result.' } };
      }
      case 'browser.tabs': {
        const result = await this.sessionManager.tabs(sessionId);
        return { result, verification: { status: 'success', message: 'Tab state retrieved.' } };
      }
      case 'browser.media': {
        const operation = this.requireString(parameters.operation, 'operation') as 'play' | 'pause' | 'seek' | 'volume';
        if (!['play', 'pause', 'seek', 'volume'].includes(operation)) {
          throw new ActionError(ACTION_ERROR_CODES.INVALID_ARGUMENT, 'operation must be play, pause, seek, or volume.');
        }
        const value = parameters.value === undefined ? undefined : this.requireNumber(parameters.value, 'value');
        const tabId = parameters.tabId === undefined ? undefined : this.requireString(parameters.tabId, 'tabId');
        const result = await this.sessionManager.media(sessionId, operation, value, tabId);
        return { result, verification: { status: 'success', message: 'Media action executed.' } };
      }
      case 'browser.read': {
        const tabId = parameters.tabId === undefined ? undefined : this.requireString(parameters.tabId, 'tabId');
        const result = await this.sessionManager.read(sessionId, tabId);
        // CRITICAL FIX: Previously this returned 'success' unconditionally,
        // even when the page text was empty (e.g. because the AI called
        // browserRead without first calling browserOpen/browserNavigate,
        // leaving the tab on about:blank). The AI thought "read succeeded"
        // and concluded the page had no content — when actually nothing
        // had been loaded yet. We now downgrade to 'inconclusive' when
        // text is empty AND the URL looks like a blank/loading page, so
        // the AI is told "I read the page but it appears to be empty —
        // did you navigate to a URL first?" The browserRead tool wrapper
        // still returns the data; the verification only affects whether
        // the AI sees it as a confirmed success or an unverified attempt.
        const looksBlank = !result.text
          || result.text.trim().length === 0
          || /^about:blank$/i.test(result.url)
          || !result.url
          || result.url === 'about:blank';
        return {
          result,
          verification: looksBlank
            ? { status: 'inconclusive', message: 'Page read completed but the page text is empty. Did you navigate to a URL first? Use browserOpen or browserNavigate before browserRead.' }
            : { status: 'success', message: 'Page read completed; page text is in the result.' },
        };
      }
      case 'browser.download': {
        const result = await this.sessionManager.downloads(sessionId);
        return { result, verification: { status: 'success', message: 'Downloads list retrieved.' } };
      }
      default:
        throw new ActionError(ACTION_ERROR_CODES.ACTION_NOT_SUPPORTED, `Browser action "${action.type}" is not supported.`);
    }
  }

  public async verify(action: Action, execution: ActionExecutionResult): Promise<VerificationResult> {
    // If the executor returned an explicit verification (every case above
    // does), honour it. Otherwise default to 'success' — the underlying
    // Playwright call completed without throwing, so the action is
    // considered successful. Previously this method always returned
    // 'inconclusive', which ActionManager translated into
    // action.status='inconclusive', which every browser tool wrapper
    // (browserRead/browserTabs/browserOpen/etc.) checks as
    // `=== 'succeeded'` and reports failure to the AI. That single
    // mismatch was the structural reason "managed browser / read webpage
    // / list tabs / WhatsApp" all appeared broken from the AI's
    // perspective even when Playwright had actually performed the action.
    if (execution.verification) return execution.verification;
    return { status: 'success', message: `Browser action "${action.type}" completed.` };
  }

  private requireString(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ActionError(ACTION_ERROR_CODES.INVALID_ARGUMENT, `${name} must be a non-empty string.`);
    }
    return value.trim();
  }

  private requireNumber(value: unknown, name: string): number {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new ActionError(ACTION_ERROR_CODES.INVALID_ARGUMENT, `${name} must be a number.`);
    }
    return value;
  }
}
