import { describe, expect, it } from 'vitest';
import { sendWhatsAppMessageTool } from '../tools/tools/whatsappTools';
import { ToolPermissionLevel } from '../tools/types';

describe('sendWhatsAppMessageTool', () => {
  it('requires an explicit contact and message', () => {
    expect(sendWhatsAppMessageTool.validateArgs({}).valid).toBe(false);
    expect(sendWhatsAppMessageTool.validateArgs({ contact: 'Alex' }).valid).toBe(false);
    expect(sendWhatsAppMessageTool.validateArgs({ message: 'Hello' }).valid).toBe(false);
  });

  it('preserves message whitespace while trimming contact identity', () => {
    const result = sendWhatsAppMessageTool.validateArgs({ contact: '  Alex  ', message: '  Hello there  ' });
    expect(result).toEqual({ valid: true, parsedArgs: { contact: 'Alex', message: '  Hello there  ', sessionId: undefined } });
  });

  it('is gated as a confirmed browser side effect', () => {
    expect(sendWhatsAppMessageTool.permissionLevel).toBe(ToolPermissionLevel.DANGEROUS_ACTION);
    expect(sendWhatsAppMessageTool.capability).toBe('BROWSER_CONTROL');
  });
});
