import { ToolDefinition, ToolExecutionResult, ToolPermissionLevel } from '../types';

export interface OpenWebsiteArgs {
  url: string;
}

export interface OpenWebsiteResult {
  url: string;
  domain: string;
  siteName: string;
  opened: boolean;
  timestamp: string;
  directBrowserLaunchSupported?: boolean;
  /** Where the site actually opened: the user's default OS browser
   * (visible) or SERA's managed session (fallback). */
  openedVia?: 'default-browser' | 'managed-browser';
  note?: string;
}

const FORBIDDEN_SCHEMES = [
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'blob:',
  'about:',
  'ws:',
  'wss:',
  'shell:',
  'cmd:',
  'powershell:',
];

/**
 * Common website aliases and brand names mapped to canonical HTTPS URLs
 */
const KNOWN_SITES_MAP: Record<string, { url: string; siteName: string; domain: string }> = {
  youtube: { url: 'https://www.youtube.com/', siteName: 'YouTube', domain: 'youtube.com' },
  yt: { url: 'https://www.youtube.com/', siteName: 'YouTube', domain: 'youtube.com' },
  google: { url: 'https://www.google.com/', siteName: 'Google', domain: 'google.com' },
  github: { url: 'https://github.com/', siteName: 'GitHub', domain: 'github.com' },
  reddit: { url: 'https://www.reddit.com/', siteName: 'Reddit', domain: 'reddit.com' },
  twitter: { url: 'https://x.com/', siteName: 'X (Twitter)', domain: 'x.com' },
  x: { url: 'https://x.com/', siteName: 'X (Twitter)', domain: 'x.com' },
  wikipedia: { url: 'https://www.wikipedia.org/', siteName: 'Wikipedia', domain: 'wikipedia.org' },
  wiki: { url: 'https://www.wikipedia.org/', siteName: 'Wikipedia', domain: 'wikipedia.org' },
  amazon: { url: 'https://www.amazon.com/', siteName: 'Amazon', domain: 'amazon.com' },
  netflix: { url: 'https://www.netflix.com/', siteName: 'Netflix', domain: 'netflix.com' },
  spotify: { url: 'https://open.spotify.com/', siteName: 'Spotify', domain: 'spotify.com' },
  chatgpt: { url: 'https://chatgpt.com/', siteName: 'ChatGPT', domain: 'chatgpt.com' },
  openai: { url: 'https://openai.com/', siteName: 'OpenAI', domain: 'openai.com' },
  gmail: { url: 'https://mail.google.com/', siteName: 'Gmail', domain: 'mail.google.com' },
  'google maps': { url: 'https://maps.google.com/', siteName: 'Google Maps', domain: 'maps.google.com' },
  maps: { url: 'https://maps.google.com/', siteName: 'Google Maps', domain: 'maps.google.com' },
  'google docs': { url: 'https://docs.google.com/', siteName: 'Google Docs', domain: 'docs.google.com' },
  docs: { url: 'https://docs.google.com/', siteName: 'Google Docs', domain: 'docs.google.com' },
  'google drive': { url: 'https://drive.google.com/', siteName: 'Google Drive', domain: 'drive.google.com' },
  drive: { url: 'https://drive.google.com/', siteName: 'Google Drive', domain: 'drive.google.com' },
  'google news': { url: 'https://news.google.com/', siteName: 'Google News', domain: 'news.google.com' },
  news: { url: 'https://news.google.com/', siteName: 'Google News', domain: 'news.google.com' },
  linkedin: { url: 'https://www.linkedin.com/', siteName: 'LinkedIn', domain: 'linkedin.com' },
  twitch: { url: 'https://www.twitch.tv/', siteName: 'Twitch', domain: 'twitch.tv' },
  instagram: { url: 'https://www.instagram.com/', siteName: 'Instagram', domain: 'instagram.com' },
  facebook: { url: 'https://www.facebook.com/', siteName: 'Facebook', domain: 'facebook.com' },
  fb: { url: 'https://www.facebook.com/', siteName: 'Facebook', domain: 'facebook.com' },
  stackoverflow: { url: 'https://stackoverflow.com/', siteName: 'Stack Overflow', domain: 'stackoverflow.com' },
  'stack overflow': { url: 'https://stackoverflow.com/', siteName: 'Stack Overflow', domain: 'stackoverflow.com' },
  duckduckgo: { url: 'https://duckduckgo.com/', siteName: 'DuckDuckGo', domain: 'duckduckgo.com' },
  ddg: { url: 'https://duckduckgo.com/', siteName: 'DuckDuckGo', domain: 'duckduckgo.com' },
  bing: { url: 'https://www.bing.com/', siteName: 'Bing', domain: 'bing.com' },
  yahoo: { url: 'https://www.yahoo.com/', siteName: 'Yahoo', domain: 'yahoo.com' },
  cnn: { url: 'https://www.cnn.com/', siteName: 'CNN', domain: 'cnn.com' },
  bbc: { url: 'https://www.bbc.com/', siteName: 'BBC', domain: 'bbc.com' },
  nytimes: { url: 'https://www.nytimes.com/', siteName: 'The New York Times', domain: 'nytimes.com' },
  'new york times': { url: 'https://www.nytimes.com/', siteName: 'The New York Times', domain: 'nytimes.com' },
  hackernews: { url: 'https://news.ycombinator.com/', siteName: 'Hacker News', domain: 'news.ycombinator.com' },
  hn: { url: 'https://news.ycombinator.com/', siteName: 'Hacker News', domain: 'news.ycombinator.com' },
  notion: { url: 'https://www.notion.so/', siteName: 'Notion', domain: 'notion.so' },
  figma: { url: 'https://www.figma.com/', siteName: 'Figma', domain: 'figma.com' },
  canva: { url: 'https://www.canva.com/', siteName: 'Canva', domain: 'canva.com' },
  vercel: { url: 'https://vercel.com/', siteName: 'Vercel', domain: 'vercel.com' },
  discord: { url: 'https://discord.com/', siteName: 'Discord', domain: 'discord.com' },
  pinterest: { url: 'https://www.pinterest.com/', siteName: 'Pinterest', domain: 'pinterest.com' },
  whatsapp: { url: 'https://web.whatsapp.com/', siteName: 'WhatsApp Web', domain: 'web.whatsapp.com' },
  telegram: { url: 'https://web.telegram.org/', siteName: 'Telegram Web', domain: 'web.telegram.org' },
  weather: { url: 'https://weather.com/', siteName: 'The Weather Channel', domain: 'weather.com' },
};

/**
 * Validates, normalizes, and sanitizes a URL or site name
 */
export function validateUrl(rawUrl: string): {
  valid: boolean;
  normalizedUrl?: string;
  domain?: string;
  siteName?: string;
  error?: string;
} {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, error: 'URL must be a non-empty string.' };
  }

  let cleaned = rawUrl.trim();

  // Strip leading/trailing quotation marks or markdown wrapping
  cleaned = cleaned.replace(/^[`"']+|[`"']+$/g, '').trim();

  const lower = cleaned.toLowerCase();

  // Reject malicious or local executable schemes
  for (const forbidden of FORBIDDEN_SCHEMES) {
    if (lower.startsWith(forbidden)) {
      return { valid: false, error: `Disallowed URL protocol: "${forbidden}". Only http/https web addresses are permitted.` };
    }
  }

  // 1. Check direct known sites mapping
  if (KNOWN_SITES_MAP[lower]) {
    const known = KNOWN_SITES_MAP[lower];
    return {
      valid: true,
      normalizedUrl: known.url,
      domain: known.domain,
      siteName: known.siteName,
    };
  }

  // 2. Check if it's a known site with punctuation or prefix (e.g., "youtube.com" or "www.youtube.com")
  const strippedHost = lower.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/.*$/, '');
  if (KNOWN_SITES_MAP[strippedHost]) {
    const known = KNOWN_SITES_MAP[strippedHost];
    return {
      valid: true,
      normalizedUrl: cleaned.startsWith('http') ? cleaned : known.url,
      domain: known.domain,
      siteName: known.siteName,
    };
  }

  // 3. Normalize general URL
  let urlToTest = cleaned;
  if (!/^https?:\/\//i.test(cleaned)) {
    if (cleaned.includes(' ') && !cleaned.includes('.')) {
      // It's a search term, e.g. "google maps"
      urlToTest = `https://www.google.com/search?q=${encodeURIComponent(cleaned)}`;
    } else if (cleaned.includes('.')) {
      // Domain with dot, e.g. "github.com" or "news.ycombinator.com"
      urlToTest = 'https://' + cleaned;
    } else {
      // Single bare word without dots or spaces, not in KNOWN_SITES_MAP
      return { valid: false, error: 'Invalid URL or unrecognized website name.' };
    }
  }

  try {
    const parsed = new URL(urlToTest);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: `Invalid protocol: ${parsed.protocol}. Only http and https are allowed.` };
    }

    if (!parsed.hostname || parsed.hostname.length < 3 || (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost')) {
      return { valid: false, error: 'Invalid domain name or URL structure.' };
    }

    const domain = parsed.hostname.replace(/^www\./, '');
    const siteName = domain.split('.')[0] ? domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1) : domain;

    return {
      valid: true,
      normalizedUrl: parsed.href,
      domain,
      siteName,
    };
  } catch (err) {
    return { valid: false, error: `Malformed URL format: ${String(err)}` };
  }
}

export const openWebsiteTool: ToolDefinition<OpenWebsiteArgs, OpenWebsiteResult> = {
  name: 'openWebsite',
  description: 'Safely opens a requested website, web application, or URL VISIBLY in the user\'s own default browser (Chrome/Edge — the one they use every day, with their logins). Use this whenever the user wants something opened, visited, or navigated to — YouTube, GitHub, anything. The page appears on their screen.',
  permissionLevel: ToolPermissionLevel.LOW_RISK_ACTION,
  parameters: {
    type: 'OBJECT',
    properties: {
      url: {
        type: 'STRING',
        description: 'The website name, domain, or full URL to open (e.g. "YouTube", "Google", "GitHub", "https://wikipedia.org", "reddit.com").',
      },
    },
    required: ['url'],
  },

  validateArgs(args: unknown): { valid: boolean; error?: string; parsedArgs?: OpenWebsiteArgs } {
    if (!args || typeof args !== 'object') {
      return { valid: false, error: 'Arguments must be an object containing "url".' };
    }

    const { url } = args as Record<string, unknown>;
    const urlValidation = validateUrl(String(url || ''));

    if (!urlValidation.valid || !urlValidation.normalizedUrl) {
      return { valid: false, error: urlValidation.error || 'Invalid URL' };
    }

    return {
      valid: true,
      parsedArgs: { url: urlValidation.normalizedUrl },
    };
  },

  async execute(args: OpenWebsiteArgs, context): Promise<ToolExecutionResult<OpenWebsiteResult>> {
    try {
      const validation = validateUrl(args.url);
      if (!validation.valid || !validation.normalizedUrl) {
        return {
          success: false,
          error: validation.error || 'Validation failed for URL',
        };
      }

      const finalUrl = validation.normalizedUrl;
      const domain = validation.domain || 'website';
      const siteName = validation.siteName || domain;

      // VISIBLE-OPEN POLICY (regression fix): "open youtube" must put
      // YouTube on the user's screen. The managed Playwright browser is
      // headless — navigating it looks identical to doing nothing, which
      // produced the user complaint "SERA is not able to perform any kind
      // of system task like open youtube". So openWebsite now hands the
      // URL to the OS default browser first (their real browser, with
      // their logins), and only falls back to the managed session when
      // the OS cannot open it (e.g. headless server without xdg-open).
      const timestamp = new Date().toISOString();
      const manager = context?.actionManager;
      if (manager) {
        try {
          const action = manager.createAction({
            taskId: context?.sessionId,
            actionId: context?.executionId,
            type: 'browser.openDefault',
            parameters: { url: finalUrl },
          });
          const result = await manager.execute(action);
          if (result.status === 'succeeded') {
            return {
              success: true,
              userMessage: `Opening ${siteName} (${domain}) in your default browser.`,
              data: {
                url: finalUrl,
                domain,
                siteName,
                opened: true,
                timestamp,
                openedVia: 'default-browser',
                note: 'Opened in the user\'s default OS browser (visible on screen).',
              },
            };
          }
          // The OS could not open a default browser — fall back to the
          // managed session so the URL still loads somewhere the SERA
          // browser panel can show.
          const managedAction = manager.createAction({
            taskId: context?.sessionId,
            actionId: context?.executionId ? `${context.executionId}:managed` : undefined,
            type: 'browser.open',
            parameters: { url: finalUrl },
          });
          const managedResult = await manager.execute(managedAction);
          if (managedResult.status === 'succeeded') {
            return {
              success: true,
              userMessage: `Opened ${siteName} (${domain}) in SERA's managed browser (your default browser was unavailable: ${result.error?.message || 'unknown error'}).`,
              data: {
                url: finalUrl,
                domain,
                siteName,
                opened: true,
                timestamp,
                openedVia: 'managed-browser',
                note: 'Default browser unavailable; opened in the managed session instead.',
              },
            };
          }
          return {
            success: true,
            userMessage: `I could not open ${siteName} — no default browser and the managed browser failed (${managedResult.error?.message || result.error?.message || 'unknown error'}).`,
            data: {
              url: finalUrl,
              domain,
              siteName,
              opened: false,
              timestamp,
              directBrowserLaunchSupported: false,
              note: 'Both default-browser and managed-browser opens failed.',
            },
          };
        } catch (error) {
          return {
            success: true,
            userMessage: `Opening ${siteName} (${domain}) in your browser.`,
            data: {
              url: finalUrl,
              domain,
              siteName,
              opened: false,
              timestamp,
              note: `Managed browser open threw: ${error instanceof Error ? error.message : String(error)}`,
            },
          };
        }
      }

      // No ActionManager available (e.g. tests, CLI invocations) —
      // return the legacy "dispatched to client" result.
      return {
        success: true,
        userMessage: `Opening ${siteName} (${domain}) for you.`,
        data: {
          url: finalUrl,
          domain,
          siteName,
          opened: false,
          timestamp,
          note: 'Browser navigation is dispatched to the connected client.',
        },
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to open website: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
