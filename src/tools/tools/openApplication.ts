import { ACTION_ERROR_CODES } from '../../actions/errors';
import { ActionManager } from '../../actions/ActionManager';
import { ToolDefinition, ToolPermissionLevel } from '../types';
import { validateUrl } from './openWebsite';

interface OpenApplicationArgs {
  application: string;
  /** Optional hint. 'desktop' = always try desktop app first; 'web' = always
   * open in the managed browser; 'auto' (default) = try desktop first for
   * DESKTOP_FIRST_BRANDS, otherwise route to the browser if it's a known
   * website name. */
  intent?: 'desktop' | 'web' | 'auto';
}

export interface OpenApplicationResult {
  application?: string;
  displayName?: string;
  target?: string;
  url?: string;
  pid?: number;
  actionId?: string;
  taskId?: string;
  verification: 'success' | 'window_detected' | 'fallback_to_web';
}

/**
 * Brand names where a desktop client is commonly installed and the user
 * almost always means "open the desktop app" when they say the brand name
 * (Discord, Spotify, Slack, Telegram, etc.). For these brands we attempt
 * `application.launch` FIRST. Only if the desktop launch genuinely fails
 * (binary not on PATH AND xdg-open / `start` fallback can't resolve it)
 * do we fall back to `browser.navigate`.
 *
 * Previously, "Discord" routed straight to `browser.navigate` because
 * `validateUrl('discord')` matched the KNOWN_SITES_MAP entry. That
 * opened discord.com in the managed headless Chromium — invisible to the
 * user — instead of launching the user's installed Discord desktop app.
 */
const DESKTOP_FIRST_BRANDS = new Set([
  'discord',
  'slack',
  'spotify',
  'telegram',
  'notion',
  'figma',
  'vscode',
  'code',
  'visual studio code',
  'steam',
  'epic games',
  'zoom',
  'teams',
  'skype',
  'outlook',
  'thunderbird',
  'iterm',
  'iterm2',
  'terminal',
  'warp',
]);

function isDesktopFirstBrand(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (DESKTOP_FIRST_BRANDS.has(lower)) return true;
  // Also catch "visual studio code" → "code" canonicalisation, etc.
  for (const brand of DESKTOP_FIRST_BRANDS) {
    if (lower.includes(brand)) return true;
  }
  return false;
}

export const openApplicationTool: ToolDefinition<OpenApplicationArgs, OpenApplicationResult> = {
  name: 'openApplication',
  description: 'Resolves and opens a named application or website. For brands that have a desktop client (Discord, Spotify, Slack, etc.) it launches the desktop app first and only falls back to the managed browser if the desktop app is not installed. For pure website names (YouTube, Wikipedia, etc.) it routes directly to the managed browser.',
  permissionLevel: ToolPermissionLevel.LOW_RISK_ACTION,
  capability: 'APPLICATION_LAUNCH',
  capabilityForArgs: (args) => {
    const application = String((args as { application?: unknown })?.application || '');
    const intent = (args as { intent?: unknown })?.intent;
    // Explicit web intent → browser control.
    if (intent === 'web') return 'BROWSER_CONTROL';
    // Desktop-first brands never require BROWSER_CONTROL — the launch is
    // the primary path; the browser fallback (if needed) is decided by the
    // tool itself, not by the capability gate.
    if (intent === 'desktop') return 'APPLICATION_LAUNCH';
    if (isDesktopFirstBrand(application)) return 'APPLICATION_LAUNCH';
    // For everything else, defer to URL validation: known website names
    // (youtube, gmail, etc.) and explicit URLs require BROWSER_CONTROL;
    // bare application names (Notepad, Calculator) require APPLICATION_LAUNCH.
    return validateUrl(application).valid ? 'BROWSER_CONTROL' : 'APPLICATION_LAUNCH';
  },
  parameters: {
    type: 'OBJECT',
    properties: {
      application: {
        type: 'STRING',
        description: 'Application name (e.g. "Calculator", "Notepad", "Discord", "Spotify") or website name / URL (e.g. "YouTube", "gmail.com", "https://wikipedia.org").',
      },
      intent: {
        type: 'STRING',
        description: 'Optional hint: "desktop" = try the desktop app only; "web" = open in the managed browser; "auto" (default) = pick the best route (desktop app first for Discord/Spotify/Slack/etc., browser for known website names).',
        enum: ['desktop', 'web', 'auto'],
      },
    },
    required: ['application'],
  },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object') return { valid: false, error: 'Application arguments are required.' };
    const application = (args as Record<string, unknown>).application;
    if (typeof application !== 'string' || !application.trim()) return { valid: false, error: 'Application name must be a non-empty string.' };
    const intentRaw = (args as Record<string, unknown>).intent;
    const intent: 'desktop' | 'web' | 'auto' = intentRaw === 'desktop' || intentRaw === 'web' ? intentRaw : 'auto';
    return { valid: true, parsedArgs: { application: application.trim(), intent } };
  },
  async execute(args, context) {
    const actionManager: ActionManager | undefined = context?.actionManager;
    if (!actionManager) {
      return { success: false, error: 'Application control is unavailable.' };
    }

    const intent = args.intent || 'auto';
    const website = validateUrl(args.application);

    // Decide route:
    // - intent='web' → always browser
    // - intent='desktop' → always launch (skip browser entirely)
    // - intent='auto' + desktop-first brand → launch first, browser fallback
    // - intent='auto' + non-brand + valid URL → browser
    // - intent='auto' + non-brand + invalid URL → launch
    const wantDesktop = intent === 'desktop' || (intent === 'auto' && (isDesktopFirstBrand(args.application) || !website.valid));
    const wantBrowser = intent === 'web' || (intent === 'auto' && !isDesktopFirstBrand(args.application) && website.valid);

    // Browser route (explicit web intent, or auto for non-brands that ARE URLs).
    // VISIBLE-OPEN POLICY: route through browser.openDefault so the site
    // opens in the user's REAL browser (on their screen) — the managed
    // Playwright session is headless, and navigating it made "open youtube"
    // look like SERA ignored the user entirely. Managed browser is the
    // fallback, not the default.
    if (wantBrowser && !wantDesktop && website.valid && website.normalizedUrl) {
      const action = actionManager.createAction({
        taskId: context?.sessionId,
        actionId: context?.executionId,
        type: 'browser.openDefault',
        parameters: { url: website.normalizedUrl },
      });
      const opened = await actionManager.execute(action);
      if (opened.status !== 'succeeded') {
        // No usable default browser (headless server, etc.) — managed fallback.
        const managedAction = actionManager.createAction({
          taskId: context?.sessionId,
          actionId: context?.executionId ? `${context.executionId}:managed` : undefined,
          type: 'browser.open',
          parameters: { url: website.normalizedUrl },
        });
        const managed = await actionManager.execute(managedAction);
        if (managed.status !== 'succeeded') {
          return { success: false, error: `${managed.error?.code || ACTION_ERROR_CODES.EXECUTION_FAILED}: ${managed.error?.message || 'Could not open the website in any browser.'}` };
        }
        return { success: true, userMessage: `Opened ${website.siteName || args.application} in SERA's managed browser (your default browser was unavailable).`, data: { target: args.application, url: website.normalizedUrl, verification: 'window_detected' } };
      }
      return { success: true, userMessage: `Opened ${website.siteName || args.application}.`, data: { target: args.application, url: website.normalizedUrl, verification: 'window_detected' } };
    }

    // Desktop launch route
    const action = actionManager.createAction({
      taskId: context?.sessionId,
      actionId: context?.executionId,
      type: 'application.launch',
      parameters: { application: args.application },
    });
    const completed = await actionManager.execute(action);

    if (completed.status === 'succeeded') {
      const result = completed.result as { application: string; displayName: string; pid?: number };
      return {
        success: true,
        userMessage: `Opened ${result.displayName}.`,
        data: {
          ...result,
          actionId: completed.actionId,
          taskId: completed.taskId,
          verification: 'success',
        },
      };
    }

    // Desktop launch failed — try browser fallback for desktop-first brands
    // (Discord, Spotify, etc.) when the user used 'auto' intent and the brand
    // is also in KNOWN_SITES_MAP. This preserves the original behaviour for
    // cases where the desktop app genuinely isn't installed.
    if (intent === 'auto' && isDesktopFirstBrand(args.application) && website.valid && website.normalizedUrl) {
      const browserAction = actionManager.createAction({
        taskId: context?.sessionId,
        actionId: `${context?.executionId || 'app'}-fb`,
        type: 'browser.openDefault',
        parameters: { url: website.normalizedUrl },
      });
      let fallback = await actionManager.execute(browserAction);
      if (fallback.status !== 'succeeded') {
        const managedFallbackAction = actionManager.createAction({
          taskId: context?.sessionId,
          actionId: `${context?.executionId || 'app'}-fb-managed`,
          type: 'browser.open',
          parameters: { url: website.normalizedUrl },
        });
        fallback = await actionManager.execute(managedFallbackAction);
      }
      if (fallback.status === 'succeeded') {
        return {
          success: true,
          userMessage: `The desktop app for ${args.application} could not be launched — opened ${website.siteName || args.application} in your browser instead.`,
          data: {
            target: args.application,
            url: website.normalizedUrl,
            verification: 'fallback_to_web',
            fallbackReason: completed.error?.message || 'Desktop launch failed.',
          },
        };
      }
    }

    const code = completed.error?.code || ACTION_ERROR_CODES.EXECUTION_FAILED;
    return {
      success: false,
      error: `${code}: ${completed.error?.message || 'Application launch failed.'}`,
      userMessage: completed.error?.message || 'I could not verify that application launch.',
    };
  },
};
