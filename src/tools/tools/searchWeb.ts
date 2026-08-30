import { ToolDefinition, ToolPermissionLevel, ToolExecutionContext } from '../types';

export interface SearchWebArgs {
  query: string;
  engine?: 'google' | 'bing' | 'duckduckgo' | 'youtube' | 'reddit' | 'wikipedia';
}

export interface SearchWebResult {
  query: string;
  url: string;
  engine: string;
  domain: string;
  siteName: string;
  opened: boolean;
  timestamp: string;
  directBrowserLaunchSupported?: boolean;
}

const SEARCH_ENGINES: Record<
  string,
  { name: string; domain: string; buildUrl: (q: string) => string }
> = {
  google: {
    name: 'Google Search',
    domain: 'google.com',
    buildUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  },
  bing: {
    name: 'Bing Search',
    domain: 'bing.com',
    buildUrl: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  },
  duckduckgo: {
    name: 'DuckDuckGo',
    domain: 'duckduckgo.com',
    buildUrl: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  },
  youtube: {
    name: 'YouTube Search',
    domain: 'youtube.com',
    buildUrl: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  },
  reddit: {
    name: 'Reddit Search',
    domain: 'reddit.com',
    buildUrl: (q) => `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`,
  },
  wikipedia: {
    name: 'Wikipedia Search',
    domain: 'wikipedia.org',
    buildUrl: (q) => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`,
  },
};

export const searchWebTool: ToolDefinition<SearchWebArgs, SearchWebResult> = {
  name: 'searchWeb',
  description:
    'Searches the web for any query or keywords and immediately shows the results page VISIBLY in the user\'s own default browser (their real browser with their logins). Use for "search for X", "look up Y", "google Z", "find videos about W on youtube".',
  permissionLevel: ToolPermissionLevel.LOW_RISK_ACTION,
  capability: 'BROWSER_CONTROL',
  parameters: {
    type: 'OBJECT',
    properties: {
      query: {
        type: 'STRING',
        description: 'The search keywords or topic to search for (e.g. "latest AI news", "how to bake sourdough", "weather in Tokyo").',
      },
      engine: {
        type: 'STRING',
        description: 'Optional search engine: "google", "bing", "duckduckgo", "youtube", "reddit", or "wikipedia". Defaults to "google".',
        enum: ['google', 'bing', 'duckduckgo', 'youtube', 'reddit', 'wikipedia'],
      },
    },
    required: ['query'],
  },
  validateArgs: (args: unknown) => {
    if (!args || typeof args !== 'object') {
      return { valid: false, error: 'Arguments must be an object with a "query" field.' };
    }
    const { query, engine } = args as Record<string, unknown>;
    if (!query || typeof query !== 'string' || !query.trim()) {
      return { valid: false, error: 'Query must be a non-empty string.' };
    }
    const cleanQuery = query.trim();
    let selectedEngine: SearchWebArgs['engine'] = 'google';
    if (typeof engine === 'string' && SEARCH_ENGINES[engine.toLowerCase()]) {
      selectedEngine = engine.toLowerCase() as SearchWebArgs['engine'];
    }
    return {
      valid: true,
      parsedArgs: {
        query: cleanQuery,
        engine: selectedEngine,
      },
    };
  },
  // CRITICAL FIX: Previously this tool returned `opened: false` and NEVER
  // called ActionManager — meaning the managed browser never actually
  // navigated to the search engine. The tool returned a URL string to
  // the AI as data, but no page ever loaded. The AI would then call
  // browserRead (expecting to read the search results) and get back the
  // about:blank page text — empty. This was the structural root cause of
  // "Read webpage content does not work."
  //
  // Now we delegate to `browser.open` via ActionManager — the same
  // pattern as openWebsite — so the search URL actually loads in the
  // managed Playwright session and the AI can immediately call
  // browserRead to extract result titles/links.
  execute: async (args: SearchWebArgs, context?: ToolExecutionContext) => {
    try {
      const engineKey = (args.engine || 'google').toLowerCase();
      const engineConfig = SEARCH_ENGINES[engineKey] || SEARCH_ENGINES.google;
      const targetUrl = engineConfig.buildUrl(args.query);
      const timestamp = new Date().toISOString();

      const manager = context?.actionManager;
      if (manager) {
        try {
          const action = manager.createAction({
            taskId: context?.sessionId,
            actionId: context?.executionId,
            type: 'browser.openDefault',
            parameters: { url: targetUrl },
          });
          const result = await manager.execute(action);
          if (result.status === 'succeeded') {
            return {
              success: true,
              userMessage: `Opened ${engineConfig.name} results for "${args.query}" in your default browser.`,
              data: {
                query: args.query,
                url: targetUrl,
                engine: engineConfig.name,
                domain: engineConfig.domain,
                siteName: `${engineConfig.name} (${args.query})`,
                opened: true,
                timestamp,
                openedVia: 'default-browser',
                note: 'Search results opened VISIBLY in the user\'s default browser. For automation reading, drive the managed session with browserOpen + browserRead separately.',
              },
            };
          }
          // Default-browser open failed (headless server etc.) — fall back
          // to the managed session so the search still loads, and the AI
          // can browserRead the results there.
          const managedAction = manager.createAction({
            taskId: context?.sessionId,
            actionId: context?.executionId ? `${context.executionId}:managed` : undefined,
            type: 'browser.open',
            parameters: { url: targetUrl },
          });
          const managedResult = await manager.execute(managedAction);
          if (managedResult.status === 'succeeded') {
            return {
              success: true,
              userMessage: `Opened ${engineConfig.name} results for "${args.query}" in SERA's managed browser (your default browser was unavailable).`,
              data: {
                query: args.query,
                url: targetUrl,
                engine: engineConfig.name,
                domain: engineConfig.domain,
                siteName: `${engineConfig.name} (${args.query})`,
                opened: true,
                timestamp,
                openedVia: 'managed-browser',
                note: 'Default browser unavailable; results opened in the managed session. Call browserRead to inspect them.',
              },
            };
          }
          // Both opens failed — surface gracefully.
          return {
            success: true,
            userMessage: `I could not open search results for "${args.query}" — no default browser and the managed browser failed.`,
            data: {
              query: args.query,
              url: targetUrl,
              engine: engineConfig.name,
              domain: engineConfig.domain,
              siteName: `${engineConfig.name} (${args.query})`,
              opened: false,
              timestamp,
              directBrowserLaunchSupported: false,
              note: `Default browser open failed (${result.error?.message || 'unknown error'}); managed browser open failed (${managedResult.error?.message || 'unknown error'}).`,
            },
          };
        } catch (error) {
          return {
            success: true,
            userMessage: `Opening ${engineConfig.name} results for "${args.query}".`,
            data: {
              query: args.query,
              url: targetUrl,
              engine: engineConfig.name,
              domain: engineConfig.domain,
              siteName: `${engineConfig.name} (${args.query})`,
              opened: false,
              timestamp,
              note: `Managed browser open threw: ${error instanceof Error ? error.message : String(error)}`,
            },
          };
        }
      }

      // No ActionManager available (tests / CLI) — return the URL only.
      return {
        success: true,
        userMessage: `Opening ${engineConfig.name} results for "${args.query}" automatically.`,
        data: {
          query: args.query,
          url: targetUrl,
          engine: engineConfig.name,
          domain: engineConfig.domain,
          siteName: `${engineConfig.name} (${args.query})`,
          opened: false,
          timestamp,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to open search results: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
