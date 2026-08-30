import { describe, expect, it } from 'vitest';
import { sendWhatsAppMessageTool } from '../tools/tools/whatsappTools';
import type { ActionManager } from '../actions/ActionManager';

/**
 * Fake ActionManager for the WhatsApp tool tests.
 *
 * Previously this fake returned `'inconclusive'` for `browser.press` —
 * modelling the production bug where BrowserExecutor.verify always
 * returned `'inconclusive'` for non-open/navigate actions. With that
 * bug fixed (BrowserExecutor now returns `'success'` for completed
 * browser.* actions), the fake must match the new production
 * behaviour: every browser.* action returns `'succeeded'` (except
 * `browser.find`, which carries the `matches` count in its result).
 *
 * `browser.type` returns `'succeeded'` here to model the case where
 * `verifyTypedValue` returned true (the text was actually typed). The
 * WhatsApp tool's loop now uses `=== 'succeeded'` (not `!== 'failed'`)
 * to accept a candidate selector, so a fake that returns `'succeeded'`
 * for `browser.type` makes the loop break on the first candidate —
 * matching what real WhatsApp Web does when the first selector is the
 * right one.
 */
function fakeActionManager(messageMatches: number): ActionManager {
  return {
    createAction: (input: Record<string, unknown>) => ({ ...input, actionId: String(input.actionId), taskId: String(input.taskId || 'task'), status: 'queued', createdAt: new Date().toISOString() }),
    execute: async (action: { type: string; parameters?: { text?: string } }) => {
      if (action.type === 'browser.find') {
        return { status: 'succeeded', result: { matches: action.parameters?.text === 'Hello' ? messageMatches : 1 } };
      }
      return { status: 'succeeded', result: {} };
    },
  } as unknown as ActionManager;
}

describe('WhatsApp send verification', () => {
  it('succeeds when the submitted message is visible in the active chat', async () => {
    const result = await sendWhatsAppMessageTool.execute(
      { contact: 'Alex', message: 'Hello' },
      { actionManager: fakeActionManager(1), sessionId: 'test-session', userConfirmed: true },
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ contact: 'Alex', verification: 'chat-visible' });
  });

  it('keeps delivery inconclusive when the message is not observed', async () => {
    const result = await sendWhatsAppMessageTool.execute(
      { contact: 'Alex', message: 'Hello' },
      { actionManager: fakeActionManager(0), sessionId: 'test-session', userConfirmed: true },
    );

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ contact: 'Alex', verification: 'inconclusive' });
  });
});

