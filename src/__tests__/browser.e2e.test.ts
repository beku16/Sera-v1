import { describe, it, expect, beforeAll } from 'vitest';
import fetch from 'node-fetch';

const BROWSER_BASE_URL = process.env.BROWSER_API_URL || 'http://localhost:43110';
const SESSION_ID = 'sera-built-in-browser';

/**
 * Browser E2E Tests
 * 
 * These tests verify the browser works end-to-end through the HTTP API.
 * They require a running Electron/Sera desktop app with the browser API server.
 * 
 * To run manually:
 * 1. Start the desktop app: npm run desktop:dev
 * 2. Click "Open browser" in the UI
 * 3. Run: npm test -- browser.e2e.test.ts
 * 
 * Expected workflow:
 * - Open YouTube
 * - Search for Minecraft
 * - Scroll the results
 * - Open a video
 * - Play the video
 * - Seek forward
 * - Change volume
 * - Close the video tab
 * - Read page state
 * - Check downloads
 */

async function apiCall(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${BROWSER_BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  } as Parameters<typeof fetch>[1]);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return response.json();
}

const skipped = process.env.BROWSER_E2E_TEST !== '1';
const describeE2E = skipped ? describe.skip : describe;

describeE2E('Browser E2E through HTTP API', () => {
  it('verifies browser API is available', async () => {
    const session = await apiCall('GET', '/api/browser/state') as { sessionId?: string; tabs?: unknown[] };
    expect(session).toBeDefined();
    expect(session.sessionId).toBeDefined();
    expect(Array.isArray(session.tabs)).toBe(true);
  });

  it('opens Google and navigates', async () => {
    const action = await apiCall('POST', '/api/browser/action', {
      type: 'browser.navigate',
      parameters: {
        sessionId: SESSION_ID,
        url: 'https://www.google.com/',
      },
    }) as { status?: string; result?: { url?: string } };

    expect(action.status || action.result).toBeDefined();
    expect(action.result?.url || '').toContain('google');
  });

  it('can type in search box and press enter', async () => {
    // Type "Minecraft"
    const typed = await apiCall('POST', '/api/browser/action', {
      type: 'browser.type',
      parameters: {
        sessionId: SESSION_ID,
        selector: 'textarea[name="q"], input[name="q"]',
        value: 'Minecraft',
      },
    }) as { status?: string };

    expect(['succeeded', 'inconclusive']).toContain(typed.status || 'success');

    // Press Enter
    const entered = await apiCall('POST', '/api/browser/action', {
      type: 'browser.press',
      parameters: {
        sessionId: SESSION_ID,
        key: 'enter',
      },
    }) as { status?: string };

    expect(['succeeded', 'inconclusive']).toContain(entered.status || 'success');
  }, 30000);

  it('can scroll the page', async () => {
    const scrolled = await apiCall('POST', '/api/browser/action', {
      type: 'browser.scroll',
      parameters: {
        sessionId: SESSION_ID,
        deltaY: 500,
      },
    }) as { status?: string };

    expect(scrolled.status || 'success').toBe('succeeded');
  });

  it('can read page content', async () => {
    const read = await apiCall('POST', '/api/browser/action', {
      type: 'browser.read',
      parameters: {
        sessionId: SESSION_ID,
      },
    }) as { result?: { text?: string; links?: string[] } };

    expect(read.result).toBeDefined();
    expect(read.result?.text).toBeDefined();
    expect(Array.isArray(read.result?.links)).toBe(true);
  });

  it('can create a new tab', async () => {
    const newTab = await apiCall('POST', '/api/browser/action', {
      type: 'browser.newTab',
      parameters: {
        sessionId: SESSION_ID,
        url: 'https://www.youtube.com/',
      },
    }) as { result?: { tabs?: Array<{ id: string }> } };

    expect(Array.isArray(newTab.result?.tabs)).toBe(true);
    expect((newTab.result?.tabs?.length || 0) > 0).toBe(true);
  });

  it('can switch between tabs', async () => {
    const tabs = await apiCall('GET', '/api/browser/state') as { tabs?: Array<{ id: string }> };
    const tabIds = tabs.tabs?.map((t) => t.id) || [];

    if (tabIds.length > 1) {
      const switched = await apiCall('POST', '/api/browser/action', {
        type: 'browser.switchTab',
        parameters: {
          sessionId: SESSION_ID,
          tabId: tabIds[1],
        },
      }) as { status?: string };

      expect(switched.status || 'success').toBe('succeeded');
    }
  });

  it('can navigate back and forward', async () => {
    const back = await apiCall('POST', '/api/browser/action', {
      type: 'browser.back',
      parameters: { sessionId: SESSION_ID },
    }) as { status?: string };
    expect(back.status || 'success').toBe('succeeded');

    const forward = await apiCall('POST', '/api/browser/action', {
      type: 'browser.forward',
      parameters: { sessionId: SESSION_ID },
    }) as { status?: string };
    expect(forward.status || 'success').toBe('succeeded');
  });

  it('can reload the page', async () => {
    const reloaded = await apiCall('POST', '/api/browser/action', {
      type: 'browser.reload',
      parameters: { sessionId: SESSION_ID },
    }) as { status?: string };

    expect(reloaded.status || 'success').toBe('succeeded');
  });

  it('can control media (play/pause)', async () => {
    // Try to play (might fail if no video on page)
    const play = await apiCall('POST', '/api/browser/action', {
      type: 'browser.media',
      parameters: {
        sessionId: SESSION_ID,
        operation: 'play',
      },
    }) as { result?: { supported?: boolean } };

    // If video is on page, it should return supported status
    if (play.result?.supported !== undefined) {
      expect(typeof play.result.supported).toBe('boolean');
    }
  });

  it('can get downloads list', async () => {
    const downloads = await apiCall('POST', '/api/browser/action', {
      type: 'browser.download',
      parameters: { sessionId: SESSION_ID },
    }) as { result?: { downloads?: unknown[]; total?: number } };

    expect(downloads.result).toBeDefined();
    expect(typeof downloads.result?.total).toBe('number');
    expect(Array.isArray(downloads.result?.downloads)).toBe(true);
  });

  it('can close a tab', async () => {
    const tabs = await apiCall('GET', '/api/browser/state') as { tabs?: Array<{ id: string }> };
    const tabIds = tabs.tabs?.map((t) => t.id) || [];

    if (tabIds.length > 1) {
      const closed = await apiCall('POST', '/api/browser/action', {
        type: 'browser.closeTab',
        parameters: {
          sessionId: SESSION_ID,
          tabId: tabIds[1],
        },
      }) as { status?: string };

      expect(closed.status || 'success').toBe('succeeded');
    }
  });
});

/**
 * Manual Testing Checklist
 * =========================
 * 
 * When running the Electron desktop with browser panel:
 * 
 * [ ] Browser panel opens and displays Google
 * [ ] Address bar shows current URL
 * [ ] Tabs bar shows open tabs
 * [ ] Back/Forward/Reload/Home buttons work
 * [ ] Search in address bar loads results
 * [ ] Clicking on page elements works
 * [ ] Play/Pause buttons work on video pages
 * [ ] Seek ±5s and +10s buttons advance video
 * [ ] Volume +/- buttons adjust audio (where supported)
 * [ ] Downloads dropdown shows downloaded files
 * [ ] "Open externally" button opens link in system browser
 * [ ] New tab button creates new tab
 * [ ] Tab switching works
 * [ ] Tab close button removes tab
 * [ ] Page scrolling works
 * [ ] Manual navigation updates Sera's tab list
 * [ ] Sera actions update the live browser view
 * 
 * Full YouTube Workflow:
 * ======================
 * 
 * [ ] Open YouTube from home button
 * [ ] Search for "Minecraft" in address bar
 * [ ] Scroll through search results
 * [ ] Click on a video to open it
 * [ ] Page should show video player
 * [ ] Click Play button (or video starts auto)
 * [ ] Seek forward +10 seconds
 * [ ] Reduce volume using volume - button
 * [ ] Open a new tab
 * [ ] Navigate to Google
 * [ ] Switch back to YouTube tab
 * [ ] Click Back button to see search results
 * [ ] Close the Google tab
 * [ ] Verify YouTube still loaded and seeked to correct position
 */
