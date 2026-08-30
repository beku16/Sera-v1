/**
 * v1.7.0 — ScreenVisionRegistry unit tests.
 *
 * Pins every rule of the browser screen-vision server core:
 * forwarding vs buffering, one-shot semantics, pause honesty, stale
 * refresh at question time, session-ready injection order, flood/size
 * guards, reconnect grace, and the local-mode hint.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import {
  ScreenVisionRegistry,
  SCREEN_VISION_LIMITS,
  looksScreenRelated,
  normalizeFrameData,
  type ScreenVisionFrame,
  type ScreenVisionSessionHook,
} from '../server/screenVision';

const AUTH = 'auth-test-1234';

/** Well-formed base64 frame (~96 decoded bytes, passes validation). */
function frameData(size = 128): string {
  return 'A'.repeat(size);
}

function makeHook(overrides: Partial<ScreenVisionSessionHook> = {}): ScreenVisionSessionHook {
  return {
    sendMedia: vi.fn((_frame: ScreenVisionFrame) => true),
    injectContext: vi.fn(
      (_content: Parameters<NonNullable<ScreenVisionSessionHook['injectContext']>>[0]) => true,
    ),
    isActive: () => true,
    ...overrides,
  };
}

function sendMediaMock(hook: ScreenVisionSessionHook): Mock<(frame: ScreenVisionFrame) => boolean> {
  return hook.sendMedia as Mock<(frame: ScreenVisionFrame) => boolean>;
}

function injectMock(hook: ScreenVisionSessionHook): Mock<ScreenVisionSessionHook['injectContext']> {
  return hook.injectContext as Mock<ScreenVisionSessionHook['injectContext']>;
}

describe('looksScreenRelated', () => {
  it('matches the spec questions', () => {
    for (const text of [
      'What is on my screen?',
      'What website am I on?',
      'Do you see any errors?',
      'Explain this code.',
      'Summarize this page.',
      'Read the visible text.',
      'How is this thumbnail?',
      'Analyze my YouTube analytics.',
      'watch this',
    ]) {
      expect(looksScreenRelated(text)).toBe(true);
    }
  });

  it('does not match unrelated chatter', () => {
    expect(looksScreenRelated('what time is it')).toBe(false);
    expect(looksScreenRelated('tell me a joke')).toBe(false);
    expect(looksScreenRelated('')).toBe(false);
  });
});

describe('normalizeFrameData', () => {
  it('accepts plain base64 and strips data-URL prefixes', () => {
    expect(normalizeFrameData(frameData())).toBe(frameData());
    expect(normalizeFrameData(`data:image/jpeg;base64,${frameData()}`)).toBe(frameData());
  });

  it('rejects junk', () => {
    expect(normalizeFrameData(undefined)).toBeNull();
    expect(normalizeFrameData('short')).toBeNull();
    expect(normalizeFrameData('not!base64!!' + 'A'.repeat(64))).toBeNull();
    expect(normalizeFrameData('A'.repeat(64) + '!!')).toBeNull();
    expect(normalizeFrameData('A'.repeat(SCREEN_VISION_LIMITS.maxBase64Chars + 4))).toBeNull();
  });
});

describe('ScreenVisionRegistry', () => {
  let registry: ScreenVisionRegistry;
  let notify: Mock<(event: Record<string, unknown>) => void>;
  let clockMs: number;

  beforeEach(() => {
    clockMs = 1_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(clockMs);
    notify = vi.fn<(event: Record<string, unknown>) => void>();
    registry = new ScreenVisionRegistry({ now: () => clockMs, dropGraceMs: 10_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = (ms: number) => {
    clockMs += ms;
    vi.setSystemTime(clockMs);
    vi.advanceTimersByTime(ms);
  };

  const register = (visionMode = true) =>
    registry.registerChannel(AUTH, { visionMode, source: 'monitor', intervalMs: 2500, notify });

  describe('channel lifecycle', () => {
    it('registers and notifies the client', () => {
      const snapshot = register();
      expect(snapshot.active).toBe(true);
      expect(snapshot.visionMode).toBe(true);
      expect(snapshot.source).toBe('monitor');
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'screen_channel_state', active: true, streaming: false }),
      );
    });

    it('stop tells the live session it can no longer see the screen', () => {
      register();
      const hook = makeHook();
      registry.registerSession(AUTH, hook);
      notify.mockClear();

      expect(registry.markChannelStopped(AUTH, 'user_stop')).toBe(true);
      expect(injectMock(hook)).toHaveBeenCalledWith(
        expect.objectContaining({
          turns: [expect.objectContaining({ parts: [expect.objectContaining({ text: expect.stringContaining('Screen share stopped') })] })],
          turnComplete: false,
        }),
      );
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ active: false, reason: 'user_stop' }));
      expect(registry.getChannelSnapshot(AUTH)).toBeNull();
    });

    it('dropChannel honors a reconnect within the grace period', () => {
      register();
      expect(registry.dropChannel(AUTH, notify)).toBe(true);
      advance(5_000);
      // Still alive during grace…
      registry.registerChannel(AUTH, { visionMode: true, notify });
      advance(20_000);
      // The drop timer was cancelled by the re-register.
      expect(registry.getChannelSnapshot(AUTH)?.active).toBe(true);
    });

    it('dropChannel finalizes after the grace period and tells the session', () => {
      register();
      const hook = makeHook();
      registry.registerSession(AUTH, hook);

      registry.dropChannel(AUTH, notify);
      advance(11_000);
      expect(registry.getChannelSnapshot(AUTH)).toBeNull();
      expect(injectMock(hook)).toHaveBeenCalledWith(
        expect.objectContaining({
          turns: [expect.objectContaining({ parts: [expect.objectContaining({ text: expect.stringContaining('no longer see') })] })],
        }),
      );
    });

    it('finalizeDropsNow clears everything immediately', () => {
      register();
      registry.dropChannel(AUTH, notify);
      registry.finalizeDropsNow();
      expect(registry.getChannelSnapshot(AUTH)).toBeNull();
    });

    it('evicts the oldest channel beyond the cap', () => {
      const keys = Array.from({ length: SCREEN_VISION_LIMITS.maxChannels + 1 }, (_, i) => `auth-${i}`);
      for (const key of keys) {
        advance(1000);
        registry.registerChannel(key, { visionMode: true, notify });
      }
      expect(registry.status().channels).toBe(SCREEN_VISION_LIMITS.maxChannels);
      expect(registry.getChannelSnapshot('auth-0')).toBeNull(); // oldest evicted
      expect(registry.getChannelSnapshot(`auth-${keys.length - 1}`)).not.toBeNull();
    });
  });

  describe('frame ingest', () => {
    it('buffers when no session is live (share survives rollovers)', () => {
      register();
      const result = registry.ingestFrame(AUTH, {
        data: frameData(),
        width: 1024,
        height: 640,
        bytes: 96,
      });
      expect(result).toBe('buffered');
      expect(registry.getChannelSnapshot(AUTH)?.framesBuffered).toBe(1);
    });

    it('forwards to a live session through the media channel', () => {
      register();
      const hook = makeHook();
      registry.registerSession(AUTH, hook);

      const result = registry.ingestFrame(AUTH, { data: frameData(), width: 1024, height: 640, bytes: 96 });
      expect(result).toBe('forwarded');
      expect(sendMediaMock(hook)).toHaveBeenCalledWith(
        expect.objectContaining({ data: frameData(), mimeType: 'image/jpeg', width: 1024, height: 640 }),
      );
      expect(registry.getChannelSnapshot(AUTH)?.framesForwarded).toBe(1);
    });

    it('drops continuous frames when vision mode is off (privacy)', () => {
      register(false);
      const hook = makeHook();
      registry.registerSession(AUTH, hook);

      expect(registry.ingestFrame(AUTH, { data: frameData(), width: 800, height: 600 })).toBe('dropped-mode-off');
      expect(sendMediaMock(hook)).not.toHaveBeenCalled();
    });

    it('one-shot frames bypass the vision-mode switch', () => {
      register(false);
      const hook = makeHook();
      registry.registerSession(AUTH, hook);

      expect(registry.ingestFrame(AUTH, { data: frameData(), width: 800, height: 600 }, { oneShot: true })).toBe('forwarded');
      expect(sendMediaMock(hook)).toHaveBeenCalledTimes(1);
    });

    it('one-shot frames buffer for the next session when none is live', () => {
      register(false);
      expect(registry.ingestFrame(AUTH, { data: frameData(), width: 800, height: 600 }, { oneShot: true })).toBe('buffered');
    });

    it('paused shares buffer frames instead of forwarding', () => {
      register();
      const hook = makeHook();
      registry.registerSession(AUTH, hook);
      registry.setPaused(AUTH, true);

      expect(registry.ingestFrame(AUTH, { data: frameData(), width: 800, height: 600 })).toBe('dropped-paused');
      expect(sendMediaMock(hook)).not.toHaveBeenCalled();
    });

    it('flood-drops frames faster than the guard interval', () => {
      register();
      registry.ingestFrame(AUTH, { data: frameData(), width: 800, height: 600 });
      advance(50);
      expect(registry.ingestFrame(AUTH, { data: frameData(), width: 800, height: 600 })).toBe('dropped-flood');
      advance(SCREEN_VISION_LIMITS.minFrameIntervalMs + 10);
      expect(registry.ingestFrame(AUTH, { data: frameData(), width: 800, height: 600 })).toBe('buffered');
    });

    it('drops oversized frames', () => {
      register();
      const huge = 'A'.repeat(300_000); // ~225KB decoded > 220KB cap
      expect(registry.ingestFrame(AUTH, { data: huge, width: 800, height: 600 })).toBe('dropped-oversize');
    });

    it('drops invalid payloads without state corruption', () => {
      register();
      expect(registry.ingestFrame(AUTH, { data: 'zzz', width: 800, height: 600 })).toBe('dropped-invalid');
      expect(registry.ingestFrame(AUTH, { data: frameData(), width: 0, height: 600 })).toBe('dropped-invalid');
      expect(registry.ingestFrame(AUTH, { data: frameData(), width: 800, height: 99_999 })).toBe('dropped-invalid');
    });

    it('unknown channels are rejected cleanly', () => {
      expect(registry.ingestFrame('auth-unknown', { data: frameData(), width: 800, height: 600 })).toBe('dropped-no-channel');
    });
  });

  describe('session-ready injection (the "current screen" guarantee)', () => {
    it('injects the buffered frame + label BEFORE the first question', () => {
      register();
      registry.ingestFrame(AUTH, { data: frameData(), width: 1024, height: 640, bytes: 96 });

      const hook = makeHook();
      registry.registerSession(AUTH, hook);
      const outcome = registry.onSessionReady(AUTH);

      expect(outcome.injected).toBe(true);
      expect(injectMock(hook)).toHaveBeenCalledWith(
        expect.objectContaining({
          turns: [
            expect.objectContaining({
              role: 'user',
              parts: [
                expect.objectContaining({ inlineData: expect.objectContaining({ mimeType: 'image/jpeg', data: frameData() }) }),
                expect.objectContaining({ text: expect.stringContaining('current screen') }),
              ],
            }),
          ],
          turnComplete: false,
        }),
      );
    });

    it('injects a pending one-shot even with vision mode off', () => {
      register(false);
      registry.ingestFrame(AUTH, { data: frameData(), width: 800, height: 600 }, { oneShot: true });

      const hook = makeHook();
      registry.registerSession(AUTH, hook);
      const outcome = registry.onSessionReady(AUTH);
      expect(outcome.injected).toBe(true);
      expect(outcome.reason).toBe('current-frame');
    });

    it('tells the session the share is paused instead of showing a stale frame', () => {
      register();
      registry.setPaused(AUTH, true);
      const hook = makeHook();
      registry.registerSession(AUTH, hook);

      const outcome = registry.onSessionReady(AUTH);
      expect(outcome.injected).toBe(true);
      expect(outcome.reason).toBe('paused-note');
      expect(injectMock(hook)).toHaveBeenCalledWith(
        expect.objectContaining({
          turns: [expect.objectContaining({ parts: [expect.objectContaining({ text: expect.stringContaining('PAUSED') })] })],
        }),
      );
    });

    it('no-op when the user is not sharing', () => {
      const hook = makeHook();
      registry.registerSession(AUTH, hook);
      expect(registry.onSessionReady(AUTH)).toEqual({ injected: false, reason: 'not-sharing' });
    });

    it('does not inject stale buffered frames (older than maxFrameAgeMs)', () => {
      register();
      registry.ingestFrame(AUTH, { data: frameData(), width: 800, height: 600 });
      advance(SCREEN_VISION_LIMITS.maxFrameAgeMs + 1000);

      const hook = makeHook();
      registry.registerSession(AUTH, hook);
      expect(registry.onSessionReady(AUTH).reason).toBe('no-fresh-frame');
    });
  });

  describe('question-time refresh (onTextArrived)', () => {
    it('refreshes a stale view when a screen question arrives', () => {
      register();
      const hook = makeHook();
      registry.registerSession(AUTH, hook);
      registry.ingestFrame(AUTH, { data: frameData(), width: 1024, height: 640 });
      advance(SCREEN_VISION_LIMITS.staleFrameMs + 5000); // last forward is old

      const outcome = registry.onTextArrived(AUTH, 'What is on my screen right now?');
      expect(outcome.injected).toBe(true);
      expect(outcome.reason).toBe('stale-refresh');
      expect(injectMock(hook)).toHaveBeenCalled();
    });

    it('does not spam when the view is fresh', () => {
      register();
      const hook = makeHook();
      registry.registerSession(AUTH, hook);
      registry.ingestFrame(AUTH, { data: frameData(), width: 1024, height: 640 });

      const outcome = registry.onTextArrived(AUTH, 'What is on my screen?');
      expect(outcome.injected).toBe(false);
      expect(outcome.reason).toBe('fresh-enough');
    });

    it('ignores non-screen questions entirely', () => {
      register();
      const hook = makeHook();
      registry.registerSession(AUTH, hook);
      registry.ingestFrame(AUTH, { data: frameData(), width: 1024, height: 640 });

      expect(registry.onTextArrived(AUTH, 'tell me about quantum computing').reason).toBe('not-screen-related');
      expect(injectMock(hook)).not.toHaveBeenCalled();
    });

    it('reminds the model the share is paused on screen questions', () => {
      register();
      registry.setPaused(AUTH, true);
      const hook = makeHook();
      registry.registerSession(AUTH, hook);

      const outcome = registry.onTextArrived(AUTH, 'what do you see on my screen');
      expect(outcome.reason).toBe('paused-note');
      expect(injectMock(hook)).toHaveBeenCalledWith(
        expect.objectContaining({
          turns: [expect.objectContaining({ parts: [expect.objectContaining({ text: expect.stringContaining('PAUSED') })] })],
        }),
      );
    });
  });

  describe('session bookkeeping', () => {
    it('streaming flag flips true only when vision is on, unpaused, session live', () => {
      register();
      notify.mockClear();
      const hook = makeHook();
      registry.registerSession(AUTH, hook);

      // registerSession triggers a state push with streaming=true
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ streaming: true }));

      registry.setPaused(AUTH, true);
      expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ streaming: false }));

      registry.setPaused(AUTH, false);
      expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ streaming: true }));
    });

    it('unregisterSession only removes the matching hook', () => {
      register();
      const hookA = makeHook();
      const hookB = makeHook();
      registry.registerSession(AUTH, hookA);
      registry.unregisterSession(AUTH, hookB);
      expect(registry.hasActiveSession(AUTH)).toBe(true);

      registry.unregisterSession(AUTH, hookA);
      expect(registry.hasActiveSession(AUTH)).toBe(false);
    });

    it('dead sessions (isActive false) never receive frames', () => {
      register();
      const hook = makeHook({ isActive: () => false });
      registry.registerSession(AUTH, hook);
      expect(registry.ingestFrame(AUTH, { data: frameData(), width: 800, height: 600 })).toBe('buffered');
      expect(sendMediaMock(hook)).not.toHaveBeenCalled();
    });
  });

  describe('local mode honesty', () => {
    it('hints only on screen-related questions while sharing', () => {
      expect(registry.localModeScreenHint(AUTH, 'what is on my screen')).toBeNull(); // not sharing

      register();
      expect(registry.localModeScreenHint(AUTH, 'what is on my screen?')).toContain('Online Mode');
      expect(registry.localModeScreenHint(AUTH, 'tell me a joke')).toBeNull();
    });
  });

  describe('status aggregation', () => {
    it('counts channels, sessions, and frame outcomes', () => {
      register();
      registry.ingestFrame(AUTH, { data: frameData(), width: 800, height: 600 }); // buffered
      registry.registerSession(AUTH, makeHook());
      advance(SCREEN_VISION_LIMITS.minFrameIntervalMs + 100);
      registry.ingestFrame(AUTH, { data: frameData(), width: 800, height: 600 }); // forwarded

      const status = registry.status();
      expect(status.channels).toBe(1);
      expect(status.activeSessions).toBe(1);
      expect(status.framesForwarded).toBe(1);
      expect(status.framesBuffered).toBe(1);
    });
  });
});
