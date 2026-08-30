/**
 * v1.8.0 — Screen OCR + Screen Memory bridge unit tests.
 *
 * Pins every rule of the two new Screen Vision capabilities:
 *
 *  OCR (ultra-precise reading):
 *   - distillOcrText cleanup rules (whitespace, junk lines, dedup, cap)
 *   - token Jaccard similarity / same-screen detection
 *   - registry schedules OCR on accepted frames (interval-gated, single-flight)
 *   - fresh OCR text rides along with injected frames (exact reading)
 *   - stale OCR text is NOT injected
 *   - engine failures are swallowed (frame flow never breaks)
 *   - local-mode hint carries the visible text (text-only vision)
 *
 *  SCREEN MEMORY (remember what was on my screen):
 *   - question detection (recall cue + screen noun)
 *   - digest log: dedup, ordering, bounds, formatting
 *   - "what was on my screen earlier?" answered DURING and AFTER the share
 *   - injection throttling
 *   - share-ended summary handed to the persistence callback
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import {
  ScreenVisionRegistry,
  type ScreenVisionFrame,
  type ScreenVisionSessionHook,
  type ScreenShareEndedSummary,
} from '../server/screenVision';
import {
  distillOcrText,
  ocrTokenJaccard,
  isSameScreenText,
  clampOcrIntervalMs,
  SCREEN_OCR_LIMITS,
  type ScreenOcrEngineLike,
} from '../server/screenOcr';
import {
  looksLikeScreenMemoryQuestion,
  ScreenMemoryLog,
  formatShareEndedFact,
} from '../server/screenMemory';

const AUTH = 'auth-ocr-memory';

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

function injectMock(hook: ScreenVisionSessionHook): Mock<ScreenVisionSessionHook['injectContext']> {
  return hook.injectContext as Mock<ScreenVisionSessionHook['injectContext']>;
}

/** Fake OCR engine with scriptable results. */
function fakeOcrEngine(script: {
  text?: string;
  reject?: Error;
}): { engine: ScreenOcrEngineLike; extract: Mock } {
  const extract = vi.fn(async () => {
    if (script.reject) throw script.reject;
    return script.text ? { text: script.text } : null;
  });
  return { engine: { extract }, extract };
}

/** Flush pending promise callbacks under fake timers. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

const SCREEN_TEXT =
  'GitHub\nPull request #42: Add screen sharing\nsrc/server/screenVision.ts\n+312 -4 lines changed\nAll checks passed';

describe('distillOcrText', () => {
  it('collapses whitespace and keeps real content lines', () => {
    const raw = '  Hello   World  \n\nfoo bar\n\n';
    expect(distillOcrText(raw)).toBe('Hello World\nfoo bar');
  });

  it('drops junk lines (too short, pure symbols, duplicates)', () => {
    const raw = 'a\n!!@#$\nReal Line\nReal Line\nAnother Line\n1234';
    const distilled = distillOcrText(raw);
    expect(distilled).toContain('Real Line');
    expect(distilled).toContain('Another Line');
    expect(distilled).toContain('1234');
    expect(distilled).not.toContain('!!@#$');
    expect(distilled.split('\n').filter((l) => l === 'Real Line')).toHaveLength(1);
  });

  it('caps length keeping head and tail with a marker', () => {
    const raw = Array.from({ length: 500 }, (_, i) => `line number ${i} with padding text`).join('\n');
    const distilled = distillOcrText(raw, 400);
    expect(distilled.length).toBeLessThanOrEqual(430);
    expect(distilled).toContain('[…]');
    expect(distilled).toContain('line number 0');
  });

  it('returns empty for garbage input', () => {
    expect(distillOcrText('')).toBe('');
    expect(distillOcrText('!@#$ %^&*')).toBe('');
  });
});

describe('ocrTokenJaccard / isSameScreenText', () => {
  it('scores identical text as 1 and disjoint text as 0', () => {
    expect(ocrTokenJaccard(SCREEN_TEXT, SCREEN_TEXT)).toBe(1);
    expect(ocrTokenJaccard('alpha beta gamma', 'one two three')).toBe(0);
  });

  it('detects near-identical screens as the same', () => {
    const a = 'GitHub\nPull request #42: Add screen sharing\nAll checks passed';
    const b = 'GitHub\nPull request #42: Add screen sharing\nAll checks passed\n1 comment';
    expect(isSameScreenText(a, b)).toBe(true);
    expect(isSameScreenText(a, 'YouTube\nWatch history\nRecommended videos')).toBe(false);
  });
});

describe('looksLikeScreenMemoryQuestion', () => {
  it('matches past-screen questions', () => {
    for (const text of [
      'What was on my screen earlier?',
      'Remember the page I was showing you?',
      'What was that error before?',
      'Go back to that site I was looking at',
      'Recall the code I had open a minute ago',
      'What did my screen show before this?',
    ]) {
      expect(looksLikeScreenMemoryQuestion(text)).toBe(true);
    }
  });

  it('rejects ordinary chatter and present-tense questions', () => {
    for (const text of ['', 'hello there', 'what time is it', 'tell me a joke', 'what is on my screen']) {
      expect(looksLikeScreenMemoryQuestion(text)).toBe(false);
    }
  });
});

describe('ScreenMemoryLog', () => {
  let clockMs: number;
  beforeEach(() => {
    clockMs = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(clockMs);
  });
  afterEach(() => vi.useRealTimers());

  it('records distinct digests newest-last', () => {
    const log = new ScreenMemoryLog({ now: () => clockMs });
    log.record({ at: clockMs, source: 'browser', digest: 'YouTube — watch history and recommended videos list' });
    log.record({ at: clockMs + 60_000, source: 'browser', digest: 'GitHub pull request 42 add screen sharing files changed' });
    const entries = log.recent();
    expect(entries).toHaveLength(2);
    expect(entries[0].digest).toContain('YouTube');
    expect(entries[1].digest).toContain('GitHub');
  });

  it('dedupes near-identical screens (refresh, not append)', () => {
    const log = new ScreenMemoryLog({ now: () => clockMs });
    log.record({ at: clockMs, source: 'monitor', digest: 'GitHub pull request 42 add screen sharing all checks passed' });
    log.record({ at: clockMs + 5_000, source: 'monitor', digest: 'GitHub pull request 42 add screen sharing all checks passed 1 comment' });
    expect(log.size()).toBe(1);
    expect(log.recent()[0].at).toBe(clockMs + 5_000);
  });

  it('ignores too-short digests', () => {
    const log = new ScreenMemoryLog({ now: () => clockMs });
    log.record({ at: clockMs, source: 'monitor', digest: 'tiny' });
    expect(log.size()).toBe(0);
  });

  it('stays bounded and prunes by age', () => {
    const log = new ScreenMemoryLog({ now: () => clockMs, maxEntries: 3 });
    const distinctScreens = [
      'YouTube watch page with recommended videos sidebar',
      'GitHub repository main branch source file tree listing',
      'Amazon shopping cart with two items and checkout button',
      'Stack Overflow question about python async await syntax',
      'Figma design board with three frames and toolbar',
    ];
    distinctScreens.forEach((digest, i) => {
      log.record({ at: clockMs + i * 60_000, source: 'monitor', digest });
    });
    expect(log.size()).toBe(3);
  });

  it('formats context with timestamps and summaries', () => {
    const log = new ScreenMemoryLog({ now: () => clockMs });
    log.record({ at: clockMs, source: 'browser', digest: 'YouTube Analytics\nChannel dashboard\nViews 12,400' });
    const context = log.formatContext();
    expect(context).toContain('browser');
    expect(context).toContain('YouTube Analytics');
    expect(context).toMatch(/\d{2}:\d{2}/);
  });

  it('formats the share-ended fact with and without a digest', () => {
    expect(formatShareEndedFact('GitHub pull request 42 opened', clockMs, clockMs + 5 * 60_000, 'window')).toContain(
      'Last visible content: GitHub pull request 42 opened',
    );
    expect(formatShareEndedFact(null, clockMs, clockMs + 5 * 60_000, 'window')).toContain(
      'no readable text was on screen',
    );
  });
});

describe('ScreenVisionRegistry + OCR + memory', () => {
  let clockMs: number;
  let registry: ScreenVisionRegistry;
  let notify: Mock<(event: Record<string, unknown>) => void>;
  let onShareEnded: Mock<(summary: ScreenShareEndedSummary) => void>;
  let ocr: { engine: ScreenOcrEngineLike; extract: Mock };
  let hook: ScreenVisionSessionHook;

  function registerChannel(visionMode = true): void {
    registry.registerChannel(AUTH, { visionMode, source: 'monitor', notify });
  }

  function ingestFrame(at?: number): void {
    registry.ingestFrame(
      AUTH,
      { data: frameData(), width: 640, height: 480, bytes: 96, at: at ?? clockMs },
    );
  }

  beforeEach(() => {
    clockMs = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(clockMs);
    notify = vi.fn<(event: Record<string, unknown>) => void>();
    onShareEnded = vi.fn<(summary: ScreenShareEndedSummary) => void>();
    ocr = fakeOcrEngine({ text: SCREEN_TEXT });
    hook = makeHook();
    registry = new ScreenVisionRegistry({
      now: () => clockMs,
      dropGraceMs: 10_000,
      ocr: ocr.engine,
      ocrIntervalMs: 0,
      onShareEnded,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs OCR on accepted frames and records the digest in screen memory', async () => {
    registerChannel(true);
    ingestFrame();
    expect(ocr.extract).toHaveBeenCalledTimes(1);
    await flush();
    // Digest recorded for this user.
    expect(registry.screenMemory(AUTH).recent(10).some((e) => e.digest.includes('Pull request'))).toBe(true);
    // ocrChars telemetry reached the client.
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'screen_channel_state', ocrChars: SCREEN_TEXT.length }));
  });

  it('interval-gates OCR runs', async () => {
    registry = new ScreenVisionRegistry({
      now: () => clockMs,
      ocr: ocr.engine,
      ocrIntervalMs: 8_000,
    });
    registerChannel(true);
    ingestFrame();
    await flush();
    clockMs += 2_000;
    ingestFrame();
    expect(ocr.extract).toHaveBeenCalledTimes(1);
    clockMs += 7_000;
    ingestFrame();
    expect(ocr.extract).toHaveBeenCalledTimes(2);
  });

  it('never runs two extractions at once (single flight)', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const slowEngine: ScreenOcrEngineLike = {
      extract: vi.fn(() => slow.then(() => ({ text: SCREEN_TEXT }))),
    };
    registry = new ScreenVisionRegistry({ now: () => clockMs, ocr: slowEngine, ocrIntervalMs: 0 });
    registerChannel(true);
    ingestFrame();
    clockMs += 1_000;
    ingestFrame(); // would pass the interval gate, but one is in flight
    expect(slowEngine.extract).toHaveBeenCalledTimes(1);
    release();
    await flush();
    clockMs += 1_000;
    ingestFrame();
    expect(slowEngine.extract).toHaveBeenCalledTimes(2);
  });

  it('injects the OCR text next to the frame for ultra-precise reading', async () => {
    registerChannel(true);
    ingestFrame();
    await flush();
    registry.registerSession(AUTH, hook);
    const outcome = registry.onSessionReady(AUTH);
    expect(outcome.injected).toBe(true);
    const parts = injectMock(hook).mock.calls[0][0].turns[0].parts as Array<Record<string, unknown>>;
    expect(parts[0]).toHaveProperty('inlineData');
    const ocrPart = parts.find((p) => typeof p.text === 'string' && String(p.text).includes('OCR'));
    expect(ocrPart).toBeDefined();
    expect(String(ocrPart?.text)).toContain('Pull request #42');
  });

  it('does not inject stale OCR text', async () => {
    registerChannel(true);
    ingestFrame();
    await flush();
    clockMs += SCREEN_OCR_LIMITS.maxContextAgeMs + 1_000;
    registry.registerSession(AUTH, hook);
    registry.onSessionReady(AUTH);
    const parts = injectMock(hook).mock.calls[0][0].turns[0].parts as Array<Record<string, unknown>>;
    expect(parts.find((p) => typeof p.text === 'string' && String(p.text).includes('OCR'))).toBeUndefined();
  });

  it('swallows engine failures without breaking frame flow', async () => {
    const failing = fakeOcrEngine({ reject: new Error('tesseract died') });
    registry = new ScreenVisionRegistry({ now: () => clockMs, ocr: failing.engine, ocrIntervalMs: 0 });
    registerChannel(true);
    expect(() => ingestFrame()).not.toThrow();
    await flush();
    expect(registry.getChannelSnapshot(AUTH)?.framesForwarded).toBeDefined();
  });

  it('drops OCR results for channels that died mid-extraction', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const slowEngine: ScreenOcrEngineLike = {
      extract: vi.fn(() => slow.then(() => ({ text: SCREEN_TEXT }))),
    };
    registry = new ScreenVisionRegistry({ now: () => clockMs, ocr: slowEngine, ocrIntervalMs: 0 });
    registerChannel(true);
    ingestFrame();
    registry.markChannelStopped(AUTH, 'user_stop');
    release();
    await flush();
    // No memory was recorded for the dead channel.
    expect(registry.screenMemory(AUTH).size()).toBe(0);
  });

  it('answers "what was on my screen earlier?" AFTER the share stopped', async () => {
    registerChannel(true);
    ingestFrame();
    await flush();
    registry.registerSession(AUTH, hook);
    registry.markChannelStopped(AUTH, 'user_stop');
    const outcome = registry.onTextArrived(AUTH, 'What was on my screen earlier?');
    expect(outcome).toEqual({ injected: true, reason: 'screen-memory' });
    // The stop note also lands via injectContext — find the memory call.
    const calls = injectMock(hook).mock.calls;
    const memoryCall = calls.find((call) =>
      String(call[0].turns[0].parts[0].text).includes('Screen memory'),
    );
    expect(memoryCall).toBeDefined();
    const injectedText = String(memoryCall?.[0].turns[0].parts[0].text);
    expect(injectedText).toContain('Pull request');
  });

  it('answers past-screen questions DURING the share (fresh-enough path)', async () => {
    registerChannel(true);
    registry.registerSession(AUTH, hook);
    ingestFrame();
    await flush();
    // Frame was forwarded to the live session → fresh, but the question is
    // about the PAST → memory injection still applies.
    const outcome = registry.onTextArrived(AUTH, 'Remember the page I was showing you?');
    expect(outcome).toEqual({ injected: true, reason: 'screen-memory' });
  });

  it('throttles repeated memory injections', async () => {
    registerChannel(true);
    ingestFrame();
    await flush();
    registry.registerSession(AUTH, hook);
    registry.markChannelStopped(AUTH, 'user_stop');
    const first = registry.onTextArrived(AUTH, 'What was on my screen earlier?');
    expect(first.reason).toBe('screen-memory');
    const second = registry.onTextArrived(AUTH, 'What was on my screen earlier?');
    expect(second.reason).toBe('memory-throttled');
  });

  it('does not inject memory for non-memory questions', () => {
    registerChannel(true);
    ingestFrame();
    registry.registerSession(AUTH, hook);
    registry.markChannelStopped(AUTH, 'user_stop');
    // Channel gone → the honest reason is 'not-sharing' (share ended),
    // and a joke is not a memory question → no injection either way.
    const outcome = registry.onTextArrived(AUTH, 'tell me a joke');
    expect(['not-sharing', 'not-screen-related']).toContain(outcome.reason);
    expect(outcome.injected).toBe(false);
  });

  it('fires onShareEnded with the latest digest when the share stops', async () => {
    registerChannel(true);
    ingestFrame();
    await flush();
    registry.markChannelStopped(AUTH, 'user_stop');
    expect(onShareEnded).toHaveBeenCalledTimes(1);
    const summary = onShareEnded.mock.calls[0][0];
    expect(summary.authorizationId).toBe(AUTH);
    expect(summary.source).toBe('monitor');
    expect(summary.digest).toContain('Pull request');
  });

  it('fires onShareEnded on ungraceful channel loss (after grace)', async () => {
    registerChannel(true);
    ingestFrame();
    await flush();
    registry.dropChannel(AUTH, notify);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(onShareEnded).toHaveBeenCalledTimes(1);
    expect(onShareEnded.mock.calls[0][0].digest).toContain('Pull request');
  });

  it('local-mode hint carries fresh OCR text (text-only local vision)', async () => {
    registerChannel(true);
    ingestFrame();
    await flush();
    const hint = registry.localModeScreenHint(AUTH, 'what is on my screen?');
    expect(hint).toContain('OCR of the current screen');
    expect(hint).toContain('Pull request #42');
  });

  it('local-mode hint falls back honestly when OCR is stale', async () => {
    registerChannel(true);
    ingestFrame();
    await flush();
    clockMs += SCREEN_OCR_LIMITS.maxLocalHintAgeMs + 1_000;
    const hint = registry.localModeScreenHint(AUTH, 'what is on my screen?');
    expect(hint).toContain('cannot see images');
    expect(hint).not.toContain('Pull request');
  });

  it('a registering client without an OCR engine keeps all v1.7.0 behaviour', () => {
    registry = new ScreenVisionRegistry({ now: () => clockMs });
    registerChannel(true);
    ingestFrame();
    expect(registry.getChannelSnapshot(AUTH)?.lastFrameAt).toBe(clockMs);
  });
});

describe('OCR interval control (v1.8.1)', () => {
  let clockMs: number;
  let registry: ScreenVisionRegistry;
  let notify: Mock<(event: Record<string, unknown>) => void>;
  let ocr: { engine: ScreenOcrEngineLike; extract: Mock };

  /** Registry with a TRUSTED server default interval (not clamped). */
  function makeRegistry(defaultIntervalMs: number): ScreenVisionRegistry {
    return new ScreenVisionRegistry({ now: () => clockMs, ocr: ocr.engine, ocrIntervalMs: defaultIntervalMs });
  }

  function register(options: { ocrIntervalMs?: number } = {}): void {
    registry.registerChannel(AUTH, {
      visionMode: true,
      source: 'monitor',
      notify,
      ...(options.ocrIntervalMs !== undefined ? { ocrIntervalMs: options.ocrIntervalMs } : {}),
    });
  }

  function ingestFrame(): void {
    registry.ingestFrame(AUTH, { data: frameData(), width: 640, height: 480, bytes: 96, at: clockMs });
  }

  beforeEach(() => {
    clockMs = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(clockMs);
    notify = vi.fn<(event: Record<string, unknown>) => void>();
    ocr = fakeOcrEngine({ text: SCREEN_TEXT });
    registry = makeRegistry(SCREEN_OCR_LIMITS.defaultIntervalMs);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clampOcrIntervalMs pins the bounds and rejects junk', () => {
    expect(clampOcrIntervalMs(500)).toBe(SCREEN_OCR_LIMITS.minIntervalMs);
    expect(clampOcrIntervalMs(0)).toBe(SCREEN_OCR_LIMITS.minIntervalMs);
    expect(clampOcrIntervalMs(9_999_999)).toBe(SCREEN_OCR_LIMITS.maxIntervalMs);
    expect(clampOcrIntervalMs(4_000)).toBe(4_000);
    expect(clampOcrIntervalMs(4_000.7)).toBe(4_001);
    expect(clampOcrIntervalMs('8000')).toBeNull();
    expect(clampOcrIntervalMs(Number.NaN)).toBeNull();
    expect(clampOcrIntervalMs(undefined)).toBeNull();
  });

  it('a client-supplied interval at registration gates the OCR runs', async () => {
    registry = makeRegistry(8_000);
    register({ ocrIntervalMs: 20_000 });
    expect(registry.getChannelSnapshot(AUTH)?.ocrIntervalMs).toBe(20_000);
    ingestFrame(); // t0 — first OCR
    expect(ocr.extract).toHaveBeenCalledTimes(1);
    await flush();
    clockMs += 10_000;
    ingestFrame(); // 10s < 20s → gated
    expect(ocr.extract).toHaveBeenCalledTimes(1);
    clockMs += 11_000; // 21s ≥ 20s → runs
    ingestFrame();
    expect(ocr.extract).toHaveBeenCalledTimes(2);
  });

  it('clamps out-of-range client intervals at registration', () => {
    registry = makeRegistry(8_000);
    register({ ocrIntervalMs: 10 }); // absurdly fast → floor
    expect(registry.getChannelSnapshot(AUTH)?.ocrIntervalMs).toBe(SCREEN_OCR_LIMITS.minIntervalMs);
    registry.markChannelStopped(AUTH, 'test');
    register({ ocrIntervalMs: 9_999_999 }); // absurdly slow → ceiling
    expect(registry.getChannelSnapshot(AUTH)?.ocrIntervalMs).toBe(SCREEN_OCR_LIMITS.maxIntervalMs);
  });

  it('a missing client interval falls back to the trusted server default (unclamped)', async () => {
    registry = makeRegistry(0); // tests OCR every frame — must NOT be clamped
    register();
    expect(registry.getChannelSnapshot(AUTH)?.ocrIntervalMs).toBe(0);
    ingestFrame();
    await flush(); // let the in-flight extraction finish (single-flight)
    clockMs += 500;
    ingestFrame();
    expect(ocr.extract).toHaveBeenCalledTimes(2);
  });

  it('setOcrInterval changes the gating live (and lowering takes effect sooner)', async () => {
    registry = makeRegistry(30_000);
    register();
    ingestFrame(); // OCR #1 at t0
    expect(ocr.extract).toHaveBeenCalledTimes(1);
    await flush();
    clockMs += 10_000;
    ingestFrame(); // 10s < 30s → gated
    expect(ocr.extract).toHaveBeenCalledTimes(1);

    const effective = registry.setOcrInterval(AUTH, 5_000);
    expect(effective).toBe(5_000);
    clockMs += 2_000; // 12s ≥ 5s since OCR #1 → runs immediately
    ingestFrame();
    expect(ocr.extract).toHaveBeenCalledTimes(2);
  });

  it('setOcrInterval clamps, notifies the client, and mirrors in the snapshot', () => {
    register();
    notify.mockClear();
    expect(registry.setOcrInterval(AUTH, 1)).toBe(SCREEN_OCR_LIMITS.minIntervalMs);
    expect(registry.setOcrInterval(AUTH, 1e9)).toBe(SCREEN_OCR_LIMITS.maxIntervalMs);
    expect(registry.getChannelSnapshot(AUTH)?.ocrIntervalMs).toBe(SCREEN_OCR_LIMITS.maxIntervalMs);
    const event = notify.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      type: 'screen_channel_state',
      ocrIntervalMs: SCREEN_OCR_LIMITS.maxIntervalMs,
      reason: 'ocr_interval',
    });
  });

  it('setOcrInterval with a junk value keeps the current interval', () => {
    register();
    expect(registry.setOcrInterval(AUTH, 'fast')).toBe(SCREEN_OCR_LIMITS.defaultIntervalMs);
    expect(registry.getChannelSnapshot(AUTH)?.ocrIntervalMs).toBe(SCREEN_OCR_LIMITS.defaultIntervalMs);
  });

  it('setOcrInterval returns null when no channel is sharing', () => {
    expect(registry.setOcrInterval(AUTH, 8_000)).toBeNull();
    expect(registry.setOcrInterval('never-registered', 8_000)).toBeNull();
  });

  it('re-registering without an interval keeps the live interval (reconnect blip)', () => {
    register({ ocrIntervalMs: 8_000 });
    registry.setOcrInterval(AUTH, 30_000);
    // Socket blipped: the client re-registers without repeating the value.
    register();
    expect(registry.getChannelSnapshot(AUTH)?.ocrIntervalMs).toBe(30_000);
  });

  it('every screen_channel_state carries the OCR interval for the UI', () => {
    register();
    notify.mockClear();
    registry.setPaused(AUTH, true);
    const event = notify.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(event?.ocrIntervalMs).toBe(SCREEN_OCR_LIMITS.defaultIntervalMs);
  });
});
