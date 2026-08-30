/**
 * v1.7.0 — BROWSER SCREEN VISION registry (server-side core).
 *
 * THE FEATURE: the user clicks "Share Screen" in the SERA UI, the browser
 * Screen Capture API (getDisplayMedia) streams JPEG frames of whatever
 * they picked (entire screen / window / browser tab) to this server, and
 * the frames are forwarded into the active Gemini Live session so SERA
 * can SEE and answer questions about whatever is on screen — in real
 * time, with conversation context preserved across frames.
 *
 * WHY A SEPARATE CHANNEL: the screen share must SURVIVE the Gemini Live
 * session lifecycle (Google kills Live sessions every ~7-10 minutes; SERA
 * silently reconnects). Frames therefore arrive on a dedicated
 * /api/screen-vision WebSocket keyed by the same stable authorizationId
 * the /api/live socket uses. When no live session exists, frames buffer
 * here (bounded); the moment a session becomes ready the newest frame is
 * injected so the very first question ("what is on my screen?") is
 * answered from a CURRENT view, never a stale one.
 *
 * v1.8.0 ADDITIONS (both optional, injected via constructor):
 *  - OCR ENGINE  → every few seconds (v1.8.1: a client-selectable
 *    interval, live-adjustable) the newest accepted frame is ALSO
 *    run through Tesseract; the distilled visible text is injected next
 *    to the frame (ultra-precise reading for Online mode) and included in
 *    the local-mode hint (local models can finally READ the screen).
 *  - SCREEN MEMORY → each distinct screen state (per OCR) is digested
 *    into a bounded per-user log, so "what was on my screen earlier?"
 *    works during AND after the share; a share-ended summary is handed
 *    back to server.ts for persistence into the app MemoryManager.
 *
 * This module is PURE LOGIC (no ws / express imports) so every rule —
 * forwarding, buffering, flood guarding, pause semantics, stale refresh,
 * context injection, OCR scheduling, memory digests — is unit-testable
 * without sockets.
 */

import {
  clampOcrIntervalMs,
  SCREEN_OCR_LIMITS,
  ScreenOcrEngineLike,
} from './screenOcr';
import {
  looksLikeScreenMemoryQuestion,
  SCREEN_MEMORY_LIMITS,
  ScreenMemoryLog,
  ScreenMemoryLogLike,
} from './screenMemory';

/** One captured screen frame (base64 JPEG, no data: prefix). */
export interface ScreenVisionFrame {
  data: string;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  /** Decoded byte size of the JPEG. */
  bytes: number;
  /** Capture timestamp (ms). */
  at: number;
}

/**
 * The live-session side of the bridge. server.ts supplies one per active
 * Gemini Live session; every method is defensive — a hook that throws or
 * returns false is treated as "session cannot accept frames right now".
 */
export interface ScreenVisionSessionHook {
  /** realtimeInput media path — frames flow WITHOUT triggering a reply. */
  sendMedia: (frame: ScreenVisionFrame) => boolean;
  /**
   * sendClientContent({ turns, turnComplete: false }) — injects context
   * (image + short label) WITHOUT asking the model to respond. Used for
   * the session-ready view and stale-frame refresh; never for chatter.
   */
  injectContext: (content: {
    turns: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    turnComplete: false;
  }) => boolean;
  /** False once the Gemini session closed — frames then buffer only. */
  isActive: () => boolean;
}

export type ScreenVisionIngestResult =
  | 'forwarded'
  | 'buffered'
  | 'dropped-no-channel'
  | 'dropped-inactive'
  | 'dropped-mode-off'
  | 'dropped-paused'
  | 'dropped-flood'
  | 'dropped-oversize'
  | 'dropped-invalid'
  | 'dropped-session-rejected';

export interface ScreenVisionChannelSnapshot {
  authorizationId: string;
  active: boolean;
  visionMode: boolean;
  paused: boolean;
  source: string;
  intervalMs: number;
  /** v1.8.1 — live OCR re-scan interval for this channel (ms). */
  ocrIntervalMs: number;
  framesForwarded: number;
  framesBuffered: number;
  framesDropped: number;
  lastFrameAt: number | null;
  lastForwardedAt: number | null;
  startedAt: number;
  bufferedFrames: number;
  streaming: boolean;
}

interface ChannelRecord {
  snapshot: ScreenVisionChannelSnapshot;
  /** Newest-last ring of the last frames received (bounded). */
  ring: ScreenVisionFrame[];
  /** Set when a one-shot frame is waiting for the next session (vision OFF). */
  pendingOneShot: boolean;
  /** Last frame ACCEPTED time (flood guard uses this, not lastFrameAt). */
  lastAcceptedAt: number;
  /** Server-side notify (screen_channel_state → the sharing client). */
  notify: (event: Record<string, unknown>) => void;
  /** v1.8.0 — newest OCR extraction for this channel (null until first run). */
  lastOcr: { text: string; at: number } | null;
  /** v1.8.0 — OCR currently running (never two extractions at once). */
  ocrInFlight: boolean;
  /** v1.8.0 — last time an OCR run STARTED (interval gating). */
  lastOcrStartedAt: number;
}

export const SCREEN_VISION_LIMITS = {
  /** Hard per-frame decoded byte ceiling (~293KB base64). Client targets ≤160KB. */
  maxFrameBytes: 220_000,
  /** Base64 string ceiling before even decoding checks. */
  maxBase64Chars: 400_000,
  /** Frames arriving faster than this are flood-dropped. */
  minFrameIntervalMs: 400,
  /** How many frames stay buffered for session-ready injection. */
  bufferFrames: 2,
  /** Buffered frames older than this are discarded at read time. */
  maxFrameAgeMs: 180_000,
  /**
   * A text question refreshes the in-session view when the last frame the
   * model saw is older than this (static screen / long monologue).
   */
  staleFrameMs: 30_000,
  /** Concurrent sharing channels (multi-tab); oldest is evicted beyond this. */
  maxChannels: 8,
} as const;

/** Cheap screen-topicality test — gates injected notes so they never spam. */
const SCREEN_TOPIC_RE =
  /\b(screen|my screen|the screen|see|seeing|look|looking|watch|visible|this page|this tab|this window|this code|thumbnail|error|errors|website|site|browser|youtube|analytics|display|monitor|read this|summarize this|explain this)\b/i;

export function looksScreenRelated(text: string): boolean {
  return typeof text === 'string' && text.length > 0 && SCREEN_TOPIC_RE.test(text);
}

/**
 * Strips an optional data-URL prefix and validates base64 shape. Returns
 * the clean base64 payload, or null when the string cannot be a frame.
 */
export function normalizeFrameData(data: unknown): string | null {
  if (typeof data !== 'string' || data.length < 64) return null;
  let payload = data;
  const prefixMatch = /^data:image\/[a-z]+;base64,/.exec(payload);
  if (prefixMatch) payload = payload.slice(prefixMatch[0].length);
  if (payload.length > SCREEN_VISION_LIMITS.maxBase64Chars) return null;
  if (payload.length % 4 === 1) return null; // impossible base64 length
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null;
  return payload;
}

export interface ScreenVisionInjectOutcome {
  injected: boolean;
  reason: string;
}

/** Summary handed to the persistence callback when a share session ends. */
export interface ScreenShareEndedSummary {
  authorizationId: string;
  source: string;
  startedAt: number;
  endedAt: number;
  /** Latest OCR digest of what was visible when the share ended. */
  digest: string | null;
}

export interface ScreenVisionRegistryOptions {
  now?: () => number;
  dropGraceMs?: number;
  /** v1.8.0 — OCR engine (ultra-precise reading). Absent = OCR off. */
  ocr?: ScreenOcrEngineLike;
  /**
   * v1.8.0 → v1.8.1 — DEFAULT min ms between OCR runs per channel. Each
   * channel can override this live from the client (clamped to
   * SCREEN_OCR_LIMITS bounds); the constructor value is trusted config and
   * is therefore NOT clamped (tests use 0 to OCR every frame).
   */
  ocrIntervalMs?: number;
  /** v1.8.0 — per-user screen memory factory (defaults to ScreenMemoryLog). */
  memoryFactory?: (authorizationId: string) => ScreenMemoryLogLike;
  /** v1.8.0 — fired when a share ends, for persistence into MemoryManager. */
  onShareEnded?: (summary: ScreenShareEndedSummary) => void;
}

export class ScreenVisionRegistry {
  private readonly channels = new Map<string, ChannelRecord>();
  private readonly sessions = new Map<string, ScreenVisionSessionHook>();
  private readonly dropTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;
  private readonly dropGraceMs: number;
  private readonly ocr: ScreenOcrEngineLike | null;
  /** Default per-channel OCR interval (each channel may override live). */
  private readonly ocrIntervalMs: number;
  private readonly memoryFactory: (authorizationId: string) => ScreenMemoryLogLike;
  private readonly onShareEnded?: (summary: ScreenShareEndedSummary) => void;
  private readonly memories = new Map<string, ScreenMemoryLogLike>();
  /** Per-user throttle for memory-context injection (avoid re-quoting). */
  private readonly lastMemoryInjectedAt = new Map<string, number>();

  constructor(options?: ScreenVisionRegistryOptions) {
    this.now = options?.now ?? (() => Date.now());
    this.dropGraceMs = options?.dropGraceMs ?? 10_000;
    this.ocr = options?.ocr ?? null;
    this.ocrIntervalMs = options?.ocrIntervalMs ?? SCREEN_OCR_LIMITS.defaultIntervalMs;
    this.memoryFactory = options?.memoryFactory ?? (() => new ScreenMemoryLog({ now: this.now }));
    this.onShareEnded = options?.onShareEnded;
  }

  /** v1.8.0 — per-user screen memory (created lazily, survives share stop). */
  public screenMemory(authorizationId: string): ScreenMemoryLogLike {
    let log = this.memories.get(authorizationId);
    if (!log) {
      log = this.memoryFactory(authorizationId);
      this.memories.set(authorizationId, log);
    }
    return log;
  }

  // ── Channel lifecycle (the sharing browser tab) ───────────────────

  public registerChannel(
    authorizationId: string,
    init: {
      visionMode: boolean;
      source?: string;
      intervalMs?: number;
      /** v1.8.1 — client-requested OCR interval (clamped to the limits). */
      ocrIntervalMs?: number;
      notify: (event: Record<string, unknown>) => void;
    },
  ): ScreenVisionChannelSnapshot {
    const now = this.now();
    // Reconnect race: a pending drop (socket blipped) is cancelled — the
    // share never actually ended.
    const pendingDrop = this.dropTimers.get(authorizationId);
    if (pendingDrop) {
      clearTimeout(pendingDrop);
      this.dropTimers.delete(authorizationId);
    }
    // Multi-tab cap: evict the oldest channel beyond the limit.
    if (this.channels.size >= SCREEN_VISION_LIMITS.maxChannels && !this.channels.has(authorizationId)) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [key, record] of this.channels) {
        if (record.snapshot.startedAt < oldestAt) {
          oldestAt = record.snapshot.startedAt;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        const evicted = this.channels.get(oldestKey);
        this.channels.delete(oldestKey);
        evicted?.notify({ type: 'screen_channel_state', active: false, reason: 'evicted' });
      }
    }

    const existing = this.channels.get(authorizationId);
    const snapshot: ScreenVisionChannelSnapshot = {
      authorizationId,
      active: true,
      visionMode: init.visionMode === true,
      paused: false,
      source: typeof init.source === 'string' && init.source ? init.source.slice(0, 40) : 'unknown',
      intervalMs:
        typeof init.intervalMs === 'number' && init.intervalMs >= 250 && init.intervalMs <= 60_000
          ? Math.round(init.intervalMs)
          : 2500,
      // v1.8.1 — client-selected OCR interval, clamped server-side; a
      // missing/invalid value keeps the previous live interval on reconnect
      // (like the ring buffer survives), else the registry default.
      ocrIntervalMs:
        clampOcrIntervalMs(init.ocrIntervalMs) ??
        existing?.snapshot.ocrIntervalMs ??
        this.ocrIntervalMs,
      framesForwarded: existing?.snapshot.framesForwarded ?? 0,
      framesBuffered: existing?.snapshot.framesBuffered ?? 0,
      framesDropped: existing?.snapshot.framesDropped ?? 0,
      lastFrameAt: existing?.snapshot.lastFrameAt ?? null,
      lastForwardedAt: existing?.snapshot.lastForwardedAt ?? null,
      startedAt: now,
      bufferedFrames: 0,
      streaming: false,
    };
    const record: ChannelRecord = {
      snapshot,
      ring: existing?.ring ?? [],
      pendingOneShot: existing?.pendingOneShot ?? false,
      lastAcceptedAt: 0,
      notify: init.notify,
      // v1.8.0 — OCR state survives the socket blip like the ring does:
      // the reconnecting client keeps sharing the SAME screen, so a fresh
      // OCR baseline is not needed (and the interval gate keeps cost low).
      lastOcr: existing?.lastOcr ?? null,
      ocrInFlight: false,
      lastOcrStartedAt: existing?.lastOcrStartedAt ?? 0,
    };
    this.channels.set(authorizationId, record);

    // A session that is already live learns about the share immediately
    // (context-only — never triggers speech).
    this.injectContextParts(authorizationId, [
      { text: '[Screen share started — live frames of the user\'s screen will now arrive as images. Treat the newest image as their current screen.]' },
    ]);

    this.notifyChannelState(record, 'started');
    return { ...snapshot };
  }

  public setVisionMode(authorizationId: string, enabled: boolean): boolean {
    const record = this.channels.get(authorizationId);
    if (!record || !record.snapshot.active) return false;
    record.snapshot.visionMode = enabled === true;
    if (record.snapshot.visionMode) {
      // Turning vision ON with a live session: hand the model the current
      // view right away so the next question is answerable immediately.
      const latest = this.latestFreshFrame(record);
      if (latest && this.sessionCanReceive(authorizationId)) {
        const ok = this.injectFrameWithContext(
          authorizationId,
          latest,
          '[Current screen — screen vision was just enabled.]',
        );
        if (ok) {
          record.snapshot.lastForwardedAt = this.now();
          record.snapshot.framesForwarded += 1;
        }
      }
      record.pendingOneShot = false;
    }
    this.notifyChannelState(record, 'vision_mode');
    return true;
  }

  public setPaused(authorizationId: string, paused: boolean): boolean {
    const record = this.channels.get(authorizationId);
    if (!record || !record.snapshot.active) return false;
    record.snapshot.paused = paused === true;
    this.notifyChannelState(record, paused ? 'paused' : 'resumed');
    return true;
  }

  /**
   * v1.8.1 — live per-channel OCR interval change (the dock stepper).
   * Clamps the client value, applies it to the channel snapshot, and
   * pushes a screen_channel_state so the UI mirrors the EFFECTIVE value.
   * Lowering the interval takes effect naturally on the next accepted
   * frame (the gate compares against the new, smaller interval).
   * Returns the effective ms, or null when no active channel exists.
   */
  public setOcrInterval(authorizationId: string, ms: unknown): number | null {
    const record = this.channels.get(authorizationId);
    if (!record || !record.snapshot.active) return null;
    const clamped = clampOcrIntervalMs(ms);
    if (clamped === null) return record.snapshot.ocrIntervalMs;
    record.snapshot.ocrIntervalMs = clamped;
    this.notifyChannelState(record, 'ocr_interval');
    return clamped;
  }

  public markChannelStopped(authorizationId: string, reason = 'stopped'): boolean {
    const record = this.channels.get(authorizationId);
    if (!record) return false;
    const pendingDrop = this.dropTimers.get(authorizationId);
    if (pendingDrop) {
      clearTimeout(pendingDrop);
      this.dropTimers.delete(authorizationId);
    }
    record.snapshot.active = false;
    record.ring = [];
    record.pendingOneShot = false;
    this.channels.delete(authorizationId);
    // v1.8.0 — SCREEN MEMORY BRIDGE: hand the share summary (with the
    // latest OCR digest) to the persistence callback BEFORE the record
    // goes away, so "remember what was on my screen" survives the stop.
    this.emitShareEnded(authorizationId, record, 'user_stop');
    // Honesty guarantee: a live model must never believe it can still see
    // the screen after the user stopped sharing.
    this.injectContextParts(authorizationId, [
      { text: '[Screen share stopped — you can no longer see the user\'s screen. Do not claim you can see it.]' },
    ]);
    record.notify({ type: 'screen_channel_state', active: false, visionMode: record.snapshot.visionMode, paused: record.snapshot.paused, reason });
    return true;
  }

  /** Channel socket died without a polite stop (crash / network drop). */
  public dropChannel(authorizationId: string, notify?: (event: Record<string, unknown>) => void): boolean {
    const record = this.channels.get(authorizationId);
    if (!record) return false;
    // GRACE PERIOD: the client auto-reconnects this channel on blips. Only
    // treat the share as truly dead (and tell the model so) when nothing
    // re-registers within dropGraceMs.
    if (this.dropTimers.has(authorizationId)) return true;
    const timer = setTimeout(() => {
      this.dropTimers.delete(authorizationId);
      const still = this.channels.get(authorizationId);
      if (!still) return;
      this.channels.delete(authorizationId);
      // v1.8.0 — persistence on an ungraceful end too (crash / net drop).
      this.emitShareEnded(authorizationId, still, 'channel_lost');
      // Honesty: a live model must stop believing it can see the screen.
      this.injectContextParts(authorizationId, [
        { text: '[Screen share connection ended — you can no longer see the user\'s screen.]' },
      ]);
      try {
        (notify ?? still.notify)({ type: 'screen_channel_state', active: false, reason: 'channel_lost' });
      } catch { /* socket gone */ }
    }, Math.max(0, this.dropGraceMs));
    this.dropTimers.set(authorizationId, timer);
    return true;
  }

  /** Immediately finalize all pending drops (tests / shutdown). */
  public finalizeDropsNow(): void {
    for (const timer of this.dropTimers.values()) clearTimeout(timer);
    this.dropTimers.clear();
    for (const [authorizationId, record] of [...this.channels.entries()]) {
      this.channels.delete(authorizationId);
      this.emitShareEnded(authorizationId, record, 'finalized');
      this.injectContextParts(authorizationId, [
        { text: '[Screen share connection ended — you can no longer see the user\'s screen.]' },
      ]);
      try {
        record.notify({ type: 'screen_channel_state', active: false, reason: 'finalized' });
      } catch { /* socket gone */ }
    }
  }

  // ── Frame flow ────────────────────────────────────────────────────

  public ingestFrame(
    authorizationId: string,
    rawFrame: {
      data?: unknown;
      width?: unknown;
      height?: unknown;
      bytes?: unknown;
      at?: unknown;
    },
    options?: { oneShot?: boolean },
  ): ScreenVisionIngestResult {
    const record = this.channels.get(authorizationId);
    if (!record) return 'dropped-no-channel';
    if (!record.snapshot.active) return 'dropped-inactive';

    const data = normalizeFrameData(rawFrame.data);
    if (!data) {
      record.snapshot.framesDropped += 1;
      return 'dropped-invalid';
    }
    const width = typeof rawFrame.width === 'number' ? Math.round(rawFrame.width) : 0;
    const height = typeof rawFrame.height === 'number' ? Math.round(rawFrame.height) : 0;
    if (width < 1 || height < 1 || width > 12_000 || height > 12_000) {
      record.snapshot.framesDropped += 1;
      return 'dropped-invalid';
    }
    const bytes =
      typeof rawFrame.bytes === 'number' && rawFrame.bytes > 0
        ? Math.round(rawFrame.bytes)
        : Math.floor((data.length * 3) / 4);
    if (bytes > SCREEN_VISION_LIMITS.maxFrameBytes) {
      record.snapshot.framesDropped += 1;
      return 'dropped-oversize';
    }

    const now = this.now();
    // Flood guard — one frame per minFrameIntervalMs per channel is plenty
    // (production sends one per ~2.5s).
    if (record.lastAcceptedAt > 0 && now - record.lastAcceptedAt < SCREEN_VISION_LIMITS.minFrameIntervalMs) {
      record.snapshot.framesDropped += 1;
      return 'dropped-flood';
    }
    record.lastAcceptedAt = now;

    const frame: ScreenVisionFrame = {
      data,
      mimeType: 'image/jpeg',
      width,
      height,
      bytes,
      at: typeof rawFrame.at === 'number' && rawFrame.at > 0 ? rawFrame.at : now,
    };

    // Bounded ring buffer (newest last).
    record.ring.push(frame);
    while (record.ring.length > SCREEN_VISION_LIMITS.bufferFrames) record.ring.shift();
    record.snapshot.lastFrameAt = now;
    record.snapshot.bufferedFrames = record.ring.length;

    // v1.8.0 — ultra-precise reading: schedule an OCR pass on this frame.
    // Fire-and-forget; a slow or failing engine NEVER touches frame flow.
    this.maybeRunOcr(authorizationId, record, frame);

    const oneShot = options?.oneShot === true;
    if (oneShot) {
      record.pendingOneShot = true;
      // One-shot frames ALWAYS forward when a session can receive them —
      // they are explicit "look NOW" requests that bypass the visionMode
      // switch (the user asked about the screen while vision was OFF).
      if (this.sessionCanReceive(authorizationId)) {
        const forwarded = this.sendMediaToSession(authorizationId, frame);
        if (forwarded) {
          record.snapshot.framesForwarded += 1;
          record.snapshot.lastForwardedAt = now;
          record.pendingOneShot = false;
          return 'forwarded';
        }
        return 'dropped-session-rejected';
      }
      record.snapshot.framesBuffered += 1;
      return 'buffered';
    }

    if (!record.snapshot.visionMode) {
      record.snapshot.framesDropped += 1;
      return 'dropped-mode-off';
    }
    if (record.snapshot.paused) {
      record.snapshot.framesBuffered += 1;
      return 'dropped-paused';
    }

    if (this.sessionCanReceive(authorizationId)) {
      const forwarded = this.sendMediaToSession(authorizationId, frame);
      if (forwarded) {
        record.snapshot.framesForwarded += 1;
        record.snapshot.lastForwardedAt = now;
        return 'forwarded';
      }
      record.snapshot.framesBuffered += 1;
      return 'dropped-session-rejected';
    }
    record.snapshot.framesBuffered += 1;
    return 'buffered';
  }

  // ── Live-session lifecycle hooks ──────────────────────────────────

  public registerSession(authorizationId: string, hook: ScreenVisionSessionHook): void {
    this.sessions.set(authorizationId, hook);
    // The sharing client flips its indicator to "STREAMING TO SERA".
    const record = this.channels.get(authorizationId);
    if (record) this.notifyChannelState(record, 'session_registered');
  }

  public unregisterSession(authorizationId: string, hook: ScreenVisionSessionHook): void {
    if (this.sessions.get(authorizationId) === hook) {
      this.sessions.delete(authorizationId);
      const record = this.channels.get(authorizationId);
      if (record) this.notifyChannelState(record, 'session_closed');
    }
  }

  public hasActiveSession(authorizationId: string): boolean {
    return this.sessionCanReceive(authorizationId);
  }

  /**
   * Called when a Gemini Live session for this authorizationId becomes
   * ready — BEFORE any queued user text is flushed, so the very first
   * question of the session is answered from the CURRENT screen.
   */
  public onSessionReady(authorizationId: string): ScreenVisionInjectOutcome {
    const record = this.channels.get(authorizationId);
    if (!record || !record.snapshot.active) {
      return { injected: false, reason: 'not-sharing' };
    }
    const session = this.sessions.get(authorizationId);
    if (!session || !session.isActive()) {
      return { injected: false, reason: 'no-session' };
    }

    if (record.snapshot.paused) {
      const ok = this.injectContextParts(authorizationId, [
        { text: '[Screen sharing is currently PAUSED — no live screen frames are arriving. If the user asks about their screen, say it is paused instead of guessing.]' },
      ]);
      return { injected: ok, reason: 'paused-note' };
    }

    const injectCurrent = record.snapshot.visionMode || record.pendingOneShot;
    const latest = this.latestFreshFrame(record);
    if (injectCurrent && latest) {
      const ok = this.injectFrameWithContext(
        authorizationId,
        latest,
        record.snapshot.visionMode
          ? '[Screen share is active — this is the user\'s current screen. New frames will follow as it changes; treat the newest frame as the present moment.]'
          : '[The user asked about their screen — this is the current view.]',
      );
      if (ok) {
        record.pendingOneShot = false;
        record.snapshot.lastForwardedAt = this.now();
        return { injected: true, reason: 'current-frame' };
      }
      return { injected: false, reason: 'inject-failed' };
    }
    if (injectCurrent && !latest) {
      return { injected: false, reason: 'no-fresh-frame' };
    }
    return { injected: false, reason: 'vision-off' };
  }

  /**
   * Called when the user sends a TEXT message on the live socket — keeps
   * the model's view honest at question time without flooding context.
   */
  public onTextArrived(authorizationId: string, text: string): ScreenVisionInjectOutcome {
    const record = this.channels.get(authorizationId);
    if (!record || !record.snapshot.active) {
      // v1.8.0 — SCREEN MEMORY BRIDGE: "remember what was on my screen?"
      // keeps working AFTER the share stopped (digest log outlives the
      // channel, and the live session may still be connected).
      return this.tryInjectScreenMemory(authorizationId, text, 'not-sharing');
    }
    if (!looksScreenRelated(text)) {
      return this.tryInjectScreenMemory(authorizationId, text, 'not-screen-related');
    }
    const session = this.sessions.get(authorizationId);
    if (!session || !session.isActive()) {
      return { injected: false, reason: 'no-session' };
    }

    if (record.snapshot.paused) {
      const ok = this.injectContextParts(authorizationId, [
        { text: '[Reminder: screen sharing is PAUSED — you cannot see the user\'s screen right now.]' },
      ]);
      return { injected: ok, reason: 'paused-note' };
    }

    if (!record.snapshot.visionMode) {
      // Vision OFF: one-shot frames ride the live socket itself, in order.
      return this.tryInjectScreenMemory(authorizationId, text, 'vision-off');
    }

    const now = this.now();
    const stale =
      record.snapshot.lastForwardedAt === null ||
      now - record.snapshot.lastForwardedAt > SCREEN_VISION_LIMITS.staleFrameMs;
    if (!stale) {
      // Fresh frame flowing — but a PAST-screen question still wants the
      // digest log (the model only ever saw the newest two frames).
      return this.tryInjectScreenMemory(authorizationId, text, 'fresh-enough');
    }
    const latest = this.latestFreshFrame(record);
    if (!latest) {
      return { injected: false, reason: 'no-fresh-frame' };
    }
    const ok = this.injectFrameWithContext(
      authorizationId,
      latest,
      '[Current screen, refreshed at question time.]',
    );
    if (ok) {
      record.snapshot.lastForwardedAt = now;
      return { injected: true, reason: 'stale-refresh' };
    }
    return { injected: false, reason: 'inject-failed' };
  }

  /**
   * v1.8.0 — OCR pass on an accepted frame. Interval-gated and
   * single-flight per channel; results land on the record (fresh text) and
   * in the per-user screen memory (deduped digest). The PROMISE is never
   * awaited by callers — OCR must not delay frame forwarding.
   */
  private maybeRunOcr(authorizationId: string, record: ChannelRecord, frame: ScreenVisionFrame): void {
    if (!this.ocr) return;
    if (record.ocrInFlight) return;
    const now = this.now();
    // v1.8.1 — the interval is per-channel (client-selectable, live).
    if (now - record.lastOcrStartedAt < record.snapshot.ocrIntervalMs) return;
    record.ocrInFlight = true;
    record.lastOcrStartedAt = now;
    this.ocr
      .extract(frame.data)
      .then((extraction) => {
        // Channel may have died while OCR ran — drop the result silently.
        const still = this.channels.get(authorizationId);
        if (still !== record || !record.snapshot.active) return;
        if (extraction && typeof extraction.text === 'string' && extraction.text.length > 0) {
          record.lastOcr = { text: extraction.text, at: this.now() };
          // Screen memory bridge: digest each DISTINCT screen state.
          this.screenMemory(authorizationId).record({
            at: this.now(),
            source: record.snapshot.source,
            digest: extraction.text,
          });
          this.notifyChannelState(record, 'ocr');
        }
      })
      .catch(() => {
        // Engine failure is non-fatal: no lastOcr update, next eligible
        // frame retries. (Logged upstream by the engine if it wants.)
      })
      .finally(() => {
        record.ocrInFlight = false;
      });
  }

  /** v1.8.0 — share-ended persistence callback (never throws). */
  private emitShareEnded(authorizationId: string, record: ChannelRecord, reason: string): void {
    if (!this.onShareEnded) return;
    try {
      const memory = this.memories.get(authorizationId);
      this.onShareEnded({
        authorizationId,
        source: record.snapshot.source,
        startedAt: record.snapshot.startedAt,
        endedAt: this.now(),
        digest: memory?.latestDigest() ?? null,
        ...(reason ? { reason } : {}),
      });
    } catch {
      // Persistence is best-effort — a failing callback must never break
      // the share teardown path.
    }
  }

  /**
   * v1.8.0 — answers "what was on my screen (earlier / before / remember)"
   * from the per-user screen memory log. Injects at most once per
   * minInjectIntervalMs so follow-up chatter never re-quotes the digest.
   * Returns the fallback outcome when nothing applies.
   */
  private tryInjectScreenMemory(
    authorizationId: string,
    text: string,
    fallbackReason: string,
  ): ScreenVisionInjectOutcome {
    if (!looksLikeScreenMemoryQuestion(text)) {
      return { injected: false, reason: fallbackReason };
    }
    const session = this.sessions.get(authorizationId);
    if (!session || !session.isActive()) {
      return { injected: false, reason: fallbackReason };
    }
    const memory = this.memories.get(authorizationId);
    const context = memory ? memory.formatContext() : '';
    if (!context) {
      return { injected: false, reason: fallbackReason };
    }
    const now = this.now();
    const lastInjected = this.lastMemoryInjectedAt.get(authorizationId) ?? 0;
    if (now - lastInjected < SCREEN_MEMORY_LIMITS.minInjectIntervalMs) {
      return { injected: false, reason: 'memory-throttled' };
    }
    const ok = this.injectContextParts(authorizationId, [
      {
        text:
          `[Screen memory — OCR digests of what was on the user's screen recently (oldest first, newest last):
${context}
` +
          'The user is asking about an EARLIER screen. Answer from these digests; do not confuse them with the current screen.]',
      },
    ]);
    if (ok) {
      this.lastMemoryInjectedAt.set(authorizationId, now);
      return { injected: true, reason: 'screen-memory' };
    }
    return { injected: false, reason: 'inject-failed' };
  }

  /**
   * LOCAL MODE honesty: Ollama turns cannot see images. When the user is
   * sharing and asks something screen-related, prepend this hint so the
   * local model says so instead of inventing an answer.
   *
   * v1.8.0 — with OCR running, the local engine now gets the VISIBLE TEXT
   * of the shared screen too, so "read the visible text" / "what does this
   * error say" honestly WORKS in local mode (text-only vision).
   */
  public localModeScreenHint(authorizationId: string, text?: string): string | null {
    const record = this.channels.get(authorizationId);
    if (!record || !record.snapshot.active) return null;
    if (typeof text === 'string' && text.length > 0 && !looksScreenRelated(text)) return null;
    const now = this.now();
    const freshOcr =
      record.lastOcr && now - record.lastOcr.at <= SCREEN_OCR_LIMITS.maxLocalHintAgeMs
        ? record.lastOcr.text.slice(0, 1_200)
        : null;
    if (freshOcr && freshOcr.length >= SCREEN_OCR_LIMITS.minUsefulChars) {
      return (
        '[Screen-context note: the user is screen-sharing in the SERA UI. The local engine cannot see images, ' +
        'but OCR of the current screen found this visible text — use it to answer text questions about the screen:\n' +
        `"""${freshOcr}"""\n` +
        'For anything visual (layout, colors, images, thumbnails), tell them full screen vision needs Online Mode (Gemini), or use the inspectScreen tool.]'
      );
    }
    return (
      '[Screen-context note: the user is screen-sharing in the SERA UI, but the local engine cannot see images. ' +
      'If they ask about their screen, tell them screen vision needs Online Mode (Gemini), or use the inspectScreen tool.]'
    );
  }

  public getChannelSnapshot(authorizationId: string): ScreenVisionChannelSnapshot | null {
    const record = this.channels.get(authorizationId);
    return record ? { ...record.snapshot } : null;
  }

  public status(): {
    channels: number;
    activeSessions: number;
    framesForwarded: number;
    framesBuffered: number;
    framesDropped: number;
  } {
    let framesForwarded = 0;
    let framesBuffered = 0;
    let framesDropped = 0;
    for (const record of this.channels.values()) {
      framesForwarded += record.snapshot.framesForwarded;
      framesBuffered += record.snapshot.framesBuffered;
      framesDropped += record.snapshot.framesDropped;
    }
    return {
      channels: this.channels.size,
      activeSessions: this.sessions.size,
      framesForwarded,
      framesBuffered,
      framesDropped,
    };
  }

  // ── internals ─────────────────────────────────────────────────────

  private sessionCanReceive(authorizationId: string): boolean {
    const session = this.sessions.get(authorizationId);
    return Boolean(session && session.isActive());
  }

  private sendMediaToSession(authorizationId: string, frame: ScreenVisionFrame): boolean {
    const session = this.sessions.get(authorizationId);
    if (!session) return false;
    try {
      return session.sendMedia(frame) !== false;
    } catch {
      return false;
    }
  }

  private injectFrameWithContext(
    authorizationId: string,
    frame: ScreenVisionFrame,
    note: string,
  ): boolean {
    const record = this.channels.get(authorizationId);
    const parts: Array<Record<string, unknown>> = [
      { inlineData: { mimeType: frame.mimeType, data: frame.data } },
      { text: note },
    ];
    // v1.8.0 — ULTRA-PRECISE READING: quote the OCR text of the visible
    // screen next to the image so the model reads exact strings (URLs,
    // identifiers, numbers) instead of squinting at pixels.
    if (record) {
      const ocrPart = this.freshOcrContextPart(record);
      if (ocrPart) parts.push(ocrPart);
    }
    return this.injectContextParts(authorizationId, parts);
  }

  /** Builds the OCR context part when the extraction is fresh enough. */
  private freshOcrContextPart(record: ChannelRecord): Record<string, unknown> | null {
    if (!record.lastOcr) return null;
    const age = this.now() - record.lastOcr.at;
    if (age > SCREEN_OCR_LIMITS.maxContextAgeMs) return null;
    const text = record.lastOcr.text.slice(0, SCREEN_OCR_LIMITS.maxContextChars);
    if (text.trim().length < SCREEN_OCR_LIMITS.minUsefulChars) return null;
    return {
      text:
        `[OCR — the exact visible text on this screen (high precision, matches the image above):
"""${text}"""\nUse this text for exact readings: URLs, code identifiers, error messages, numbers.]`,
    };
  }

  private injectContextParts(
    authorizationId: string,
    parts: Array<Record<string, unknown>>,
  ): boolean {
    const session = this.sessions.get(authorizationId);
    if (!session || !session.isActive()) return false;
    try {
      return (
        session.injectContext({
          turns: [{ role: 'user', parts }],
          turnComplete: false,
        }) !== false
      );
    } catch {
      return false;
    }
  }

  private latestFreshFrame(record: ChannelRecord): ScreenVisionFrame | null {
    if (record.ring.length === 0) return null;
    const latest = record.ring[record.ring.length - 1];
    if (this.now() - latest.at > SCREEN_VISION_LIMITS.maxFrameAgeMs) return null;
    return latest;
  }

  private notifyChannelState(record: ChannelRecord, reason: string): void {
    record.snapshot.streaming =
      record.snapshot.active &&
      record.snapshot.visionMode &&
      !record.snapshot.paused &&
      this.sessionCanReceive(record.snapshot.authorizationId);
    try {
      record.notify({
        type: 'screen_channel_state',
        active: record.snapshot.active,
        visionMode: record.snapshot.visionMode,
        paused: record.snapshot.paused,
        streaming: record.snapshot.streaming,
        // v1.8.0 — honest OCR telemetry for the dock (chars readable).
        ocrChars: record.lastOcr ? record.lastOcr.text.length : 0,
        // v1.8.1 — the live OCR interval, so the UI echoes server truth.
        ocrIntervalMs: record.snapshot.ocrIntervalMs,
        reason,
      });
    } catch { /* client socket dying — state stays internal */ }
  }
}
