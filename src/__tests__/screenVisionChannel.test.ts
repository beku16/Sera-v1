/**
 * v1.7.0 — ScreenVisionChannel tests (client transport).
 *
 * The channel is the share's lifeline to the server: it must reconnect
 * with backoff, queue frames while the socket is down (newest-wins),
 * flush them in order on reconnect, and NEVER kill the local share
 * because of a transport problem. All of that is pinned here against a
 * mock WebSocket.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScreenVisionChannel } from '../vision/screenVisionChannel';

/** Minimal WebSocket double — enough for the channel's surface. */
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closedWith: { code?: number; reason?: string } | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  // ── test drivers ──
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  serverSend(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  drop(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  lastJson(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

function makeFrame(tag = 'A'): { data: string; mimeType: 'image/jpeg'; width: number; height: number; bytes: number; at: number } {
  return { data: `${tag}${'A'.repeat(200)}`, mimeType: 'image/jpeg', width: 1024, height: 640, bytes: 150, at: Date.now() };
}

describe('ScreenVisionChannel', () => {
  let events: Array<{ type: string; state?: unknown; error?: string; reason?: string }>;

  beforeEach(() => {
    MockWebSocket.instances = [];
    events = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeChannel = () =>
    new ScreenVisionChannel((event) => events.push(event as never), {
      socketFactory: (url: string) => new MockWebSocket(url) as unknown as WebSocket,
    });

  const activeSocket = (): MockWebSocket => {
    const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    socket.open();
    return socket;
  };

  it('start() connects to /api/screen-vision with the authorizationId', () => {
    const channel = makeChannel();
    channel.start('auth-abc-123', { visionMode: true, intervalMs: 2500, source: 'monitor' });

    const socket = MockWebSocket.instances[0];
    expect(socket.url).toContain('/api/screen-vision?authorizationId=auth-abc-123');
    socket.open();

    const startMsg = socket.sent.map((raw) => JSON.parse(raw)).find((m) => m.type === 'start');
    expect(startMsg).toMatchObject({ type: 'start', visionMode: true, intervalMs: 2500, source: 'monitor' });
    channel.stop();
  });

  it('forwards frames over the open socket', () => {
    const channel = makeChannel();
    channel.start('auth-1', { visionMode: true, intervalMs: 2500, source: 'monitor' });
    const socket = activeSocket();
    socket.sent.length = 0;

    const frame = makeFrame('F1');
    expect(channel.sendFrame(frame)).toBe(true);
    expect(socket.lastJson()).toMatchObject({ type: 'frame', data: frame.data, width: 1024 });
    channel.stop();
  });

  it('queues frames while disconnected and flushes them on reconnect (newest-wins bound)', async () => {
    vi.useFakeTimers();
    try {
      const channel = makeChannel();
      channel.start('auth-2', { visionMode: true, intervalMs: 2500, source: 'monitor' });
      const socket = activeSocket();
      socket.drop(); // transport dies mid-share

      // Frames captured while offline queue locally instead of vanishing.
      for (let i = 0; i < 8; i++) channel.sendFrame(makeFrame(`F${i}`));
      const state = channel.getState();
      expect(state.connected).toBe(false);
      expect(state.queuedFrames).toBe(4); // bounded, newest kept

      // Backoff reconnect (1s first attempt).
      await vi.advanceTimersByTimeAsync(1100);
      const reconnected = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      reconnected.open();

      const frames = reconnected.sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === 'frame');
      expect(frames.length).toBe(4);
      // Newest-wins: the LAST flushed frame is the newest captured.
      expect(frames[frames.length - 1].data.startsWith('F7')).toBe(true);
      channel.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops reconnecting after the attempt cap and reports honestly', async () => {
    vi.useFakeTimers();
    try {
      const channel = makeChannel();
      channel.start('auth-3', { visionMode: true, intervalMs: 2500, source: 'monitor' });
      const socket = activeSocket();
      socket.drop();

      // 5 reconnect attempts, each failing.
      for (let attempt = 0; attempt < 5; attempt++) {
        await vi.advanceTimersByTimeAsync(9000);
        const candidate = MockWebSocket.instances[MockWebSocket.instances.length - 1];
        candidate.drop();
      }
      await vi.advanceTimersByTimeAsync(20_000);

      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents.length).toBe(1);
      expect(errorEvents[0].error).toContain('lost connection');
      // The share itself is still locally active — transport never kills it.
      expect(channel.getState().active).toBe(true);
      channel.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('mirrors server screen_channel_state messages', () => {
    const channel = makeChannel();
    channel.start('auth-4', { visionMode: true, intervalMs: 2500, source: 'monitor' });
    const socket = activeSocket();

    socket.serverSend({ type: 'screen_channel_state', active: true, visionMode: true, paused: false, streaming: true, reason: 'session_registered' });

    const state = channel.getState();
    expect(state.streaming).toBe(true);
    expect(state.active).toBe(true);

    socket.serverSend({ type: 'screen_channel_state', active: false, reason: 'user_stop' });
    expect(channel.getState().active).toBe(false);
    channel.stop();
  });

  it('surfaces server-side vision errors as events', () => {
    const channel = makeChannel();
    channel.start('auth-5', { visionMode: true, intervalMs: 2500, source: 'monitor' });
    const socket = activeSocket();

    socket.serverSend({ type: 'screen_vision_error', error: 'A screen frame was rejected' });
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].error).toContain('rejected');
    channel.stop();
  });

  it('stop() tells the server, closes cleanly, and resets state', () => {
    const channel = makeChannel();
    channel.start('auth-6', { visionMode: true, intervalMs: 2500, source: 'monitor' });
    const socket = activeSocket();
    socket.sent.length = 0;

    channel.stop();

    expect(socket.lastJson()).toMatchObject({ type: 'stop' });
    expect(socket.closedWith).toMatchObject({ code: 1000 });
    expect(channel.getState()).toMatchObject({ connected: false, active: false, streaming: false });
  });

  it('pause/resume mirror to the server', () => {
    const channel = makeChannel();
    channel.start('auth-7', { visionMode: true, intervalMs: 2500, source: 'monitor' });
    const socket = activeSocket();
    socket.sent.length = 0;

    channel.setPaused(true);
    expect(socket.lastJson()).toMatchObject({ type: 'pause' });

    channel.setPaused(false);
    expect(socket.lastJson()).toMatchObject({ type: 'resume' });
    channel.stop();
  });

  it('vision mode changes mirror to the server', () => {
    const channel = makeChannel();
    channel.start('auth-8', { visionMode: true, intervalMs: 2500, source: 'monitor' });
    const socket = activeSocket();
    socket.sent.length = 0;

    channel.setVisionMode(false);
    expect(socket.lastJson()).toMatchObject({ type: 'vision_mode', enabled: false });
    channel.stop();
  });

  it('start() carries the OCR interval so the server applies it from frame one', () => {
    const channel = makeChannel();
    channel.start('auth-ocr-1', { visionMode: true, intervalMs: 2500, source: 'monitor', ocrIntervalMs: 30_000 });
    const socket = activeSocket();

    const startMsg = socket.sent.map((raw) => JSON.parse(raw)).find((m) => m.type === 'start');
    expect(startMsg).toMatchObject({ type: 'start', ocrIntervalMs: 30_000 });
    expect(channel.getState().ocrIntervalMs).toBe(30_000);
    channel.stop();
  });

  it('setOcrInterval sends the wire message, clamps, and mirrors optimistically', () => {
    const channel = makeChannel();
    channel.start('auth-ocr-2', { visionMode: true, intervalMs: 2500, source: 'monitor' });
    const socket = activeSocket();
    socket.sent.length = 0;

    channel.setOcrInterval(4_000);
    expect(socket.lastJson()).toMatchObject({ type: 'ocr_interval', ocrIntervalMs: 4_000 });
    expect(channel.getState().ocrIntervalMs).toBe(4_000);

    // Client-side clamp keeps the optimistic echo honest (server re-clamps).
    channel.setOcrInterval(1);
    expect(socket.lastJson()).toMatchObject({ type: 'ocr_interval', ocrIntervalMs: 2_000 });
    channel.setOcrInterval(1e9);
    expect(socket.lastJson()).toMatchObject({ type: 'ocr_interval', ocrIntervalMs: 120_000 });
    channel.stop();
  });

  it('mirrors the server-confirmed OCR interval from screen_channel_state', () => {
    const channel = makeChannel();
    channel.start('auth-ocr-3', { visionMode: true, intervalMs: 2500, source: 'monitor' });
    const socket = activeSocket();

    socket.serverSend({
      type: 'screen_channel_state',
      active: true,
      visionMode: true,
      paused: false,
      streaming: true,
      ocrIntervalMs: 15_000,
      reason: 'ocr_interval',
    });
    expect(channel.getState().ocrIntervalMs).toBe(15_000);
    channel.stop();
  });

  it('reconnects re-register with the latest OCR interval', async () => {
    vi.useFakeTimers();
    try {
      const channel = makeChannel();
      channel.start('auth-ocr-4', { visionMode: true, intervalMs: 2500, source: 'monitor' });
      const socket = activeSocket();
      channel.setOcrInterval(30_000);

      socket.drop(); // transport blip mid-share
      await vi.advanceTimersByTimeAsync(1_100);
      const reconnected = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      reconnected.open();

      const startMsg = reconnected.sent.map((raw) => JSON.parse(raw)).find((m) => m.type === 'start');
      expect(startMsg).toMatchObject({ type: 'start', ocrIntervalMs: 30_000 });
      channel.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('one-shot frames carry the oneShot flag', () => {
    const channel = makeChannel();
    channel.start('auth-9', { visionMode: false, intervalMs: 2500, source: 'monitor' });
    const socket = activeSocket();
    socket.sent.length = 0;

    channel.sendFrame(makeFrame('X'), { oneShot: true });
    expect(socket.lastJson()).toMatchObject({ type: 'frame', oneShot: true });
    channel.stop();
  });

  it('heartbeats keep the socket alive', async () => {
    vi.useFakeTimers();
    try {
      const channel = makeChannel();
      channel.start('auth-10', { visionMode: true, intervalMs: 2500, source: 'monitor' });
      const socket = activeSocket();
      socket.sent.length = 0;

      await vi.advanceTimersByTimeAsync(25_500);
      const pings = socket.sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === 'ping');
      expect(pings.length).toBeGreaterThanOrEqual(1);
      channel.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('malformed server messages never kill the channel', () => {
    const channel = makeChannel();
    channel.start('auth-11', { visionMode: true, intervalMs: 2500, source: 'monitor' });
    const socket = activeSocket();

    socket.onmessage?.({ data: '{{{not json' });
    socket.onmessage?.({ data: JSON.stringify({ type: 'unknown-thing' }) });

    expect(channel.getState().connected).toBe(true);
    channel.stop();
  });
});
