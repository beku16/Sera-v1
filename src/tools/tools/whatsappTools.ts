import { ActionManager } from '../../actions/ActionManager';
import { DEFAULT_BROWSER_SESSION_ID } from '../../actions/BrowserExecutor';
import { ToolDefinition, ToolPermissionLevel } from '../types';

interface WhatsAppMessageArgs {
  contact: string;
  message: string;
  sessionId?: string;
}

const WHATSAPP_URL = 'https://web.whatsapp.com/';
// WhatsApp Web's DOM has shifted across releases; the data-tab attribute
// values have changed multiple times. The selectors below are ordered from
// most-specific (current 2024-2025 layout, using stable aria-label and
// data-testid attributes) to most-generic (any contenteditable footer /
// search box). The loop in execute() picks the first one that yields a
// verified typing result — i.e. one where the field actually echoed the
// typed value back, which is the only reliable signal that we hit the
// right element on this WhatsApp build.
const SEARCH_SELECTORS = [
  // 2025+ layout — stable test-id based selector.
  '[data-testid="chat-list-search"] [contenteditable="true"]',
  // 2024+ layout — search box uses data-tab="3" inside the side panel.
  '[contenteditable="true"][data-tab="3"]',
  // Alt 2024 layout — search input role with aria-label.
  '[contenteditable="true"][aria-label="Search input textbox"]',
  '[contenteditable="true"][role="textbox"][title="Search input textbox"]',
  // Generic aria-label based — catches most modern builds.
  'div[contenteditable="true"][aria-label*="Search" i]',
  // 2023 layout — search input by sibling label.
  'div[role="textbox"][contenteditable="true"]#side div[contenteditable="true"]',
  // Generic fallback — first contenteditable in the header (where the
  // search bar lives). Catches layouts that stripped data-tab attributes.
  'header div[contenteditable="true"]',
  // Final fallback — any contenteditable in the side panel.
  '#side div[contenteditable="true"]',
];
const MESSAGE_SELECTORS = [
  // 2025+ layout — stable test-id based selector.
  '[data-testid="conversation-panel-input"] [contenteditable="true"]',
  // 2024+ layout — message input uses data-tab="10" inside the footer.
  '[contenteditable="true"][data-tab="10"]',
  // Alt 2024 layout — message input by aria-label.
  '[contenteditable="true"][aria-label="Type a message"]',
  '[contenteditable="true"][role="textbox"][title="Type a message"]',
  // Generic aria-label based — catches most modern builds.
  'footer div[contenteditable="true"][role="textbox"]',
  // 2023 layout — message input in footer.
  'footer div[contenteditable="true"]',
  // Final fallback — any contenteditable at the bottom of the page (main panel).
  'main div[contenteditable="true"]',
];

function actionId(prefix: string): string {
  return `whatsapp-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const sendWhatsAppMessageTool: ToolDefinition<WhatsAppMessageArgs> = {
  name: 'sendWhatsAppMessage',
  description: 'Sends a WhatsApp Web message to an explicitly named contact after confirmation. The final send remains unverified until the chat is observed. Requires the user to be logged into WhatsApp Web in the managed browser session — if not logged in, the tool will report that WhatsApp Web could not be opened and the user should log in manually first.',
  permissionLevel: ToolPermissionLevel.DANGEROUS_ACTION,
  capability: 'BROWSER_CONTROL',
  parameters: {
    type: 'OBJECT',
    properties: {
      contact: { type: 'STRING', description: 'Exact contact or group name as shown in WhatsApp.' },
      message: { type: 'STRING', description: 'Message text to send.' },
      sessionId: { type: 'STRING', description: 'Optional managed browser session ID.' },
    },
    required: ['contact', 'message'],
  },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object') return { valid: false, error: 'WhatsApp contact and message are required.' };
    const value = args as Record<string, unknown>;
    if (typeof value.contact !== 'string' || !value.contact.trim()) return { valid: false, error: 'contact must be a non-empty string.' };
    if (typeof value.message !== 'string' || !value.message.trim()) return { valid: false, error: 'message must be a non-empty string.' };
    return {
      valid: true,
      parsedArgs: {
        contact: value.contact.trim(),
        message: value.message,
        sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
      },
    };
  },
  async execute(args, context) {
    const manager: ActionManager | undefined = context?.actionManager;
    if (!manager) return { success: false, error: 'Browser control is unavailable.' };
    // Reuse the canonical managed-browser session ID so WhatsApp shares
    // the same Playwright context as browserOpen/browserRead/browserTabs
    // and the renderer's screenshot endpoint. Previously this used a
    // separate 'sera-whatsapp' ID, which spawned a second Chromium
    // process and meant the user couldn't see what WhatsApp was doing
    // in the embedded browser panel.
    const sessionId = args.sessionId || DEFAULT_BROWSER_SESSION_ID;
    const run = async (type: string, parameters: Record<string, unknown>) => {
      const action = manager.createAction({ taskId: context?.sessionId, actionId: actionId(type.replace('.', '-')), type, parameters: { ...parameters, sessionId } });
      return manager.execute(action);
    };

    // 1. OPEN WhatsApp Web. If the user isn't logged in yet, WhatsApp Web
    //    will show a QR code login screen instead of the chat list. We
    //    detect this by checking whether the search input is present after
    //    a reasonable wait; if not, we tell the user to log in manually.
    const opened = await run('browser.open', { url: WHATSAPP_URL });
    if (opened.status !== 'succeeded') {
      return {
        success: false,
        error: opened.error?.message || 'WhatsApp Web could not be opened.',
        userMessage: 'I could not open WhatsApp Web in the managed browser. Run run_system_diagnostics to check whether Playwright Chromium is installed.',
      };
    }

    // 2. TYPE the contact name into the search box. WhatsApp Web's DOM
    //    has shifted across releases, so we try each candidate selector
    //    in order and stop at the first one that VERIFIES — i.e. the
    //    field actually echoed back the typed value, which is the only
    //    reliable signal we hit the right element on this WhatsApp build.
    //
    //    Loop guard: === 'succeeded' (NOT !== 'failed').
    //    The previous guard (!== 'failed') accepted 'inconclusive' as
    //    success, which broke in two ways:
    //      (a) When BrowserExecutor returned 'inconclusive' for
    //          browser.type (typing executed but verifyTypedValue
    //          returned false — selector was wrong), the loop broke on
    //          the FIRST candidate regardless of whether typing actually
    //          landed in the search field. The tool then proceeded to
    //          step 3, where browser.find(contactName) would return
    //          0 matches (since the search wasn't actually performed),
    //          and the tool would report "WhatsApp contact was not
    //          confirmed after selection" — masking the real cause.
    //      (b) After fixing BrowserExecutor.verify to return 'success'
    //          for completed actions, browser.type with verification
    //          failure still correctly returns 'inconclusive' — so the
    //          !== 'failed' guard would still accept it as success.
    //    The === 'succeeded' guard ensures we only proceed when typing
    //    was verified, which is the correct behaviour.
    let searchSelector: string | null = null;
    let searched: { status: string; error?: { message?: string } } = { status: 'failed' };
    for (const candidate of SEARCH_SELECTORS) {
      const attempt = await run('browser.type', { selector: candidate, value: args.contact });
      if (attempt.status === 'succeeded') {
        searchSelector = candidate;
        searched = attempt;
        break;
      }
    }
    if (searched.status !== 'succeeded') {
      return {
        success: false,
        error: 'WhatsApp Web search input was not found. The user is likely not logged in (QR code screen is showing) or the WhatsApp Web DOM has changed.',
        userMessage: 'WhatsApp Web is showing the login screen (QR code) or the DOM has changed. Open WhatsApp Web once via browserOpen({url:"https://web.whatsapp.com/"}) and scan the QR code with your phone to log in, then retry.',
      };
    }

    // 3. SELECT the contact by pressing Enter on the search box.
    if (!searchSelector) {
      return { success: false, error: 'Internal error: search selector was not recorded despite a successful search.' };
    }
    const selected = await run('browser.press', { selector: searchSelector, key: 'Enter' });
    if (selected.status !== 'succeeded') return { success: false, error: selected.error?.message || 'WhatsApp contact selection failed.' };

    // 4. CONFIRM the chat is actually open.
    //
    // CRITICAL FIX: Previously this used `browser.find({text: contact})`
    // which matches ANY element on the page containing the contact name.
    // The contact name appears in the sidebar chat list by definition
    // (that's why we can search for it), so `find(contact)` ALWAYS
    // returned matches >= 1, even if the chat panel didn't actually open
    // (e.g., search results page was still showing). That was the root
    // cause of the AI typing the message into the wrong field.
    //
    // Now we verify the chat is open by checking for the message input
    // placeholder "Type a message" — this text only exists in the chat
    // footer, which only renders after a chat is selected. If the chat
    // didn't open, the placeholder won't be present, and we can fail
    // fast with a helpful error.
    const placeholderCheck = await run('browser.find', { text: 'Type a message' });
    const placeholderMatches = placeholderCheck.result && typeof placeholderCheck.result === 'object' && typeof (placeholderCheck.result as { matches?: unknown }).matches === 'number'
      ? (placeholderCheck.result as { matches: number }).matches
      : 0;
    if (placeholderMatches < 1) {
      return {
        success: false,
        error: 'WhatsApp chat did not open after selecting the contact. The contact name may not exist in your WhatsApp account, or the search results were ambiguous.',
        userMessage: `I searched for "${args.contact}" and pressed Enter, but the chat panel didn't open. Please verify the contact name matches exactly what's shown in WhatsApp.`,
      };
    }

    // 5. TYPE the message into the chat input (try multiple selectors).
    let typed: { status: string; error?: { message?: string } } = { status: 'failed' };
    for (const candidate of MESSAGE_SELECTORS) {
      const attempt = await run('browser.type', { selector: candidate, value: args.message });
      if (attempt.status === 'succeeded') {
        typed = attempt;
        break;
      }
    }
    if (typed.status !== 'succeeded') return { success: false, error: typed.error?.message || 'WhatsApp message entry failed.' };

    // 6. SEND by pressing Enter on the message input. Re-try each
    //    selector until one accepts the Enter key.
    let sent: { status: string; error?: { message?: string } } = { status: 'failed' };
    for (const candidate of MESSAGE_SELECTORS) {
      const attempt = await run('browser.press', { selector: candidate, key: 'Enter' });
      if (attempt.status === 'succeeded') {
        sent = attempt;
        break;
      }
    }
    if (sent.status !== 'succeeded') return { success: false, error: sent.error?.message || 'WhatsApp message submission failed.' };

    // 7. VERIFY the message is visible in the active chat.
    const messageCheck = await run('browser.find', { text: args.message });
    const messageMatches = messageCheck.result && typeof messageCheck.result === 'object' && typeof (messageCheck.result as { matches?: unknown }).matches === 'number'
      ? (messageCheck.result as { matches: number }).matches
      : 0;
    if (messageMatches < 1) {
      return { success: false, userMessage: 'Message submission was attempted, but the message was not observed in the active chat.', error: 'WhatsApp delivery is unverified.', data: { contact: args.contact, verification: 'inconclusive' } };
    }
    return { success: true, userMessage: 'Message is visible in the selected WhatsApp chat. Delivery receipt remains unverified.', data: { contact: args.contact, verification: 'chat-visible' } };
  },
};
