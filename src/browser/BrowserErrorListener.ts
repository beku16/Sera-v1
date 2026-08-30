/**
 * Browser event listeners for error detection
 * Monitors page errors, network failures, and navigation issues
 */

import { BrowserSessionManager } from '../browser/BrowserSessionManager';
import { ErrorMonitor, getErrorMonitor } from '../errors/ErrorMonitor';
import { createErrorEvent } from '../errors/types';

export interface BrowserErrorListenerOptions {
  errorMonitor?: ErrorMonitor;
  enablePageErrors?: boolean;
  enableRequestFailures?: boolean;
  enableNavigationFailures?: boolean;
}

/**
 * Adds error detection hooks for browser events
 * Note: Full page listener setup requires access to Playwright Page objects
 * which are internal to BrowserSessionManager. This class provides the
 * error event creation logic that can be integrated at that level.
 */
export class BrowserErrorListener {
  private readonly errorMonitor: ErrorMonitor;
  private readonly enablePageErrors: boolean;
  private readonly enableRequestFailures: boolean;
  private readonly enableNavigationFailures: boolean;
  private readonly duplicateWindowMs = 4000;
  private readonly recentSignatures = new Map<string, number>();

  constructor(options: BrowserErrorListenerOptions) {
    this.errorMonitor = options.errorMonitor || getErrorMonitor();
    this.enablePageErrors = options.enablePageErrors ?? true;
    this.enableRequestFailures = options.enableRequestFailures ?? true;
    this.enableNavigationFailures = options.enableNavigationFailures ?? true;
  }

  private shouldSuppress(kind: string, sessionId: string, tabId?: string, url?: string): boolean {
    const signature = `${kind}:${sessionId}:${tabId ?? 'none'}:${(url ?? '').replace(/[?#].*$/, '')}`;
    const now = Date.now();
    const previous = this.recentSignatures.get(signature);
    if (previous && now - previous < this.duplicateWindowMs) {
      return true;
    }
    this.recentSignatures.set(signature, now);
    return false;
  }

  /**
   * Report a page error (JavaScript error)
   */
  public reportPageError(sessionId: string, error: Error, url: string, tabId?: string, operation = 'pageerror'): void {
    if (!this.enablePageErrors || this.shouldSuppress('pageerror', sessionId, tabId, url)) return;

    const errorEvent = createErrorEvent(
      'BrowserErrorListener',
      'browser',
      `Page error: ${error.message}`,
      {
        severity: 'warning',
        technicalMessage: error.stack,
        context: {
          sessionId,
          tabId,
          operation,
          url,
          errorType: 'page_error',
        },
        recoverable: false,
      }
    );

    this.errorMonitor.reportError(errorEvent, 'BrowserErrorListener');
  }

  /**
   * Report a request failure (network request failed)
   */
  public reportRequestFailure(sessionId: string, requestUrl: string, currentPageUrl: string, reason?: string, tabId?: string, operation = 'requestfailed'): void {
    if (!this.enableRequestFailures || this.shouldSuppress('requestfailed', sessionId, tabId, requestUrl)) return;

    const errorEvent = createErrorEvent(
      'BrowserErrorListener',
      'network',
      `Request failed: ${requestUrl}${reason ? ` - ${reason}` : ''}`,
      {
        severity: 'warning',
        context: {
          sessionId,
          tabId,
          operation,
          url: currentPageUrl,
          requestUrl,
          errorType: 'request_failure',
        },
        recoverable: true,
        suggestedRecovery: 'Wait for network recovery and retry',
      }
    );

    this.errorMonitor.reportError(errorEvent, 'BrowserErrorListener');
  }

  /**
   * Report a navigation error (page load/navigation failed)
   */
  public reportNavigationError(sessionId: string, url: string, error: Error, tabId?: string, operation = 'navigate'): void {
    if (!this.enableNavigationFailures || this.shouldSuppress('navigate', sessionId, tabId, url)) return;

    const errorEvent = createErrorEvent(
      'BrowserErrorListener',
      'browser',
      `Navigation to ${url} failed: ${error.message}`,
      {
        severity: 'error',
        technicalMessage: error.stack,
        context: {
          sessionId,
          tabId,
          operation,
          url,
          errorType: 'navigation_error',
        },
        recoverable: true,
        suggestedRecovery: 'Refresh the page',
      }
    );

    this.errorMonitor.reportError(errorEvent, 'BrowserErrorListener');
  }

  /**
   * Report a page close/crash event
   */
  public reportPageClosed(sessionId: string, url: string, tabId?: string, operation = 'pageclosed'): void {
    if (this.shouldSuppress('pageclosed', sessionId, tabId, url)) return;

    const errorEvent = createErrorEvent(
      'BrowserErrorListener',
      'browser',
      'Page closed unexpectedly',
      {
        severity: 'warning',
        context: {
          sessionId,
          tabId,
          operation,
          url,
          errorType: 'page_closed',
        },
        recoverable: true,
        suggestedRecovery: 'Reopen the page and verify state',
      }
    );

    this.errorMonitor.reportError(errorEvent, 'BrowserErrorListener');
  }

  public reportPageCrash(sessionId: string, url: string, tabId?: string, operation = 'pagecrash'): void {
    if (this.shouldSuppress('pagecrash', sessionId, tabId, url)) return;

    const errorEvent = createErrorEvent(
      'BrowserErrorListener',
      'browser',
      'Page crashed or became unavailable',
      {
        severity: 'error',
        context: {
          sessionId,
          tabId,
          operation,
          url,
          errorType: 'page_crash',
        },
        recoverable: true,
        suggestedRecovery: 'Recreate the page and retry',
      }
    );

    this.errorMonitor.reportError(errorEvent, 'BrowserErrorListener');
  }

  /**
   * Report that an element was not found
   */
  public reportElementNotFound(sessionId: string, selector: string, url: string): void {
    const errorEvent = createErrorEvent(
      'BrowserErrorListener',
      'browser',
      `Element not found: "${selector}"`,
      {
        severity: 'warning',
        context: {
          sessionId,
          errorType: 'element_not_found',
          url,
          selector,
        },
        recoverable: false, // Element not found is not recoverable via retry
      }
    );

    this.errorMonitor.reportError(errorEvent, 'BrowserErrorListener');
  }

  /**
   * Report media operation not supported
   */
  public reportMediaNotSupported(sessionId: string, operation: string, url: string): void {
    const errorEvent = createErrorEvent(
      'BrowserErrorListener',
      'browser',
      `Media operation not supported: ${operation}`,
      {
        severity: 'warning',
        context: {
          sessionId,
          errorType: 'media_not_supported',
          url,
          operation,
        },
        recoverable: false,
      }
    );

    this.errorMonitor.reportError(errorEvent, 'BrowserErrorListener');
  }
}
