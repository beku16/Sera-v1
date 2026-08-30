import { describe, expect, it } from 'vitest';
import { ActionManager } from '../actions/ActionManager';
import { ComputerAuthorizationManager } from '../authorization/ComputerAuthorizationManager';
import { computerControlAuthorizationTool } from '../tools/tools/windowTools';

describe('authorization compatibility', () => {
  it('keeps legacy ActionManager authorization synchronized with capability modes', async () => {
    const actionManager = new ActionManager();
    const authorization = new ComputerAuthorizationManager();
    const sessionId = 'compat-session';

    const trusted = await computerControlAuthorizationTool.execute(
      { mode: 'TRUSTED' },
      { actionManager, authorizationManager: authorization, sessionId },
    );
    expect(trusted.success).toBe(true);
    expect(actionManager.isComputerControlAuthorized(sessionId)).toBe(true);
    expect(authorization.hasCapability('KEYBOARD_CONTROL', sessionId)).toBe(true);

    const fullControl = await computerControlAuthorizationTool.execute(
      { mode: 'FULL_CONTROL' },
      { actionManager, authorizationManager: authorization, sessionId },
    );
    expect(fullControl.success).toBe(true);
    expect(authorization.hasCapability('SYSTEM_SETTINGS', sessionId)).toBe(true);
    expect(actionManager.isComputerControlAuthorized(sessionId)).toBe(true);

    const standard = await computerControlAuthorizationTool.execute(
      { mode: 'STANDARD' },
      { actionManager, authorizationManager: authorization, sessionId },
    );
    expect(standard.success).toBe(true);
    expect(actionManager.isComputerControlAuthorized(sessionId)).toBe(false);
    expect(authorization.hasCapability('KEYBOARD_CONTROL', sessionId)).toBe(false);
  });
});

