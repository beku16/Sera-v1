import { describe, expect, it } from 'vitest';
import { ComputerAuthorizationManager } from '../authorization/ComputerAuthorizationManager';
import { ToolManager } from '../tools/ToolManager';
import { ToolPermissionLevel } from '../tools/types';
import { computerInputTool } from '../tools/tools/computerControlTools';

describe('computer input capability routing', () => {
  it('requires keyboard control for keyboard operations', () => {
    expect(computerInputTool.capabilityForArgs?.({ operation: 'type' })).toBe('KEYBOARD_CONTROL');
    expect(computerInputTool.capabilityForArgs?.({ operation: 'press' })).toBe('KEYBOARD_CONTROL');
    expect(computerInputTool.capabilityForArgs?.({ operation: 'hotkey' })).toBe('KEYBOARD_CONTROL');
  });

  it('requires mouse control for pointer operations', () => {
    expect(computerInputTool.capabilityForArgs?.({ operation: 'click' })).toBe('MOUSE_CONTROL');
    expect(computerInputTool.capabilityForArgs?.({ operation: 'move' })).toBe('MOUSE_CONTROL');
    expect(computerInputTool.capabilityForArgs?.({ operation: 'drag' })).toBe('MOUSE_CONTROL');
    expect(computerInputTool.capabilityForArgs?.({ operation: 'scroll' })).toBe('MOUSE_CONTROL');
  });

  it('enforces the resolved capability at dispatch time', async () => {
    const authorization = new ComputerAuthorizationManager();
    const manager = new ToolManager(undefined, authorization);
    manager.registerTool({
      name: 'inputCapabilityProbe',
      description: 'Tests dynamic input capability enforcement.',
      // SENSITIVE_ACTION matches the real controlComputerInput tool —
      // capability enforcement applies to SENSITIVE/DANGEROUS levels.
      permissionLevel: ToolPermissionLevel.SENSITIVE_ACTION,
      capability: 'MOUSE_CONTROL',
      capabilityForArgs: (args) => (args as { operation: string }).operation === 'press' ? 'KEYBOARD_CONTROL' : 'MOUSE_CONTROL',
      parameters: { type: 'OBJECT', properties: {} },
      validateArgs: (args) => ({ valid: true, parsedArgs: args as { operation: string } }),
      execute: async () => ({ success: true }),
    });

    authorization.setAuthorizationMode('TRUSTED', 'session');
    authorization.revokeCapability('MOUSE_CONTROL', 'session');

    const keyboard = await manager.executeTool('inputCapabilityProbe', { operation: 'press' }, { sessionId: 'session' });
    const mouse = await manager.executeTool('inputCapabilityProbe', { operation: 'click' }, { sessionId: 'session' });

    expect(keyboard.success).toBe(true);
    expect(mouse.success).toBe(false);
    expect(mouse.error).toContain('MOUSE_CONTROL');
  });
});
