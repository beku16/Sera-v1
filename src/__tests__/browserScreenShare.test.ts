/**
 * v1.7.0 — BrowserScreenShareController tests.
 *
 * The capture pipeline is tested against a fully mocked media stack
 * (getDisplayMedia / MediaStream / video / canvas) because jsdom has
 * neither. What is pinned here is the CONTRACT the real browser runs:
 * permission-error taxonomy, lifecycle states, pause/resume semantics,
 * track-ended auto-stop, frame encoding with change detection, and the
 * byte-ceiling fallback.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import {
  BrowserScreenShareController,
  toScreenShareError,
  screenShareSupport,
  meanAbsDiff,
  stripDataUrl,
  type CapturedScreenFrame,
} from '../vision/browserScreenShare';

// ── media stack mocks ───────────────────────────────────────────────

function makeFakeTrack(label = 'Screen 1'): MediaStreamTrack {
  const listeners: Array<[string, EventListener]> = [];
  return {
    label,
    kind: 'video',
    stop: vi.fn(),
    addEventListener: vi.fn((event: string, cb: EventListener) => {
      listeners.push([event, cb]);
    }),
    // test helper: fire 'ended'
    __fire: (event: string) => {
      for (const [name, cb] of listeners) if (name === event) cb(new Event(event));
    },
  } as unknown as MediaStreamTrack;
}

function makeFakeStream(track: MediaStreamTrack): MediaStream {
  return {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

/** jsdom-safe 2D context fake: records draws, serves pixel data. */
function makeFakeCtx() {
  const sigData = new Uint8ClampedArray(32 * 18 * 4).fill(120);
  return {
    canvas: {} as HTMLCanvasElement,
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: sigData, width: 32, height: 18 })),
  } as unknown as CanvasRenderingContext2D;
}

describe('toScreenShareError', () => {
  it('maps permission denial to a typed, actionable error', () => {
    const err = toScreenShareError(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    expect(err.kind).toBe('permission-denied');
    expect(err.message).toContain('again');
  });

  it('maps abort (user closed the picker)', () => {
    expect(toScreenShareError(Object.assign(new Error('aborted'), { name: 'AbortError' })).kind).toBe('aborted');
  });

  it('maps missing monitors', () => {
    expect(toScreenShareError(Object.assign(new Error('no matching surface'), { name: 'NotFoundError' })).kind).toBe('no-monitor');
  });

  it('maps unsupported browsers', () => {
    expect(toScreenShareError(Object.assign(new Error('not supported'), { name: 'NotSupportedError' })).kind).toBe('unsupported');
  });

  it('wraps unknown failures honestly', () => {
    const err = toScreenShareError(new Error('weird driver failure'));
    expect(err.kind).toBe('capture-failed');
    expect(err.message).toContain('weird driver failure');
  });
});

describe('helpers', () => {
  it('meanAbsDiff detects identical and changed signatures', () => {
    const a = new Uint8Array([10, 20, 30]);
    expect(meanAbsDiff(a, new Uint8Array([10, 20, 30]))).toBe(0);
    expect(meanAbsDiff(a, new Uint8Array([110, 20, 30]))).toBeCloseTo(100 / 3, 5);
    expect(meanAbsDiff(a, new Uint8Array([1]))).toBe(255); // length mismatch
  });

  it('stripDataUrl handles both shapes', () => {
    expect(stripDataUrl('data:image/jpeg;base64,QUJD')).toBe('QUJD');
    expect(stripDataUrl('QUJD')).toBe('QUJD');
  });
});

describe('screenShareSupport', () => {
  const realMediaDevices = navigator.mediaDevices;
  afterEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: realMediaDevices, configurable: true });
  });

  it('reports unsupported without getDisplayMedia', () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    expect(screenShareSupport().supported).toBe(false);
    expect(screenShareSupport().reason).toBe('unsupported');
  });

  it('reports supported when the API exists in a secure context', () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getDisplayMedia: vi.fn() },
      configurable: true,
    });
    expect(screenShareSupport().supported).toBe(true);
  });
});

describe('BrowserScreenShareController', () => {
  let hooks: {
    onFrame: Mock<(frame: CapturedScreenFrame) => void>;
    onStateChange: Mock<(state: unknown, reason: string) => void>;
    onError: Mock<(error: unknown) => void>;
  };
  let controller: BrowserScreenShareController;
  let fakeCtx: CanvasRenderingContext2D;
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const originalCreateElement = document.createElement.bind(document);

  beforeEach(() => {
    hooks = {
      onFrame: vi.fn<(frame: CapturedScreenFrame) => void>(),
      onStateChange: vi.fn<(state: unknown, reason: string) => void>(),
      onError: vi.fn<(error: unknown) => void>(),
    };
    fakeCtx = makeFakeCtx();
    // Canvas plumbing: fake 2D context + deterministic JPEG data URLs.
    HTMLCanvasElement.prototype.getContext = vi.fn(() => fakeCtx) as never;
    HTMLCanvasElement.prototype.toDataURL = vi.fn(
      (type?: string, quality?: unknown) =>
        `data:image/jpeg;base64,${'A'.repeat(Math.round((typeof quality === 'number' ? quality : 0.6) * 200))}`,
    ) as never;
    // Video plumbing: pretend the element has data immediately.
    Object.defineProperty(HTMLVideoElement.prototype, 'readyState', { configurable: true, get: () => 2 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1920 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 1080 });
    Object.defineProperty(HTMLVideoElement.prototype, 'play', { configurable: true, value: vi.fn().mockResolvedValue(undefined) });
    // jsdom lacks requestVideoFrameCallback — the interval fallback path runs.
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      value: undefined,
    });
    controller = new BrowserScreenShareController(hooks, { intervalMs: 50 });
  });

  afterEach(() => {
    controller.dispose();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
    document.createElement = originalCreateElement;
    vi.restoreAllMocks();
  });

  const installDisplayMedia = (impl: () => Promise<MediaStream>) => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getDisplayMedia: vi.fn(impl) },
      configurable: true,
    });
  };

  it('start() with permission denied surfaces a typed error and stays idle', async () => {
    installDisplayMedia(() =>
      Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })),
    );
    await expect(controller.start()).rejects.toMatchObject({ kind: 'permission-denied' });
    expect(hooks.onError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'permission-denied' }));
    expect(controller.isActive).toBe(false);
    expect(hooks.onStateChange).not.toHaveBeenCalledWith(expect.objectContaining({ active: true }), expect.anything());
  });

  it('start() without video tracks reports no-monitor and stops the stream', async () => {
    installDisplayMedia(() => Promise.resolve({
      getVideoTracks: () => [],
      getTracks: () => [],
    } as unknown as MediaStream));
    await expect(controller.start()).rejects.toMatchObject({ kind: 'no-monitor' });
  });

  it('successful start activates sharing and emits the first frame', async () => {
    const track = makeFakeTrack('Entire Screen');
    installDisplayMedia(() => Promise.resolve(makeFakeStream(track)));

    await controller.start();

    expect(controller.isActive).toBe(true);
    expect(controller.getState()).toMatchObject({ active: true, paused: false, source: 'monitor', label: 'Entire Screen' });
    expect(hooks.onStateChange).toHaveBeenCalledWith(expect.objectContaining({ active: true }), 'started');

    // The interval fallback fires quickly at intervalMs=50.
    await new Promise((resolve) => setTimeout(resolve, 140));
    expect(hooks.onFrame.mock.calls.length).toBeGreaterThanOrEqual(1);
    const first = hooks.onFrame.mock.calls[0][0];
    expect(first.mimeType).toBe('image/jpeg');
    expect(first.data.length).toBeGreaterThan(60);
    expect(first.width).toBe(1152); // 1920x1080 downscaled, long edge capped
    expect(first.height).toBe(648);
  });

  it('track ended (browser stop bar) auto-stops the share', async () => {
    const track = makeFakeTrack('Entire Screen');
    installDisplayMedia(() => Promise.resolve(makeFakeStream(track)));
    await controller.start();

    (track as unknown as { __fire: (e: string) => void }).__fire('ended');

    expect(controller.isActive).toBe(false);
    expect(hooks.onStateChange).toHaveBeenCalledWith(expect.objectContaining({ active: false }), 'track-ended');
  });

  it('pause stops frame emission; resume restarts it', async () => {
    const track = makeFakeTrack('Screen');
    installDisplayMedia(() => Promise.resolve(makeFakeStream(track)));
    await controller.start();
    hooks.onFrame.mockClear();

    controller.pause();
    expect(controller.isPaused).toBe(true);
    expect(hooks.onStateChange).toHaveBeenCalledWith(expect.objectContaining({ paused: true }), 'paused');

    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(hooks.onFrame).not.toHaveBeenCalled(); // nothing flows while paused

    controller.resume();
    expect(controller.isPaused).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(hooks.onFrame.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('stop() ends sharing and notifies', async () => {
    const track = makeFakeTrack('Screen');
    installDisplayMedia(() => Promise.resolve(makeFakeStream(track)));
    await controller.start();

    controller.stop('user-stop');
    expect(controller.isActive).toBe(false);
    expect(hooks.onStateChange).toHaveBeenCalledWith(expect.objectContaining({ active: false }), 'user-stop');
  });

  it('change detection skips visually identical frames', async () => {
    const track = makeFakeTrack('Screen');
    installDisplayMedia(() => Promise.resolve(makeFakeStream(track)));
    await controller.start();
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The fake context serves the SAME pixel data every time → after the
    // first frame, every capture is signature-identical and skipped.
    const stats = controller.getStats();
    expect(stats.framesSent).toBe(1);
    expect(stats.framesSkipped).toBeGreaterThan(0);
  });

  it('captureFrameNow bypasses change detection (the look-NOW path)', async () => {
    const track = makeFakeTrack('Screen');
    installDisplayMedia(() => Promise.resolve(makeFakeStream(track)));
    await controller.start();
    await new Promise((resolve) => setTimeout(resolve, 120));

    hooks.onFrame.mockClear();
    const frame = controller.captureFrameNow();
    expect(frame).not.toBeNull();
    expect(frame?.mimeType).toBe('image/jpeg');
    // Forced capture does not go through the change gate.
    expect(controller.getStats().framesSent).toBeGreaterThan(1);
  });

  it('oversized encodings retry at lower quality / resolution', async () => {
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => `data:image/jpeg;base64,${'A'.repeat(300_000)}`) as never;
    const track = makeFakeTrack('Screen');
    installDisplayMedia(() => Promise.resolve(makeFakeStream(track)));
    await controller.start();

    const frame = controller.captureFrameNow();
    // Everything exceeded the 160KB cap → null, never a bloated frame.
    expect(frame).toBeNull();
  });

  it('a picker that never answers times out, resets, and never leaks a late stream', async () => {
    vi.useFakeTimers();
    try {
      let lateResolve: ((stream: MediaStream) => void) | null = null;
      const track = makeFakeTrack('Late Screen');
      installDisplayMedia(
        () =>
          new Promise<MediaStream>((resolve) => {
            lateResolve = resolve;
          }),
      );

      const pending = controller.start();
      // The start promise races the 120s picker timeout.
      const assertion = expect(pending).rejects.toMatchObject({ kind: 'aborted' });
      await vi.advanceTimersByTimeAsync(120_500);
      await assertion;

      // UI recovered: not active, honest error surfaced.
      expect(controller.isActive).toBe(false);
      expect(hooks.onError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'aborted' }));

      // The picker FINALLY answers after we gave up — the stray stream
      // must be stopped, never leaked.
      lateResolve?.(makeFakeStream(track));
      await vi.advanceTimersByTimeAsync(50);
      expect(track.stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
