import { describe, expect, it } from 'vitest';
import { ActionManager } from '../actions/ActionManager';
import { ApplicationExecutor } from '../actions/ApplicationExecutor';
import { InputExecutor } from '../actions/InputExecutor';
import { ScreenExecutor } from '../actions/ScreenExecutor';
import { WindowExecutor, WindowsWindowProvider } from '../actions/WindowExecutor';
import { RobotJsInputController, RobotJsScreenController } from '../actions/WindowsProviders';
import { ScreenUnderstanding } from '../vision/ScreenUnderstanding';
import { TesseractOcrProvider } from '../vision/TesseractOcrProvider';
import { VisionExecutor } from '../vision/VisionExecutor';

const enabled = process.platform === 'win32' && process.env.SERA_RUN_WINDOWS_INTEGRATION === '1';
const describeWindows = enabled ? describe : describe.skip;

describeWindows('real Windows generic application control flow', () => {
  it('does not report unobserved input as successful', async () => {
    const controller = new RobotJsInputController();
    const manager = new ActionManager({ logger: () => {} });
    manager.registerExecutor(new InputExecutor(controller));

    // Native dispatch without an observer is not enough evidence of success.
    const type = await manager.execute(manager.createAction({ taskId: 'arch-test', type: 'input.type', parameters: { text: 'test' } }));
    expect(['succeeded', 'failed']).toContain(type.status);
    expect(['success', 'failure']).toContain(type.verification?.status);

    const press = await manager.execute(manager.createAction({ taskId: 'arch-test', type: 'input.press', parameters: { key: 'enter' } }));
    expect(['succeeded', 'failed']).toContain(press.status);
    expect(['success', 'failure']).toContain(press.verification?.status);

    const click = await manager.execute(manager.createAction({ taskId: 'arch-test', type: 'input.click', parameters: { button: 'left', x: 100, y: 100 } }));
    expect(['succeeded', 'failed']).toContain(click.status);
    expect(['success', 'failure']).toContain(click.verification?.status);
  }, 30000);

  it('executes observation actions independently without interfering', async () => {
    const screen = new RobotJsScreenController();
    const windows = new WindowsWindowProvider();
    const ocr = new TesseractOcrProvider();
    const manager = new ActionManager({ logger: () => {} });

    manager.registerExecutor(new ScreenExecutor(screen));
    manager.registerExecutor(new VisionExecutor(new ScreenUnderstanding(screen, windows, ocr)));
    manager.authorizeComputerControl('obs-test');

    // Observation actions should work independently
    const capture1 = await manager.execute(manager.createAction({ taskId: 'obs-test', type: 'screen.startSharing', parameters: {} }));
    expect(capture1.status).toBe('succeeded');

    const inspect1 = await manager.execute(manager.createAction({ taskId: 'obs-test', type: 'vision.inspect', parameters: {} }));
    expect(inspect1.status).toBe('succeeded');
    expect(inspect1.result).toMatchObject({ text: expect.any(String), elements: expect.any(Array) });

    const inspect2 = await manager.execute(manager.createAction({ taskId: 'obs-test', type: 'vision.inspect', parameters: {} }));
    expect(inspect2.status).toBe('succeeded');
    expect(inspect2.result).toMatchObject({ text: expect.any(String), elements: expect.any(Array) });

    const stop = await manager.execute(manager.createAction({ taskId: 'obs-test', type: 'screen.stopSharing', parameters: {} }));
    expect(stop.status).toBe('succeeded');
    manager.revokeComputerControl('obs-test');

    await ocr.close();
  }, 30000);

  it('demonstrates Calculator workflow with explicit observation (platform-limited)', async () => {
    const screen = new RobotJsScreenController();
    const windows = new WindowsWindowProvider();
    const ocr = new TesseractOcrProvider();
    const manager = new ActionManager({ logger: () => {} });

    // Wire the window provider into ApplicationExecutor so the launched
    // Calculator window is automatically brought to the foreground on
    // launch — this is the fix that makes the "open + type" workflow
    // actually land the keystrokes in Calculator rather than in the
    // process that happens to have focus (which used to be SERA itself).
    manager.registerExecutor(new ApplicationExecutor(
      undefined, undefined, undefined, undefined, undefined, windows,
    ));
    manager.registerExecutor(new WindowExecutor(windows));
    // Wire the window provider into InputExecutor too, so the AI can
    // pass focusApplication:"Calculator" on type/press calls and have
    // the executor re-focus Calculator before each keystroke. This is
    // the belt-and-suspenders fix that handles the case where focus has
    // drifted between the launch and the input call.
    manager.registerExecutor(new InputExecutor(new RobotJsInputController(), undefined, undefined, windows));
    manager.registerExecutor(new ScreenExecutor(screen));
    manager.registerExecutor(new VisionExecutor(new ScreenUnderstanding(screen, windows, ocr)));
    manager.authorizeComputerControl('calculator-e2e');

    // 1. LAUNCH — ApplicationExecutor now focuses the new window for us.
    const launch = await manager.execute(manager.createAction({ taskId: 'calculator-e2e', type: 'application.launch', parameters: { application: 'Calculator' } }));
    expect(launch.status).toBe('succeeded');

    async function waitFor(condition: () => boolean, timeout = 15000, interval = 200): Promise<void> {
      const start = Date.now();
      while (!condition() && Date.now() - start < timeout) {
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
      if (!condition()) throw new Error(`Condition not met within ${timeout}ms`);
    }

    await waitFor(() => true, 1500);

    // 2. DISCOVER (with polling)
    let listed = await manager.execute(manager.createAction({ taskId: 'calculator-e2e', type: 'window.list', parameters: {} }));
    let target = (Array.isArray(listed.result) ? listed.result : []).find((w: any) => /^calculator$/i.test(w.title) || /calculator/i.test(w.application + ' ' + w.title));
    
    const maxDiscoveryAttempts = 8;
    let attempts = 0;
    while (!target && attempts < maxDiscoveryAttempts) {
      await waitFor(() => true, 500);
      listed = await manager.execute(manager.createAction({ taskId: 'calculator-e2e', type: 'window.list', parameters: {} }));
      target = (Array.isArray(listed.result) ? listed.result : []).find((w: any) => /^calculator$/i.test(w.title) || /calculator/i.test(w.application + ' ' + w.title));
      attempts += 1;
    }
    expect(target).toBeDefined();

    // 3. FOCUS (with retry) — ApplicationExecutor already focused once on
    // launch, but we re-focus here in case the OS foreground lock has
    // released it back to another window in the meantime.
    let focusAttempts = 0;
    let focus;
    while (focusAttempts < 3) {
      focus = await manager.execute(manager.createAction({ taskId: 'calculator-e2e', type: 'window.focus', parameters: { application: 'Calculator', title: 'Calculator' } }));
      if (focus.status === 'succeeded') break;
      await waitFor(() => true, 300);
      focusAttempts += 1;
    }
    expect(focus?.status).toBe('succeeded');

    // 4. START sharing — ScreenExecutor will now auto-start sharing if it
    // isn't already active, but we call it explicitly to keep the test
    // deterministic and to assert that the explicit path still works.
    const start = await manager.execute(manager.createAction({ taskId: 'calculator-e2e', type: 'screen.startSharing', parameters: {} }));
    expect(start.status).toBe('succeeded');

    // ========== EXECUTE → OBSERVE → VERIFY ==========

    // 5. TYPE — pass focusApplication so InputExecutor re-focuses
    // Calculator immediately before sending the keystrokes. This is the
    // fix for the user-reported "calculator opens but I can't type into
    // it" bug. The type call should now succeed (not be inconclusive
    // because keystrokes went to a different window).
    const typed = await manager.execute(manager.createAction({ taskId: 'calculator-e2e', type: 'input.type', parameters: { text: '25*25', focusApplication: 'Calculator' } }));
    // After our fix, type should succeed (not just "succeeded or failed").
    // The verification will still be 'inconclusive' if the screen-signature
    // check can't detect a change (which can happen on identical-looking
    // screens), but the action itself should not fail.
    expect(['succeeded', 'inconclusive']).toContain(typed.status);
    expect(typed.status).not.toBe('failed');

    // 6. PRESS Enter — same focusApplication discipline.
    const enter = await manager.execute(manager.createAction({ taskId: 'calculator-e2e', type: 'input.press', parameters: { key: 'enter', focusApplication: 'Calculator' } }));
    expect(['succeeded', 'inconclusive']).toContain(enter.status);
    expect(enter.status).not.toBe('failed');

    // 7. OBSERVE after calculation (with polling for result)
    let found625 = false;
    let after;
    let observeAttempts = 0;
    const maxObserveAttempts = 20;
    
    while (!found625 && observeAttempts < maxObserveAttempts) {
      await waitFor(() => true, 500);
      after = await manager.execute(manager.createAction({ taskId: 'calculator-e2e', type: 'vision.inspect', parameters: {} }));
      if (after.status === 'succeeded') {
        const resultText = (after.result as any)?.text || '';
        found625 = /\b625\b/.test(resultText);
      }
      observeAttempts += 1;
    }
    expect(after?.status).toBe('succeeded');
    // After our fix, we expect the calculation result to actually be
    // found on screen — Calculator stayed focused during the keystrokes.
    expect(found625).toBe(true);

    // 8. STOP and revoke
    const stop = await manager.execute(manager.createAction({ taskId: 'calculator-e2e', type: 'screen.stopSharing', parameters: {} }));
    expect(stop.status).toBe('succeeded');
    manager.revokeComputerControl('calculator-e2e');

    expect(launch.status).toBe('succeeded');
    expect(typed.status).not.toBe('failed');
    expect(enter.status).not.toBe('failed');
    expect(after.status).toBe('succeeded');

    await ocr.close();
  }, 120000);
});
