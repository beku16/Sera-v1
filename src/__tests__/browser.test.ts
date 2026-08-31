import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { BrowserSessionManager } from '../browser/BrowserSessionManager';
import { BrowserExecutor } from '../actions/BrowserExecutor';
import { ActionManager } from '../actions/ActionManager';
import { BrowserErrorListener } from '../browser/BrowserErrorListener';
import { ErrorMonitor } from '../errors/ErrorMonitor';
import { RecoveryManager } from '../errors/RecoveryManager';
import { createErrorEvent } from '../errors/types';

/**
 * The three tests marked with `itBrowser` below launch REAL Playwright Chromium
 * (`launch: true`). Playwright only downloads its browsers through the
 * postinstall hook, which CI deliberately skips (`npm ci --ignore-scripts` is
 * required because robotjs's native build is Windows-only). Probing with an
 * actual headless launch checks exactly what those tests need — note that
 * `chromium.executablePath()` alone is NOT enough, because `launch({ headless:
 * true })` uses the separate "chromium headless shell" build, which some
 * environments (e.g. GitHub-hosted runners with a pre-installed full Chromium)
 * don't provide. Tests skip themselves in browserless environments instead of
 * failing, and still run on any machine that ran a plain `npm install`.
 */
const chromiumAvailable = await (async () => {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false; /* headless launch failed — treat the browser as unavailable */
  }
})();
const itBrowser = chromiumAvailable ? it : it.skip;

describe('browser session manager', () => {
  it('creates a managed browser session and tracks tabs by id', async () => {
    const manager = new BrowserSessionManager({ launch: false });
    const session = await manager.createSession();

    expect(session.sessionId).toBeTruthy();
    expect(session.tabs.length).toBeGreaterThanOrEqual(1);
    expect(session.activeTabId).toBeTruthy();

    const tab = session.tabs[0];
    expect(tab.id).toBeTruthy();
    expect(tab.url).toBeTruthy();
    expect(tab.title).toBeTruthy();

    const session2 = await manager.getSession(session.sessionId);
    expect(session2?.sessionId).toBe(session.sessionId);

    await manager.closeSession(session.sessionId);
  });

  it('normalizes tab navigation and tracks current url', async () => {
    const manager = new BrowserSessionManager({ launch: false });
    const session = await manager.createSession();

    const tab = session.tabs[0];
    const nextUrl = 'https://example.com';
    await manager.navigate(session.sessionId, tab.id, nextUrl);

    const updated = await manager.getSession(session.sessionId);
    expect(updated?.tabs.find((entry) => entry.id === tab.id)?.url).toBe(nextUrl);

    await manager.closeSession(session.sessionId);
  }, 15000);
});

describe('browser error handling', () => {
  itBrowser('reports real page errors and suppresses duplicate events', async () => {
    const monitor = new ErrorMonitor();
    const listener = new BrowserErrorListener({ errorMonitor: monitor });
    const manager = new BrowserSessionManager({ launch: true, errorMonitor: monitor });
    const session = await manager.createSession('browser-error-test');
    listener.reportPageError('browser-error-test', new Error('synthetic page error'), 'https://example.com', session.activeTabId, 'pageerror');

    const pageErrors = monitor.query({ category: 'browser', resolved: false });
    expect(pageErrors.some((error) => error.message.includes('Page error'))).toBe(true);

    const beforeDupes = pageErrors.filter((error) => error.message.includes('Page error')).length;
    listener.reportPageError('browser-error-test', new Error('synthetic page error'), 'https://example.com', session.activeTabId, 'pageerror');
    const dupeCount = monitor.query({ category: 'browser', resolved: false }).filter((error) => error.message.includes('Page error')).length;
    expect(dupeCount).toBe(beforeDupes);

    await manager.closeSession('browser-error-test');
  }, 30000);

  itBrowser('records navigation failures and automatic recovery', async () => {
    const monitor = new ErrorMonitor();
    const recoveryManager = new RecoveryManager();
    const manager = new BrowserSessionManager({ launch: true, errorMonitor: monitor, recoveryManager });
    const session = await manager.createSession('browser-recovery-test');
    const state = (manager as any).sessions.get('browser-recovery-test');
    const page = state.pages.get(session.activeTabId);

    const error = createErrorEvent('BrowserSessionManager', 'browser', 'Navigation failed', {
      recoverable: true,
      context: { sessionId: session.sessionId, tabId: session.activeTabId, url: 'https://example.invalid' },
    });

    monitor.reportError(error, 'BrowserSessionManager');

    const recoveryResult = await recoveryManager.attemptRecovery(error, monitor, {
      refresh: async () => {
        if (!page) return false;
        await page.goto('https://example.com', { waitUntil: 'domcontentloaded' }).catch(() => undefined);
        return true;
      },
    });

    expect(recoveryResult.success).toBe(true);
    expect(monitor.getRecent(10).length).toBeGreaterThan(0);

    await manager.closeSession('browser-recovery-test');
  }, 30000);
});

describe('browser executor', () => {
  it('routes navigation and tab actions through ActionManager', async () => {
    const sessionManager = new BrowserSessionManager({ launch: false });
    const executor = new BrowserExecutor(sessionManager);
    const manager = new ActionManager();
    manager.registerExecutor(executor);

    const session = await sessionManager.createSession();
    const action = manager.createAction({
      taskId: 'browser-actions',
      actionId: 'browser-1',
      type: 'browser.navigate',
      parameters: { url: 'https://example.com' },
    });

    const result = await manager.execute(action);
    expect(result.status).toBe('succeeded');
    expect(result.result).toMatchObject({ url: 'https://example.com' });

    await sessionManager.closeSession(session.sessionId);
  });

  itBrowser('drives a real YouTube session through ActionManager', async () => {
    const sessionManager = new BrowserSessionManager({ launch: true });
    const executor = new BrowserExecutor(sessionManager);
    const actionManager = new ActionManager();
    actionManager.registerExecutor(executor);
    const sessionId = 'live-youtube-e2e';
    let actionNumber = 0;

    const execute = async (type: string, parameters: Record<string, unknown>) => {
      const action = actionManager.createAction({
        taskId: sessionId,
        actionId: `${sessionId}-${++actionNumber}`,
        type,
        parameters: { ...parameters, sessionId },
      });
      const result = await actionManager.execute(action);
      expect(['succeeded', 'inconclusive'], `${type} should execute`).toContain(result.status);
      return result.result as Record<string, unknown>;
    };

    try {
      const firstSession = await sessionManager.createSession(sessionId);
      const reusedSession = await sessionManager.createSession(sessionId);
      expect(reusedSession.sessionId).toBe(firstSession.sessionId);
      expect(reusedSession.tabs).toHaveLength(1);

      const opened = await execute('browser.open', { url: 'https://www.youtube.com/' });
      expect(opened.url).toContain('youtube.com');

      const initial = await execute('browser.read', {});
      expect(String(initial.url)).toContain('youtube.com');
      expect(String(initial.title).length).toBeGreaterThan(0);
      expect(String(initial.text).toLowerCase()).not.toContain('sign in to confirm you are not a bot');

      await execute('browser.type', { selector: 'input#search, input[name="search_query"]', value: 'Minecraft' });
      const searchField = await execute('browser.read', {});
      expect(JSON.stringify(searchField.inputs)).toContain('Minecraft');

      await execute('browser.press', { key: 'Enter' });
      const results = await execute('browser.read', {});
      expect(String(results.url)).toMatch(/youtube\.com\/results|search_query/i);
      expect(String(results.url)).toMatch(/minecraft/i);
      expect((results.videoLinks as string[]).length).toBeGreaterThan(0);

      const beforeScroll = await execute('browser.read', {});
      await execute('browser.scroll', { deltaY: 900 });
      const afterScroll = await execute('browser.read', {});
      expect(Number(afterScroll.scrollHeight)).toBeGreaterThan(900);
      expect(Number(afterScroll.scrollY)).toBeGreaterThan(Number(beforeScroll.scrollY));

      const video = await execute('browser.find', { text: 'Minecraft' });
      expect(Number(video.matches)).toBeGreaterThan(0);
      await execute('browser.click', { selector: 'a#video-title' });
      const videoPage = await execute('browser.read', {});
      expect(String(videoPage.url)).toMatch(/youtube\.com\/watch/);

      const mediaState = await execute('browser.media', { operation: 'pause' });
      if (mediaState.supported) {
        expect(typeof mediaState.paused).toBe('boolean');
        const played = await execute('browser.media', { operation: 'play' });
        expect(played.supported).toBe(true);
        const sought = await execute('browser.media', { operation: 'seek', value: 10 });
        expect(Number(sought.currentTime)).toBeGreaterThanOrEqual(Number(mediaState.currentTime));
        const volume = await execute('browser.media', { operation: 'volume', value: 0.5 });
        expect(Number(volume.volume)).toBeCloseTo(0.5, 1);
      }

      await execute('browser.back', {});
      const restored = await execute('browser.read', {});
      expect(String(restored.url)).toMatch(/youtube\.com\/results|search_query/i);
      const finalSession = await execute('browser.tabs', {});
      expect(finalSession.tabs).toHaveLength(1);
      expect(finalSession.sessionId).toBe(sessionId);
    } finally {
      await sessionManager.closeSession(sessionId);
    }
  }, 120000);
});
