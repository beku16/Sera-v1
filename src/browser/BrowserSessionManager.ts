import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { ErrorMonitor, getErrorMonitor } from '../errors/ErrorMonitor';
import { RecoveryManager } from '../errors/RecoveryManager';
import { BrowserErrorListener } from './BrowserErrorListener';
import { createErrorEvent } from '../errors/types';

export interface BrowserTabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
  loading: boolean;
}

export interface BrowserDownloadInfo {
  name: string;
  suggestedFilename: string;
  url: string;
  timestamp: number;
}

export interface BrowserSessionInfo {
  sessionId: string;
  activeTabId: string;
  tabs: BrowserTabInfo[];
  downloads?: BrowserDownloadInfo[];
}

interface BrowserTabState extends BrowserTabInfo {}

interface BrowserSessionState {
  browser: Browser | null;
  context: BrowserContext | null;
  ownsBrowser: boolean;
  pages: Map<string, Page>;
  tabs: Map<string, BrowserTabState>;
  activeTabId: string;
  downloads: Map<string, BrowserDownloadInfo>;
}

export class BrowserSessionManager {
  private readonly sessions = new Map<string, BrowserSessionState>();
  private readonly launch: boolean;
  private readonly errorMonitor: ErrorMonitor;
  private readonly recoveryManager: RecoveryManager;
  private readonly browserErrorListener: BrowserErrorListener;

  constructor(options: { launch?: boolean; errorMonitor?: ErrorMonitor; recoveryManager?: RecoveryManager } = {}) {
    this.launch = options.launch ?? true;
    this.errorMonitor = options.errorMonitor ?? getErrorMonitor();
    this.recoveryManager = options.recoveryManager ?? new RecoveryManager();
    this.browserErrorListener = new BrowserErrorListener({ errorMonitor: this.errorMonitor });
  }

  public async createSession(sessionId = this.randomId()): Promise<BrowserSessionInfo> {
    if (this.sessions.has(sessionId)) {
      return this.snapshot(sessionId);
    }

    const state = this.launch ? await this.createLiveSession(sessionId) : this.createMockSession(sessionId);
    this.sessions.set(sessionId, state);
    return this.snapshot(sessionId);
  }

  public async getSession(sessionId: string): Promise<BrowserSessionInfo | null> {
    if (!this.sessions.has(sessionId)) return null;
    return this.snapshot(sessionId);
  }

  public async closeSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    if (state.browser && state.ownsBrowser) {
      await state.browser.close();
    }
    this.sessions.delete(sessionId);
  }

  public async open(sessionId: string, url: string): Promise<BrowserSessionInfo> {
    const state = await this.ensureSession(sessionId);
    if (state.browser && state.context && state.pages.size > 0) {
      const active = this.getActivePage(state);
      if (active) {
        await active.goto(this.normalizeUrl(url), { waitUntil: 'domcontentloaded' });
      }
    }
    const tabId = state.activeTabId;
    const tab = state.tabs.get(tabId);
    if (tab) {
      tab.url = this.normalizeUrl(url);
      tab.title = tab.title || 'Browser tab';
      tab.loading = false;
      tab.active = true;
    }
    return this.snapshot(sessionId);
  }

  public async navigate(sessionId: string, tabId: string | undefined, url: string): Promise<BrowserSessionInfo> {
    const state = await this.ensureSession(sessionId);
    const targetId = tabId || state.activeTabId;
    const tab = state.tabs.get(targetId);
    if (!tab) throw new Error(`Tab "${targetId}" was not found in session "${sessionId}".`);

    if (state.browser && state.context) {
      const page = state.pages.get(targetId) || this.getActivePage(state);
      if (page) {
        try {
          await page.goto(this.normalizeUrl(url), { waitUntil: 'domcontentloaded' });
          tab.url = page.url();
          tab.title = await page.title();
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.browserErrorListener.reportNavigationError(sessionId, this.normalizeUrl(url), err, targetId, 'navigate');
          const recoveryError = createErrorEvent(
            'BrowserSessionManager',
            'browser',
            `Navigation failed for ${this.normalizeUrl(url)}`,
            {
              severity: 'error',
              taskId: sessionId,
              context: {
                sessionId,
                tabId: targetId,
                url: this.normalizeUrl(url),
                operation: 'navigate',
              },
              recoverable: true,
              suggestedRecovery: 'Retry page load',
            }
          );
          const recoveryResult = await this.recoveryManager.attemptRecovery(recoveryError, this.errorMonitor, {
            refresh: async () => {
              try {
                await page.reload({ waitUntil: 'domcontentloaded' });
                return true;
              } catch {
                return false;
              }
            },
          });
          if (recoveryResult.success) {
            tab.url = page.url();
            return this.snapshot(sessionId);
          }
          throw err;
        }
      }
    } else {
      tab.url = this.normalizeUrl(url);
      tab.title = 'Loaded page';
    }

    tab.loading = false;
    state.activeTabId = targetId;
    return this.snapshot(sessionId);
  }

  public async back(sessionId: string, tabId?: string): Promise<BrowserSessionInfo> {
    const state = await this.ensureSession(sessionId);
    const targetId = tabId || state.activeTabId;
    const page = state.pages.get(targetId) || this.getActivePage(state);
    if (page) {
      await page.goBack();
    }
    return this.snapshot(sessionId);
  }

  public async forward(sessionId: string, tabId?: string): Promise<BrowserSessionInfo> {
    const state = await this.ensureSession(sessionId);
    const targetId = tabId || state.activeTabId;
    const page = state.pages.get(targetId) || this.getActivePage(state);
    if (page) {
      await page.goForward();
    }
    return this.snapshot(sessionId);
  }

  public async reload(sessionId: string, tabId?: string): Promise<BrowserSessionInfo> {
    const state = await this.ensureSession(sessionId);
    const targetId = tabId || state.activeTabId;
    const page = state.pages.get(targetId) || this.getActivePage(state);
    if (page) {
      await page.reload();
    }
    return this.snapshot(sessionId);
  }

  public async newTab(sessionId: string, url?: string): Promise<BrowserSessionInfo> {
    const state = await this.ensureSession(sessionId);

    if (state.browser && state.context) {
      const page = await state.context.newPage();
      const tabId = this.randomId('tab');
      this.bindPage(state, tabId, page, sessionId);
      if (url) {
        await this.navigate(sessionId, tabId, url);
      }
      state.activeTabId = tabId;
      for (const tab of state.tabs.values()) tab.active = tab.id === tabId;
      return this.snapshot(sessionId);
    }

    const tabId = this.randomId('tab');
    const tab: BrowserTabState = { id: tabId, url: url ? this.normalizeUrl(url) : 'about:blank', title: 'New tab', active: true, loading: false };
    for (const entry of state.tabs.values()) entry.active = false;
    state.tabs.set(tabId, tab);
    state.activeTabId = tabId;
    return this.snapshot(sessionId);
  }

  public async switchTab(sessionId: string, tabId: string): Promise<BrowserSessionInfo> {
    const state = await this.ensureSession(sessionId);
    const tab = state.tabs.get(tabId);
    if (!tab) throw new Error(`Tab "${tabId}" was not found in session "${sessionId}".`);

    state.activeTabId = tabId;
    for (const entry of state.tabs.values()) entry.active = entry.id === tabId;
    return this.snapshot(sessionId);
  }

  public async closeTab(sessionId: string, tabId?: string): Promise<BrowserSessionInfo> {
    const state = await this.ensureSession(sessionId);
    const targetId = tabId || state.activeTabId;
    const target = state.tabs.get(targetId);
    if (!target) return this.snapshot(sessionId);

    if (state.browser && state.context && state.pages.has(targetId)) {
      const page = state.pages.get(targetId);
      if (page) await page.close();
      state.pages.delete(targetId);
    }

    state.tabs.delete(targetId);
    const remaining = Array.from(state.tabs.keys());
    if (remaining.length === 0) {
      state.activeTabId = this.randomId('tab');
      const fallback: BrowserTabState = { id: state.activeTabId, url: 'about:blank', title: 'Blank tab', active: true, loading: false };
      state.tabs.set(state.activeTabId, fallback);
      return this.snapshot(sessionId);
    }

    state.activeTabId = remaining[0];
    for (const entry of state.tabs.values()) entry.active = entry.id === state.activeTabId;
    return this.snapshot(sessionId);
  }

  public async click(sessionId: string, selectorOrText: string, tabId?: string): Promise<BrowserSessionInfo> {
    const state = await this.ensureSession(sessionId);
    const page = this.getPageForTab(state, tabId || state.activeTabId);
    if (page) {
      const selector = this.makeSelector(selectorOrText);
      await page.locator(selector).first().click();
    }
    return this.snapshot(sessionId);
  }

  public async type(sessionId: string, selectorOrText: string, value: string, tabId?: string): Promise<BrowserSessionInfo> {
    const state = await this.ensureSession(sessionId);
    const page = this.getPageForTab(state, tabId || state.activeTabId);
    if (page) {
      const selector = this.makeSelector(selectorOrText); 
      const locator = page.locator(selector).first();
      await locator.fill(value);
    }
    return this.snapshot(sessionId);
  }

  public async verifyTypedValue(sessionId: string, selectorOrText: string, expected: string, tabId?: string): Promise<boolean> {
    const state = await this.ensureSession(sessionId);
    const page = this.getPageForTab(state, tabId || state.activeTabId);
    if (!page) return false;
    const locator = page.locator(this.makeSelector(selectorOrText)).first();
    if (await locator.count() === 0) return false;
    const actual = await locator.evaluate((element) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.textContent || '');
    return actual === expected;
  }

  public async press(sessionId: string, key: string, tabId?: string, selectorOrText?: string): Promise<BrowserSessionInfo> {
    const state = await this.ensureSession(sessionId);
    const page = this.getPageForTab(state, tabId || state.activeTabId);
    if (page) {
      if (selectorOrText) {
        const locator = page.locator(this.makeSelector(selectorOrText)).first();
        if (await locator.count() === 0) throw new Error('Target selector was not found: ' + selectorOrText);
        await locator.press(key);
      } else if (key.toLowerCase() === 'enter') {
        // CRITICAL FIX: The previous implementation hard-coded a
        // `page.waitForURL(/\/results(?:\?|$)/i)` call after every Enter
        // press — a YouTube-specific URL pattern. On non-YouTube pages
        // (WhatsApp Web, search inputs, chat composers, form submits),
        // this regex never matched, so the .catch swallowed a 15-second
        // timeout. Every WhatsApp Enter took 15+ seconds. Every chat
        // message took 15+ seconds. The user perceived this as "browser
        // is frozen."
        //
        // Now we do an adaptive wait: if we're already on YouTube (where
        // Enter in the search box triggers a navigation to /results), we
        // wait for the URL change + video links with the original 15s
        // budget — this is the right behaviour for YouTube specifically.
        // For ALL OTHER sites, we wait at most 1.5s for
        // `domcontentloaded` (sufficient for SPA navigations and form
        // submits without punishing single-page apps that don't change
        // URL on Enter).
        const currentUrl = page.url();
        const isYouTube = /youtube\.com/i.test(currentUrl);
        if (isYouTube) {
          await Promise.all([
            page.keyboard.press(key),
            page.waitForURL((url) => /\/results(?:\?|$)/i.test(url.toString()), { timeout: 15000 }).catch(() => undefined),
          ]);
          await page.waitForLoadState('domcontentloaded').catch(() => undefined);
          await page.locator('a[href*="/watch"]').first().waitFor({ state: 'attached', timeout: 15000 }).catch(() => undefined);
        } else {
          await Promise.all([
            page.keyboard.press(key),
            page.waitForLoadState('domcontentloaded', { timeout: 1500 }).catch(() => undefined),
          ]);
        }
      } else {
        await page.keyboard.press(key);
      }
    }
    return this.snapshot(sessionId);
  }

  public async scroll(sessionId: string, deltaY: number, tabId?: string): Promise<BrowserSessionInfo> {
    const state = await this.ensureSession(sessionId);
    const page = this.getPageForTab(state, tabId || state.activeTabId);
    if (page) {
      await page.mouse.wheel(0, deltaY);
    }
    return this.snapshot(sessionId);
  }

  public async find(sessionId: string, text: string, tabId?: string): Promise<{ matches: number; text: string; tabId?: string; url?: string }> {
    const state = await this.ensureSession(sessionId);
    const page = this.getPageForTab(state, tabId || state.activeTabId);
    if (!page) {
      return { matches: 0, text, tabId: tabId || state.activeTabId, url: state.tabs.get(tabId || state.activeTabId)?.url };
    }
    const matches = await page.locator(`text=${this.escapeSelector(text)}`).count();
    return { matches, text, tabId: tabId || state.activeTabId, url: page.url() };
  }

  public async tabs(sessionId: string): Promise<BrowserSessionInfo> {
    await this.ensureSession(sessionId);
    return this.snapshot(sessionId);
  }

  public async screenshot(sessionId: string, tabId?: string): Promise<Buffer | null> {
    const state = await this.ensureSession(sessionId);
    const page = this.getPageForTab(state, tabId || state.activeTabId);
    if (!page) return null;
    return page.screenshot({ type: 'png' });
  }

  public async media(sessionId: string, operation: 'play' | 'pause' | 'seek' | 'volume', value?: number, tabId?: string): Promise<{ supported: boolean; paused?: boolean; currentTime?: number; duration?: number; volume?: number }> {
    const state = await this.ensureSession(sessionId);
    const page = this.getPageForTab(state, tabId || state.activeTabId);
    if (!page) return { supported: false };

    const video = page.locator('video').first();
    if (await video.count() === 0) return { supported: false };
    const readiness = await video.evaluate((element) => {
      const media = element as HTMLVideoElement;
      return { readyState: media.readyState, duration: media.duration };
    });
    if (readiness.readyState < 2 || !Number.isFinite(readiness.duration) || readiness.duration <= 0) return { supported: false };
    if (operation === 'play') await video.evaluate((element) => (element as HTMLVideoElement).play());
    if (operation === 'pause') await video.evaluate((element) => (element as HTMLVideoElement).pause());
    if (operation === 'seek') await video.evaluate((element, seconds) => { (element as HTMLVideoElement).currentTime += seconds as number; }, value || 0);
    if (operation === 'volume') await video.evaluate((element, level) => { (element as HTMLVideoElement).volume = Math.max(0, Math.min(1, level as number)); }, value || 0);
    return video.evaluate((element) => {
      const media = element as HTMLVideoElement;
      return { supported: true, paused: media.paused, currentTime: media.currentTime, duration: media.duration, volume: media.volume };
    });
  }

  public async read(sessionId: string, tabId?: string): Promise<{ title: string; url: string; text: string; links: string[]; videoLinks: string[]; buttons: string[]; headings: string[]; inputs: Array<{ name: string; value: string; placeholder: string }>; scrollY: number; scrollHeight: number }> {
    const state = await this.ensureSession(sessionId);
    const page = this.getPageForTab(state, tabId || state.activeTabId);
    const url = page ? page.url() : state.tabs.get(tabId || state.activeTabId)?.url || 'about:blank';
    const title = page ? await page.title() : state.tabs.get(tabId || state.activeTabId)?.title || 'Untitled page';

    if (!page) {
      return { title, url, text: '', links: [], videoLinks: [], buttons: [], headings: [], inputs: [], scrollY: 0, scrollHeight: 0 };
    }

    const pageText = (await page.locator('body').innerText()).trim();
    const links = await page.locator('a').evaluateAll((elements) => elements.map((el) => (el.textContent || '').trim()).filter(Boolean));
    const videoLinks = await page.locator('a[href*="/watch"]').evaluateAll((elements) => elements.map((el) => (el.getAttribute('href') || '').trim()).filter(Boolean));
    const buttons = await page.locator('button, [role="button"]').evaluateAll((elements) => elements.map((el) => (el.textContent || '').trim()).filter(Boolean));
    const headings = await page.locator('h1, h2, h3, h4, h5, h6').evaluateAll((elements) => elements.map((el) => (el.textContent || '').trim()).filter(Boolean));
    const inputs = await page.locator('input, textarea').evaluateAll((elements) => elements.map((element) => ({
      name: element.getAttribute('name') || element.id || '',
      value: (element as HTMLInputElement).value || '',
      placeholder: element.getAttribute('placeholder') || '',
    })));
    const scrollY = await page.evaluate(() => window.scrollY);
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);

    return { title, url, text: pageText, links, videoLinks, buttons, headings, inputs, scrollY, scrollHeight };
  }

  public async downloads(sessionId: string): Promise<{ downloads: BrowserDownloadInfo[]; total: number }> {
    const state = await this.ensureSession(sessionId);
    return {
      downloads: Array.from(state.downloads.values()),
      total: state.downloads.size,
    };
  }

  private async ensureSession(sessionId: string): Promise<BrowserSessionState> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created = this.launch ? await this.createLiveSession(sessionId) : this.createMockSession(sessionId);
    this.sessions.set(sessionId, created);
    return created;
  }

  private createMockSession(sessionId: string): BrowserSessionState {
    const tabId = this.randomId('tab');
    const tab: BrowserTabState = { id: tabId, url: 'about:blank', title: 'Managed Browser', active: true, loading: false };
    return { browser: null, context: null, ownsBrowser: false, pages: new Map(), tabs: new Map([[tabId, tab]]), activeTabId: tabId, downloads: new Map() };
  }

  private async createLiveSession(sessionId: string): Promise<BrowserSessionState> {
    const cdpUrl = process.env.BROWSER_CDP_URL;
    if (cdpUrl) {
      try {
        const browser = await chromium.connectOverCDP(cdpUrl);
        const context = browser.contexts()[0] || await browser.newContext({ acceptDownloads: true });
        const pages = context.pages().filter((candidate) => !this.isSeraPage(candidate));
        const page = pages[0] || await context.newPage();
        const state = this.createStateFromPage(browser, context, page, false, sessionId);
        for (const candidate of pages) {
          if (candidate !== page) {
            const id = this.randomId('tab');
            this.bindPage(state, id, candidate, sessionId);
          }
        }
        context.on('page', (newPage) => {
          if (!this.isSeraPage(newPage)) {
            const id = this.randomId('tab');
            this.bindPage(state, id, newPage, sessionId);
          }
        });
        context.on('download', (download) => {
          const filename = download.suggestedFilename();
          const url = download.url();
          state.downloads.set(filename, {
            name: filename,
            suggestedFilename: filename,
            url,
            timestamp: Date.now(),
          });
        });
        browser.on('disconnected', () => {
          this.browserErrorListener.reportPageCrash(sessionId, 'browser-disconnected', state.activeTabId, 'browser_disconnected');
        });
        return state;
      } catch (err) {
        // CDP connection failed — likely the embedded browser isn't running
        // or the dev port isn't reachable. Fall through to a headless
        // launch instead of failing hard, but log the CDP failure so the
        // SystemDiagnosticService's playwright_browser_install check can
        // surface it. (Previously this swallowed the CDP failure silently,
        // then the chromium.launch below would either succeed in headless
        // mode (working but not what the user wanted) or fail with a
        // confusing "browser not installed" error that looked unrelated
        // to the real CDP problem.)
        const message = err instanceof Error ? err.message : String(err);
        this.browserErrorListener.reportNavigationError(sessionId, cdpUrl, err instanceof Error ? err : new Error(message), 'cdp', 'connectOverCDP');
        // Continue to headless launch below — that's the best we can do.
      }
    }
    let browser: Browser;
    try {
      browser = await chromium.launch({ headless: true });
    } catch (err) {
      // The most common failure here is "Executable doesn't exist at
      // .../chromium-*/chrome-win/chrome.exe" — i.e. Playwright's bundled
      // Chromium was never installed via `npx playwright install chromium`.
      // This is the root cause of the user-reported "managed browser isn't
      // working" complaint. We re-throw with a much more actionable error
      // message so the AI can surface it to the user instead of getting a
      // cryptic ENOENT-style failure.
      const message = err instanceof Error ? err.message : String(err);
      const looksLikeMissingBrowser = /Executable doesn't exist|browser was not found|chromium.*not.*installed/i.test(message);
      const enhanced = looksLikeMissingBrowser
        ? `Playwright's bundled Chromium is not installed. Run "npx playwright install chromium" in the project root, then retry. Underlying error: ${message}`
        : `Playwright Chromium launch failed: ${message}`;
      const enhancedError = new Error(enhanced);
      this.browserErrorListener.reportNavigationError(sessionId, 'about:blank', enhancedError, 'launch', 'chromium.launch');
      throw enhancedError;
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true, acceptDownloads: true });
    const page = await context.newPage();
    const tabId = this.randomId('tab');
    const tab: BrowserTabState = {
      id: tabId,
      url: page.url() || 'about:blank',
      title: await page.title() || 'New tab',
      active: true,
      loading: false,
    };
    const state: BrowserSessionState = { browser, context, ownsBrowser: true, pages: new Map([[tabId, page]]), tabs: new Map([[tabId, tab]]), activeTabId: tabId, downloads: new Map() };
    context.on('download', (download) => {
      const filename = download.suggestedFilename();
      const url = download.url();
      state.downloads.set(filename, {
        name: filename,
        suggestedFilename: filename,
        url,
        timestamp: Date.now(),
      });
    });
    browser.on('disconnected', () => {
      this.browserErrorListener.reportPageCrash(sessionId, 'browser-disconnected', state.activeTabId, 'browser_disconnected');
    });
    this.sessions.set(sessionId, state);
    return state;
  }

  private createStateFromPage(browser: Browser, context: BrowserContext, page: Page, ownsBrowser: boolean, sessionId = 'browser-session'): BrowserSessionState {
    const tabId = this.randomId('tab');
    const state: BrowserSessionState = { browser, context, ownsBrowser, pages: new Map(), tabs: new Map(), activeTabId: tabId, downloads: new Map() };
    this.bindPage(state, tabId, page, sessionId);
    return state;
  }

  private bindPage(state: BrowserSessionState, tabId: string, page: Page, sessionId: string): void {
    state.pages.set(tabId, page);
    state.tabs.set(tabId, { id: tabId, url: page.url() || 'about:blank', title: 'New tab', active: tabId === state.activeTabId, loading: false });
    const update = async () => {
      const tab = state.tabs.get(tabId);
      if (!tab) return;
      tab.url = page.url();
      tab.title = await page.title().catch(() => tab.title);
      tab.loading = false;
    };
    page.on('framenavigated', () => void update());
    page.on('domcontentloaded', () => void update());
    page.on('load', () => void update());
    page.on('pageerror', (error: Error) => this.browserErrorListener.reportPageError(sessionId, error, page.url(), tabId, 'pageerror'));
    page.on('requestfailed', (request) => this.browserErrorListener.reportRequestFailure(sessionId, request.url(), page.url(), request.failure()?.errorText, tabId, 'requestfailed'));
    page.on('close', () => this.browserErrorListener.reportPageClosed(sessionId, page.url(), tabId, 'pageclosed'));
    page.on('crash', () => this.browserErrorListener.reportPageCrash(sessionId, page.url(), tabId, 'pagecrash'));
  }

  private isSeraPage(page: Page): boolean {
    const url = page.url();
    return url.startsWith('file://') || url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:') || url.startsWith('devtools:');
  }

  private snapshot(sessionId: string): BrowserSessionInfo {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`No browser session found for "${sessionId}".`);

    const tabs = Array.from(state.tabs.values()).map((tab) => ({ ...tab, active: tab.id === state.activeTabId }));
    return {
      sessionId,
      activeTabId: state.activeTabId,
      tabs,
      downloads: Array.from(state.downloads.values()),
    };
  }

  private getActivePage(state: BrowserSessionState): Page | null {
    return state.pages.get(state.activeTabId) || null;
  }

  private getPageForTab(state: BrowserSessionState, tabId: string): Page | null {
    return state.pages.get(tabId) || null;
  }

  private normalizeUrl(url: string): string {
    if (!url || typeof url !== 'string') return 'about:blank';
    const trimmed = url.trim();
    if (!trimmed) return 'about:blank';
    if (/^https?:\/\//i.test(trimmed) || /^about:/i.test(trimmed)) return trimmed;
    if (/^\//.test(trimmed)) return `https://example.com${trimmed}`;
    if (trimmed.includes('.')) return `https://${trimmed}`;
    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  }

  private makeSelector(selectorOrText: string): string {
    const trimmed = selectorOrText.trim();
    if (!trimmed) return 'body';
    if (trimmed.includes(',') || trimmed.startsWith('#') || trimmed.startsWith('.') || trimmed.startsWith('[') || trimmed.startsWith('button') || trimmed.startsWith('input') || trimmed.startsWith('textarea') || trimmed.startsWith('a') || trimmed.startsWith('text=')) {
      return trimmed;
    }
    return `text=${this.escapeSelector(trimmed)}`;
  }

  private escapeSelector(value: string): string {
    return value.replace(/"/g, '\\"');
  }

  private randomId(prefix = 'id'): string {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
  }
}


