/**
 * v1.7.0 — client side of the /api/screen-vision WebSocket.
 *
 * WHY A DEDICATED SOCKET (not the /api/live voice socket): the share must
 * survive Gemini Live session rollovers (Google closes Live sessions
 * every ~7-10 minutes and SERA silently reconnects). Frames keep flowing
 * on this channel across those rollovers; the server buffers the newest
 * frame and injects it into every fresh session, so "what is on my
 * screen?" is ALWAYS answered from the current view.
 *
 * Robustness contract:
 *  - while sharing is active the channel reconnects with capped backoff,
 *  - frames captured while disconnected queue (bounded, newest-wins) and
 *    flush on reconnect,
 *  - a dead socket NEVER kills the share itself — the local preview and
 *    capture pipeline are independent of this transport.
 */

export interface ScreenVisionChannelOptions {
  /** Injectable for tests; defaults to the browser WebSocket. */
  socketFactory?: (url: string) => WebSocket;
  now?: () => number;
}

/**
 * v1.8.1 — client-side mirror of the server's OCR interval bounds. The
 * server clamps authoritatively on every message; this copy only keeps
 * the optimistic local echo within honest range.
 */
const OCR_INTERVAL_MIN_MS = 2_000;
const OCR_INTERVAL_MAX_MS = 120_000;
export const OCR_INTERVAL_DEFAULT_MS = 8_000;

export interface ScreenVisionChannelState {
  connected: boolean;
  /** True when the server confirmed frames are reaching a live SERA session. */
  streaming: boolean;
  /** Server-confirmed share state mirror. */
  active: boolean;
  visionMode: boolean;
  paused: boolean;
  reconnectAttempts: number;
  queuedFrames: number;
  /** v1.8.0 — chars of visible text the server's OCR last read (0 = none). */
  ocrChars: number;
  /** v1.8.1 — live OCR re-scan interval (server-confirmed ms). */
  ocrIntervalMs: number;
}

export type ScreenVisionEvent =
  | { type: 'state'; state: ScreenVisionChannelState; reason: string }
  | { type: 'error'; error: string };

const MAX_QUEUED_FRAMES = 4;
const MAX_RECONNECT_ATTEMPTS = 5;

export interface WireFrame {
  data: string;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  bytes: number;
  at: number;
}

export class ScreenVisionChannel {
  private ws: WebSocket | null = null;
  private started = false;
  private stopping = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private queuedFrames: WireFrame[] = [];
  private state: ScreenVisionChannelState = {
    connected: false,
    streaming: false,
    active: false,
    visionMode: true,
    paused: false,
    reconnectAttempts: 0,
    queuedFrames: 0,
    ocrChars: 0,
    ocrIntervalMs: OCR_INTERVAL_DEFAULT_MS,
  };
  private visionMode = true;
  private paused = false;
  private authorizationId: string = '';
  private initParams: {
    visionMode: boolean;
    intervalMs: number;
    source: string;
    /** v1.8.1 — rides the start message so reconnects keep the interval. */
    ocrIntervalMs?: number;
  } | null = null;
  private socketFactory: (url: string) => WebSocket;

  constructor(
    private readonly onEvent: (event: ScreenVisionEvent) => void,
    options: ScreenVisionChannelOptions = {},
  ) {
    this.socketFactory =
      options.socketFactory ??
      ((url: string) => new WebSocket(url));
  }

  private get now(): number {
    return Date.now();
  }

  public getState(): ScreenVisionChannelState {
    return { ...this.state, queuedFrames: this.queuedFrames.length };
  }

  /** Open the channel and register the share with the server. */
  public start(
    authorizationId: string,
    init: { visionMode: boolean; intervalMs: number; source: string; ocrIntervalMs?: number },
  ): void {
    this.authorizationId = authorizationId;
    this.initParams = init;
    this.visionMode = init.visionMode;
    this.paused = false;
    this.started = true;
    this.stopping = false;
    this.reconnectAttempts = 0;
    this.queuedFrames = [];
    this.state = {
      ...this.state,
      active: true,
      visionMode: init.visionMode,
      paused: false,
      // v1.8.1 — optimistic echo; the server confirms (clamped) on start.
      ...(typeof init.ocrIntervalMs === 'number' ? { ocrIntervalMs: init.ocrIntervalMs } : {}),
    };
    // The registration itself rides the socket once it opens (onopen) —
    // sending here would be a no-op into a CONNECTING socket.
    this.connect();
    this.emitState('local-start');
  }

  private connect(): void {
    if (!this.started || this.ws) return;
    let socket: WebSocket;
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = this.socketFactory(
        `${protocol}//${window.location.host}/api/screen-vision?authorizationId=${encodeURIComponent(this.authorizationId)}`,
      );
    } catch (err) {
      this.onEvent({ type: 'error', error: `Screen vision channel could not open: ${err instanceof Error ? err.message : String(err)}` });
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.state.connected = true;
      // Re-register after every (re)connect — the server channel may have
      // been dropped socket-side while we were away.
      this.send({
        type: 'start',
        ...(this.initParams ?? { visionMode: this.visionMode, intervalMs: 2500, source: 'reconnect' }),
      });
      if (this.paused) this.send({ type: 'pause' });
      this.flushQueuedFrames();
      this.startHeartbeat();
      this.emitState('connected');
    };

    socket.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
        if (msg.type === 'screen_channel_state') {
          this.state.active = msg.active === true;
          this.state.visionMode = msg.visionMode === true;
          this.state.paused = msg.paused === true;
          this.state.streaming = msg.streaming === true;
          // v1.8.0 — honest OCR telemetry from the server (chars read).
          this.state.ocrChars = typeof msg.ocrChars === 'number' ? msg.ocrChars : this.state.ocrChars;
          // v1.8.1 — server-confirmed OCR interval (authoritative echo).
          this.state.ocrIntervalMs =
            typeof msg.ocrIntervalMs === 'number' ? msg.ocrIntervalMs : this.state.ocrIntervalMs;
          this.emitState(typeof msg.reason === 'string' ? msg.reason : 'server-state');
        } else if (msg.type === 'pong') {
          // heartbeat round-trip — nothing to mirror.
        } else if (msg.type === 'screen_vision_error' && typeof msg.error === 'string') {
          this.onEvent({ type: 'error', error: msg.error });
        }
      } catch {
        // malformed frame — ignore, never kill the channel over one packet
      }
    };

    socket.onclose = () => {
      this.stopHeartbeat();
      this.ws = null;
      this.state.connected = false;
      this.state.streaming = false;
      if (this.stopping || !this.started) {
        this.emitState('closed');
        return;
      }
      this.emitState('disconnected');
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose follows; nothing extra to do — the share keeps running
      // locally and frames queue while we reconnect.
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.started || this.stopping) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.onEvent({
        type: 'error',
        error: 'Screen vision channel lost connection — frame streaming paused. Stop and restart the share to retry.',
      });
      return;
    }
    this.reconnectAttempts += 1;
    const delayMs = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 8000);
    this.state.reconnectAttempts = this.reconnectAttempts;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // App-level keepalive: proxies / load balancers love to idle-kill
    // quiet sockets; 25s pings keep the channel honestly open.
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'ping' });
    }, 25_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private send(payload: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  private flushQueuedFrames(): void {
    while (this.queuedFrames.length > 0) {
      const frame = this.queuedFrames.shift();
      if (!frame) break;
      if (!this.sendFrameWire(frame, false)) {
        this.queuedFrames.unshift(frame); // socket died mid-flush — retry next open
        break;
      }
    }
    this.emitState('flush');
  }

  private sendFrameWire(frame: WireFrame, oneShot: boolean): boolean {
    return this.send({
      type: 'frame',
      data: frame.data,
      mimeType: frame.mimeType,
      width: frame.width,
      height: frame.height,
      bytes: frame.bytes,
      at: frame.at,
      ...(oneShot ? { oneShot: true } : {}),
    });
  }

  /** Send (or queue) one captured frame. oneShot bypasses vision-mode gating. */
  public sendFrame(frame: WireFrame, options?: { oneShot?: boolean }): boolean {
    if (!this.started) return false;
    const oneShot = options?.oneShot === true;
    if (this.sendFrameWire(frame, oneShot)) return true;
    // Socket down: queue newest-wins, bounded — a stale backlog serves
    // nobody; the newest frame is the one that matters at question time.
    this.queuedFrames.push(frame);
    while (this.queuedFrames.length > MAX_QUEUED_FRAMES) this.queuedFrames.shift();
    this.emitState('queued');
    return false;
  }

  public setVisionMode(enabled: boolean): void {
    this.visionMode = enabled;
    this.state.visionMode = enabled;
    this.send({ type: 'vision_mode', enabled });
    this.emitState('vision-mode-local');
  }

  public setPaused(paused: boolean): void {
    this.paused = paused;
    this.state.paused = paused;
    this.send({ type: paused ? 'pause' : 'resume' });
    this.emitState(paused ? 'pause-local' : 'resume-local');
  }

  /**
   * v1.8.1 — change the OCR re-scan interval live (the dock stepper).
   * Optimistically mirrors the (client-clamped) value so the UI reacts
   * instantly; the server's screen_channel_state echo is authoritative.
   */
  public setOcrInterval(ms: number): void {
    const clamped =
      typeof ms === 'number' && Number.isFinite(ms)
        ? Math.min(OCR_INTERVAL_MAX_MS, Math.max(OCR_INTERVAL_MIN_MS, Math.round(ms)))
        : this.state.ocrIntervalMs;
    this.state.ocrIntervalMs = clamped;
    if (this.initParams) this.initParams.ocrIntervalMs = clamped; // reconnects keep it
    this.send({ type: 'ocr_interval', ocrIntervalMs: clamped });
    this.emitState('ocr-interval-local');
  }

  /** Cleanly stop sharing: tells the server, then closes the socket. */
  public stop(): void {
    this.started = false;
    this.stopping = true;
    this.send({ type: 'stop' });
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    this.queuedFrames = [];
    this.state = {
      connected: false,
      streaming: false,
      active: false,
      visionMode: this.visionMode,
      paused: false,
      reconnectAttempts: 0,
      queuedFrames: 0,
      ocrChars: 0,
      // v1.8.1 — the chosen interval survives a stop so the NEXT share
      // starts with the same setting (the hook persists it anyway).
      ocrIntervalMs: this.state.ocrIntervalMs,
    };
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000, 'share stopped');
        }
      } catch { /* already closing */ }
    }
    this.emitState('stopped');
  }

  private emitState(reason: string): void {
    this.state.queuedFrames = this.queuedFrames.length;
    this.onEvent({ type: 'state', state: this.getState(), reason });
  }
}
