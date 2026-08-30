import { describe, expect, it } from 'vitest';
import { ComputerAuthorizationManager } from '../authorization/ComputerAuthorizationManager';
import { parseStartApps } from '../authorization/ApplicationResolver';
import { ToolManager } from '../tools/ToolManager';
import { ToolPermissionLevel } from '../tools/types';

describe('ComputerAuthorizationManager', () => {
  it('defaults every session to STANDARD with no capabilities', () => {
    const manager = new ComputerAuthorizationManager();
    expect(manager.getAuthorizationState('new-session')).toMatchObject({ mode: 'STANDARD', capabilities: [] });
    expect(manager.hasCapability('MOUSE_CONTROL', 'new-session')).toBe(false);
  });

  it('grants the normal computer capability set only after an explicit mode change', () => {
    const manager = new ComputerAuthorizationManager();
    manager.setAuthorizationMode('TRUSTED', 'session-1');
    expect(manager.hasCapability('MOUSE_CONTROL', 'session-1')).toBe(true);
    expect(manager.hasCapability('APPLICATION_LAUNCH', 'session-1')).toBe(true);
    expect(manager.getAuthorizationState('session-1').mode).toBe('TRUSTED');
  });

  it('revokes a capability without affecting other sessions', () => {
    const manager = new ComputerAuthorizationManager();
    manager.setAuthorizationMode('FULL_CONTROL', 'session-1');
    manager.setAuthorizationMode('TRUSTED', 'session-2');
    manager.revokeCapability('CLIPBOARD_WRITE', 'session-1');
    expect(manager.hasCapability('CLIPBOARD_WRITE', 'session-1')).toBe(false);
    expect(manager.hasCapability('CLIPBOARD_WRITE', 'session-2')).toBe(true);
  });

  it('emits authorization changes with the selected mode', () => {
    const manager = new ComputerAuthorizationManager();
    const events: string[] = [];
    manager.subscribe((event) => events.push(`${event.sessionId}:${event.state.mode}`));
    manager.setAuthorizationMode('FULL_CONTROL', 'session-1');
    expect(events).toEqual(['session-1:FULL_CONTROL']);
    expect(manager.hasCapability('SYSTEM_SETTINGS', 'session-1')).toBe(true);
  });

  it('low-risk everyday tools run without capability gating; sensitive tools stay gated', async () => {
    const authorization = new ComputerAuthorizationManager();
    const tools = new ToolManager(undefined, authorization);
    // LOW_RISK probe: openWebsite / searchWeb / openApplication class.
    // Everyday reversible actions must NOT be denied by computer-control
    // capabilities (browser/PWA sessions have no SERA_DESKTOP_MODE
    // auto-trust, and "open youtube" failing with "Capability
    // BROWSER_CONTROL requires authorization" made Local Mode look dead).
    tools.registerTool({
      name: 'launchTestApplication',
      description: 'Test capability gate.',
      permissionLevel: ToolPermissionLevel.LOW_RISK_ACTION,
      capability: 'APPLICATION_LAUNCH',
      parameters: { type: 'OBJECT', properties: {} },
      validateArgs: () => ({ valid: true, parsedArgs: {} }),
      execute: async () => ({ success: true, data: { verified: true } }),
    });

    const allowed = await tools.executeTool('launchTestApplication', {}, { sessionId: 'session-1' });
    expect(allowed.success).toBe(true);

    // SENSITIVE probe: the class of controlComputerInput / getClipboard —
    // capability enforcement must keep blocking these without authorization.
    tools.registerTool({
      name: 'sensitiveProbe',
      description: 'Test sensitive capability gate.',
      permissionLevel: ToolPermissionLevel.SENSITIVE_ACTION,
      capability: 'APPLICATION_LAUNCH',
      parameters: { type: 'OBJECT', properties: {} },
      validateArgs: () => ({ valid: true, parsedArgs: {} }),
      execute: async () => ({ success: true, data: { verified: true } }),
    });

    const blocked = await tools.executeTool('sensitiveProbe', {}, { sessionId: 'session-1' });
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain('APPLICATION_LAUNCH');

    authorization.setAuthorizationMode('TRUSTED', 'session-1');
    const unblocked = await tools.executeTool('sensitiveProbe', {}, { sessionId: 'session-1' });
    expect(unblocked.success).toBe(true);
  });

  it('parses registered Windows Start Apps without treating names as permissions', () => {
    expect(parseStartApps('[{"name":"WhatsApp","appId":"WhatsApp.Client!App"}]')).toEqual([
      { name: 'WhatsApp', appId: 'WhatsApp.Client!App' },
    ]);
    expect(parseStartApps('{"name":"Notepad","appId":"Microsoft.Notepad!App"}')).toHaveLength(1);
    expect(parseStartApps('[{"Name":"AnyDesk","AppID":"prokzult ad"}]')).toEqual([{ name: 'AnyDesk', appId: 'prokzult ad' }]);
    expect(parseStartApps('invalid')).toEqual([]);
  });
});