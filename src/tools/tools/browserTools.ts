import { ActionManager } from '../../actions/ActionManager';
import { ToolDefinition, ToolPermissionLevel } from '../types';

interface BrowserOpenArgs {
  url: string;
  sessionId?: string;
}

interface BrowserNavigateArgs {
  url: string;
  sessionId?: string;
  tabId?: string;
}

interface BrowserReadArgs {
  sessionId?: string;
  tabId?: string;
}

interface BrowserTabsArgs {
  sessionId?: string;
}

function managerOrError(manager: ActionManager | undefined) {
  return manager || null;
}

export const browserOpenTool: ToolDefinition<BrowserOpenArgs> = {
  name: 'browserOpen',
  description: 'Opens a URL in the managed browser session and returns its active tab state.',
  permissionLevel: ToolPermissionLevel.LOW_RISK_ACTION,
  capability: 'BROWSER_CONTROL',
  parameters: {
    type: 'OBJECT',
    properties: {
      url: { type: 'STRING', description: 'Target URL or site name to open.' },
      sessionId: { type: 'STRING', description: 'Optional browser session ID to reuse.' },
    },
    required: ['url'],
  },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object') return { valid: false, error: 'Browser open requires a URL.' };
    const value = args as Record<string, unknown>;
    if (typeof value.url !== 'string' || !value.url.trim()) return { valid: false, error: 'url must be a non-empty string.' };
    return { valid: true, parsedArgs: { url: value.url.trim(), sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined } };
  },
  async execute(args, context) {
    const manager = managerOrError(context?.actionManager);
    if (!manager) return { success: false, error: 'Browser control is unavailable.' };
    const action = manager.createAction({
      taskId: context?.sessionId,
      actionId: context?.executionId,
      type: 'browser.open',
      parameters: args,
    });
    const result = await manager.execute(action);
    return result.status === 'succeeded' ? { success: true, data: result.result } : { success: false, error: result.error?.message || 'Browser open failed.' };
  },
};

export const browserNavigateTool: ToolDefinition<BrowserNavigateArgs> = {
  name: 'browserNavigate',
  description: 'Navigates the active or named browser tab to a specific URL.',
  permissionLevel: ToolPermissionLevel.LOW_RISK_ACTION,
  capability: 'BROWSER_CONTROL',
  parameters: {
    type: 'OBJECT',
    properties: {
      url: { type: 'STRING', description: 'The destination URL to navigate to.' },
      tabId: { type: 'STRING', description: 'Optional tab ID to use instead of the active tab.' },
      sessionId: { type: 'STRING', description: 'Optional browser session ID.' },
    },
    required: ['url'],
  },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object') return { valid: false, error: 'Browser navigation requires a URL.' };
    const value = args as Record<string, unknown>;
    if (typeof value.url !== 'string' || !value.url.trim()) return { valid: false, error: 'url must be a non-empty string.' };
    return { valid: true, parsedArgs: { url: value.url.trim(), tabId: typeof value.tabId === 'string' ? value.tabId : undefined, sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined } };
  },
  async execute(args, context) {
    const manager = managerOrError(context?.actionManager);
    if (!manager) return { success: false, error: 'Browser control is unavailable.' };
    const action = manager.createAction({
      taskId: context?.sessionId,
      actionId: context?.executionId,
      type: 'browser.navigate',
      parameters: args,
    });
    const result = await manager.execute(action);
    return result.status === 'succeeded' ? { success: true, data: result.result } : { success: false, error: result.error?.message || 'Browser navigation failed.' };
  },
};

export const browserReadTool: ToolDefinition<BrowserReadArgs> = {
  name: 'browserRead',
  description: 'Read the current page content, links, headings, and title from the managed browser tab.',
  permissionLevel: ToolPermissionLevel.READ_ONLY,
  capability: 'COMPUTER_READ',
  parameters: {
    type: 'OBJECT',
    properties: {
      tabId: { type: 'STRING', description: 'Optional tab ID to inspect. Defaults to the active tab.' },
      sessionId: { type: 'STRING', description: 'Optional browser session ID.' },
    },
  },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object') return { valid: true, parsedArgs: {} };
    const value = args as Record<string, unknown>;
    return {
      valid: true,
      parsedArgs: {
        tabId: typeof value.tabId === 'string' ? value.tabId : undefined,
        sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
      },
    };
  },
  async execute(args, context) {
    const manager = managerOrError(context?.actionManager);
    if (!manager) return { success: false, error: 'Browser control is unavailable.' };
    const action = manager.createAction({
      taskId: context?.sessionId,
      actionId: context?.executionId,
      type: 'browser.read',
      parameters: args,
    });
    const result = await manager.execute(action);
    // Both 'succeeded' AND 'inconclusive' surface the read result to the
    // AI — for inconclusive reads (empty page text), the verification
    // message tells the AI "you may need to navigate first" while still
    // returning whatever data the read produced. Previously, an
    // inconclusive status was treated as failure here, which meant the
    // AI never saw the page content for empty pages — it only saw
    // "Browser reading failed" with no useful diagnostic.
    if (result.status === 'succeeded' || result.status === 'inconclusive') {
      return {
        success: true,
        userMessage: result.verification?.message,
        data: result.result,
      };
    }
    return { success: false, error: result.error?.message || 'Browser reading failed.' };
  },
};

export const browserTabsTool: ToolDefinition<BrowserTabsArgs> = {
  name: 'browserTabs',
  description: 'Lists the active managed browser session tabs and their current URLs.',
  permissionLevel: ToolPermissionLevel.READ_ONLY,
  capability: 'COMPUTER_READ',
  parameters: {
    type: 'OBJECT',
    properties: {
      sessionId: { type: 'STRING', description: 'Optional browser session ID.' },
    },
  },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object') return { valid: true, parsedArgs: {} };
    const value = args as Record<string, unknown>;
    return { valid: true, parsedArgs: { sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined } };
  },
  async execute(args, context) {
    const manager = managerOrError(context?.actionManager);
    if (!manager) return { success: false, error: 'Browser control is unavailable.' };
    const action = manager.createAction({
      taskId: context?.sessionId,
      actionId: context?.executionId,
      type: 'browser.tabs',
      parameters: args,
    });
    const result = await manager.execute(action);
    return result.status === 'succeeded' ? { success: true, data: result.result } : { success: false, error: result.error?.message || 'Browser tab query failed.' };
  },
};

// ===========================================================================
// Tab management tools — browserNewTab / browserSwitchTab / browserCloseTab.
//
// The action types (browser.newTab, browser.switchTab, browser.closeTab) and
// the executor handling already existed (see BrowserExecutor.ts:76-90 and
// BrowserSessionManager.ts:189-246). But there were NO Gemini-facing tool
// wrappers registered for them — the AI literally had no function
// declaration to call to create, switch, or close a tab. The audit
// identified this as the structural root cause of "Browser tab management
// does not work." Now they're registered in toolRegistry.ts alongside
// the other browser tools.
// ===========================================================================

interface BrowserNewTabArgs {
  url?: string;
  sessionId?: string;
}

export const browserNewTabTool: ToolDefinition<BrowserNewTabArgs> = {
  name: 'browserNewTab',
  description: 'Opens a new tab in the managed browser session. Optionally navigates the new tab to a URL. The new tab becomes the active tab.',
  permissionLevel: ToolPermissionLevel.LOW_RISK_ACTION,
  capability: 'BROWSER_CONTROL',
  parameters: {
    type: 'OBJECT',
    properties: {
      url: { type: 'STRING', description: 'Optional URL to navigate the new tab to. If omitted, the tab opens to about:blank.' },
      sessionId: { type: 'STRING', description: 'Optional browser session ID.' },
    },
  },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object') return { valid: true, parsedArgs: {} };
    const value = args as Record<string, unknown>;
    const url = typeof value.url === 'string' && value.url.trim() ? value.url.trim() : undefined;
    return {
      valid: true,
      parsedArgs: { url, sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined },
    };
  },
  async execute(args, context) {
    const manager = managerOrError(context?.actionManager);
    if (!manager) return { success: false, error: 'Browser control is unavailable.' };
    const action = manager.createAction({
      taskId: context?.sessionId,
      actionId: context?.executionId,
      type: 'browser.newTab',
      parameters: args,
    });
    const result = await manager.execute(action);
    return result.status === 'succeeded' ? { success: true, data: result.result } : { success: false, error: result.error?.message || 'Browser new tab failed.' };
  },
};

interface BrowserSwitchTabArgs {
  tabId: string;
  sessionId?: string;
}

export const browserSwitchTabTool: ToolDefinition<BrowserSwitchTabArgs> = {
  name: 'browserSwitchTab',
  description: 'Switches the active tab in the managed browser session to the tab with the given ID. Use browserTabs first to discover tab IDs.',
  permissionLevel: ToolPermissionLevel.LOW_RISK_ACTION,
  capability: 'BROWSER_CONTROL',
  parameters: {
    type: 'OBJECT',
    properties: {
      tabId: { type: 'STRING', description: 'The tab ID to switch to. Obtain from browserTabs.' },
      sessionId: { type: 'STRING', description: 'Optional browser session ID.' },
    },
    required: ['tabId'],
  },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object') return { valid: false, error: 'tabId is required.' };
    const value = args as Record<string, unknown>;
    if (typeof value.tabId !== 'string' || !value.tabId.trim()) return { valid: false, error: 'tabId must be a non-empty string.' };
    return { valid: true, parsedArgs: { tabId: value.tabId.trim(), sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined } };
  },
  async execute(args, context) {
    const manager = managerOrError(context?.actionManager);
    if (!manager) return { success: false, error: 'Browser control is unavailable.' };
    const action = manager.createAction({
      taskId: context?.sessionId,
      actionId: context?.executionId,
      type: 'browser.switchTab',
      parameters: args,
    });
    const result = await manager.execute(action);
    return result.status === 'succeeded' ? { success: true, data: result.result } : { success: false, error: result.error?.message || 'Browser tab switch failed.' };
  },
};

interface BrowserCloseTabArgs {
  tabId?: string;
  sessionId?: string;
}

export const browserCloseTabTool: ToolDefinition<BrowserCloseTabArgs> = {
  name: 'browserCloseTab',
  description: 'Closes a tab in the managed browser session. If no tabId is given, closes the active tab. If the last tab is closed, a fresh about:blank tab is created.',
  permissionLevel: ToolPermissionLevel.LOW_RISK_ACTION,
  capability: 'BROWSER_CONTROL',
  parameters: {
    type: 'OBJECT',
    properties: {
      tabId: { type: 'STRING', description: 'Optional tab ID to close. Defaults to the active tab.' },
      sessionId: { type: 'STRING', description: 'Optional browser session ID.' },
    },
  },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object') return { valid: true, parsedArgs: {} };
    const value = args as Record<string, unknown>;
    return {
      valid: true,
      parsedArgs: {
        tabId: typeof value.tabId === 'string' && value.tabId.trim() ? value.tabId.trim() : undefined,
        sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
      },
    };
  },
  async execute(args, context) {
    const manager = managerOrError(context?.actionManager);
    if (!manager) return { success: false, error: 'Browser control is unavailable.' };
    const action = manager.createAction({
      taskId: context?.sessionId,
      actionId: context?.executionId,
      type: 'browser.closeTab',
      parameters: args,
    });
    const result = await manager.execute(action);
    return result.status === 'succeeded' ? { success: true, data: result.result } : { success: false, error: result.error?.message || 'Browser tab close failed.' };
  },
};
