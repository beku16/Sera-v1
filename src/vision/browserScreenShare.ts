/**
 * v1.7.0 — BROWSER screen capture engine (client side).
 *
 * THE FEATURE: a REAL screen sharing system built on the browser Screen
 * Capture API. `start()` calls navigator.mediaDevices.getDisplayMedia() —
 * the browser shows its native picker (Entire Screen / Application
 * Window / Browser Tab), the user picks one, and this controller:
 *
 *   1. keeps the MediaStream alive in a hidden <video> (the live preview
 *      is this exact element, mounted by the UI),
 *   2. captures a frame every few seconds (rVFC-driven when available —
 *      fires only when the captured surface actually changes — with a
 *      timer fallback),
 *   3. downscales to ≤1152px long edge and JPEG-encodes it (~60-150KB),
 *   4. compares a cheap perceptual signature against the last SENT frame
 *      — a static screen sends NOTHING (privacy + quota friendly, the
 *      same trick the v1.6.10 server feed uses),
 *   5. hands every changed frame to the callback, which forwards it to
 *      SERA's screen-vision channel and from there into Gemini.
 *
 * GRACEFUL HANDLING is the point: permission denied, no monitor selected,
 * unsupported browser, insecure context, the user clicking Chrome's
 * "Stop sharing" bar (track onended), and a video that stalls mid-share
 * are all typed, non-throwing states the UI can render honestly.
 */

export type ScreenShareErrorKind =
  | 'unsupported'
  | 'insecure-context'
  | 'permission-denied'
  | 'aborted'
  | 'no-monitor'
  | 'capture-failed'
  | 'not-active';

export class ScreenShareError extends Error {
  constructor(
    public readonly kind: ScreenShareErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ScreenShareError';
  }
}

export interface CapturedScreenFrame {
  /** Base64 JPEG payload (no data: prefix). */
  data: string;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  /** Decoded byte size of the JPEG. */
  bytes: number;
  at: number;
}

export interface BrowserScreenShareStats {
  framesSent: number;
  framesSkipped: number;
  lastFrameBytes: number;
  lastFrameAt: number | null;
  startedAt: number | null;
}

export type ScreenShareSourceKind = 'monitor' | 'window' | 'browser' | 'unknown';

export interface BrowserScreenShareState {
  active: boolean;
  paused: boolean;
  /** 'monitor' | 'window' | 'browser' when the browser labels the track. */
  source: ScreenShareSourceKind;
  /** Track label from the browser, e.g. "Entire Screen" / "SERA — Google Chrome". */
  label: string;
}

export interface BrowserScreenShareOptions {
  /** Target interval between capture attempts. Default 2500ms. */
  intervalMs?: number;
  /** Long-edge cap for captured frames. Default 1152px. */
  maxDimension?: number;
  /** JPEG quality (0-1). Default 0.62. */
  quality?: number;
  /** Hard per-frame decoded byte ceiling. Default 160KB. */
  maxFrameBytes?: number;
  /**
   * Mean per-cell signature diff below which a frame counts as unchanged
   * and is NOT emitted. Default 2.2.
   */
  changeThreshold?: number;
  now?: () => number;
}

export interface BrowserScreenShareHooks {
  /** A CHANGED frame, JPEG-compressed and ready for the wire. */
  onFrame: (frame: CapturedScreenFrame) => void;
  onStateChange: (state: BrowserScreenShareState, reason: string) => void;
  onError: (error: ScreenShareError) => void;
}

const DEFAULTS = {
  intervalMs: 2500,
  maxDimension: 1152,
  quality: 0.62,
  maxFrameBytes: 160_000,
  changeThreshold: 2.2,
  /** Safety net: a picker that never answers resets the UI instead of wedging it. */
  pickerTimeoutMs: 120_000,
};

// Note: requestVideoFrameCallback is present in the current lib.dom
// HTMLVideoElement definition; we still feature-detect before using it
// because older browsers (and jsdom) lack the method at runtime.
export function screenShareSupport(): {
  supported: boolean;
  reason?: ScreenShareErrorKind;
} {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
    return { supported: false, reason: 'unsupported' };
  }
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return { supported: false, reason: 'insecure-context' };
  }
  return { supported: true };
}

/** Maps a raw getDisplayMedia rejection to a typed, user-faced error. */
export function toScreenShareError(err: unknown): ScreenShareError {
  // Already typed (e.g. the picker timeout) — never re-wrap.
  if (err instanceof ScreenShareError) return err;
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'NotAllowedError' || /permission|denied|not allowed/i.test(message)) {
    return new ScreenShareError(
      'permission-denied',
      'Screen permission was denied. Click Share Screen again and allow the picker.',
    );
  }
  if (name === 'AbortError' || /aborted?$/i.test(message)) {
    return new ScreenShareError('aborted', 'Screen selection was cancelled.');
  }
  if (name === 'NotFoundError' || /no matching|not found|no monitor|no surface/i.test(message)) {
    return new ScreenShareError('no-monitor', 'No screen or window was selected.');
  }
  if (name === 'NotSupportedError' || /not supported/i.test(message)) {
    return new ScreenShareError('unsupported', 'This browser cannot capture the screen. Use Chrome, Edge, or Firefox on desktop.');
  }
  return new ScreenShareError('capture-failed', `Screen capture failed: ${message.slice(0, 160)}`);
}

export class BrowserScreenShareController {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private sigCanvas: HTMLCanvasElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private rvcHandle: number | null = null;
  private pickerTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSignature: Uint8Array | null = null;
  private lastCaptureAt = 0;
  private state: BrowserScreenShareState = {
    active: false,
    paused: false,
    source: 'unknown',
    label: '',
  };
  private stats: BrowserScreenShareStats = {
    framesSent: 0,
    framesSkipped: 0,
    lastFrameBytes: 0,
    lastFrameAt: null,
    startedAt: null,
  };
  private disposed = false;

  constructor(
    private readonly hooks: BrowserScreenShareHooks,
    private readonly options: BrowserScreenShareOptions = {},
  ) {}

  private get intervalMs(): number {
    return this.options.intervalMs ?? DEFAULTS.intervalMs;
  }

  private get now(): number {
    return this.options.now?.() ?? Date.now();
  }

  public get isActive(): boolean {
    return this.state.active;
  }

  public get isPaused(): boolean {
    return this.state.paused;
  }

  public getState(): BrowserScreenShareState {
    return { ...this.state };
  }

  public getStats(): BrowserScreenShareStats {
    return { ...this.stats };
  }

  /** The live MediaStream — the UI mounts it on a <video> for the preview. */
  public getStream(): MediaStream | null {
    return this.stream;
  }

  // ── lifecycle ─────────────────────────────────────────────────────

  public async start(): Promise<void> {
    if (this.disposed) throw new ScreenShareError('not-active', 'Controller was disposed.');
    const support = screenShareSupport();
    if (!support.supported) {
      const supportError =
        support.reason === 'insecure-context'
          ? new ScreenShareError('insecure-context', 'Screen capture needs a secure context — open SERA on localhost or HTTPS.')
          : new ScreenShareError('unsupported', 'This browser cannot share the screen. Use desktop Chrome, Edge, or Firefox.');
      this.hooks.onError(supportError);
      throw supportError;
    }

    let timedOut = false;
    let stream: MediaStream;
    const capturePromise: Promise<MediaStream> = navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 5, max: 8 },
      },
      audio: false,
      // Chrome: let the native stop-bar offer "switch to another surface"
      // alongside our own Switch button; never offer SERA's own tab
      // (infinite mirror).
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      // The native picker itself offers monitor / window / tab — the
      // three choices the spec calls for.
      preferCurrentTab: false,
    } as DisplayMediaStreamOptions);
    try {
      stream = await Promise.race([
        capturePromise,
        new Promise<never>((_, reject) => {
          // Safety net: some environments (headless Chromium, locked-down
          // webviews) NEVER settle the picker promise — without this the
          // button would sit on "PICK A SCREEN…" forever. Real users take
          // well under 2 minutes; a hung picker is a bug we recover from.
          this.pickerTimer = setTimeout(() => {
            timedOut = true;
            reject(
              new ScreenShareError(
                'aborted',
                'The screen picker did not respond. Click Share Screen to try again.',
              ),
            );
          }, DEFAULTS.pickerTimeoutMs);
        }),
      ]);
    } catch (err) {
      const typed = toScreenShareError(err);
      this.hooks.onError(typed);
      // If the hung picker LATER resolves after we gave up, kill the stray
      // capture so it can never leak a live screen stream.
      capturePromise
        .then((lateStream) => {
          if (timedOut) this.stopTracks(lateStream);
        })
        .catch(() => undefined);
      throw typed;
    } finally {
      if (this.pickerTimer) {
        clearTimeout(this.pickerTimer);
        this.pickerTimer = null;
      }
    }

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      this.stopTracks(stream);
      const typed = new ScreenShareError('no-monitor', 'No screen or window was selected.');
      this.hooks.onError(typed);
      throw typed;
    }

    // Replace any previous share (switch source path reuses start()).
    this.teardownMedia();

    this.stream = stream;
    this.state = {
      active: true,
      paused: false,
      source: detectSourceKind(videoTrack),
      label: videoTrack.label || '',
    };
    this.stats = {
      framesSent: 0,
      framesSkipped: 0,
      lastFrameBytes: 0,
      lastFrameAt: null,
      startedAt: this.now,
    };
    this.lastSignature = null;
    this.lastCaptureAt = 0;

    // Hidden video pipeline.
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.style.display = 'none';
    this.video = video;
    void video.play().catch(() => undefined); // autoplay of muted video is fine; ignore edge failures
    document.body.appendChild(video);

    // The browser's own "Stop sharing" bar / OS revocation ends the track.
    videoTrack.addEventListener('ended', () => {
      this.stop('track-ended');
    });

    this.hooks.onStateChange(this.getState(), 'started');
    this.beginCaptureLoop();
  }

  /** Pause the outgoing frame feed (preview keeps running, Discord-style). */
  public pause(): void {
    if (!this.state.active || this.state.paused) return;
    this.state.paused = true;
    this.stopCaptureLoop();
    this.hooks.onStateChange(this.getState(), 'paused');
  }

  /** Resume the frame feed from the same captured surface. */
  public resume(): void {
    if (!this.state.active || !this.state.paused) return;
    this.state.paused = false;
    this.lastSignature = null; // force the next frame through (state may have changed while paused)
    this.beginCaptureLoop();
    this.hooks.onStateChange(this.getState(), 'resumed');
  }

  /** Let the user pick a DIFFERENT screen / window / tab mid-share. */
  public async switchSource(): Promise<void> {
    if (!this.state.active) throw new ScreenShareError('not-active', 'Not sharing yet.');
    // start() tears the old media down and rebuilds everything on the new
    // stream — one code path, no drift.
    await this.start();
    this.hooks.onStateChange(this.getState(), 'switched');
  }

  public stop(reason = 'stopped'): void {
    if (!this.state.active) return;
    this.stopCaptureLoop();
    this.teardownMedia();
    this.state = { active: false, paused: false, source: 'unknown', label: '' };
    this.lastSignature = null;
    this.hooks.onStateChange(this.getState(), reason);
  }

  public dispose(): void {
    this.disposed = true;
    this.stop('disposed');
  }

  /**
   * ONE frame RIGHT NOW, bypassing change detection — used when the user
   * asks a screen question with vision mode off. Returns null when the
   * video isn't ready (first ~300ms after start) — the caller retries or
   * answers without a frame, never crashes.
   */
  public captureFrameNow(): CapturedScreenFrame | null {
    if (!this.state.active || !this.video || !this.stream) return null;
    const frame = this.encodeCurrentFrame(true);
    if (frame) {
      this.stats.lastFrameAt = this.now;
      this.stats.lastFrameBytes = frame.bytes;
    }
    return frame;
  }

  // ── capture internals ─────────────────────────────────────────────

  private beginCaptureLoop(): void {
    this.stopCaptureLoop();
    // Primary: requestVideoFrameCallback — fires only when the captured
    // surface produced a new frame (works in background tabs, static
    // screens cost zero work).
    if (this.video && typeof this.video.requestVideoFrameCallback === 'function') {
      const schedule = () => {
        if (!this.state.active || this.state.paused || !this.video) return;
        this.rvcHandle = this.video.requestVideoFrameCallback(() => {
          this.rvcHandle = null;
          this.maybeCapture(false);
          schedule();
        });
      };
      schedule();
      // Safety net for rVFC stalls (defensive — some Linux compositors
      // throttle callbacks on occluded windows).
      this.timer = setInterval(() => this.maybeCapture(false), Math.max(1000, this.intervalMs * 2));
      return;
    }
    // Fallback: plain interval.
    this.timer = setInterval(() => this.maybeCapture(false), this.intervalMs);
    // And capture the first frame as soon as the video has data.
    void this.waitVideoReady().then(() => this.maybeCapture(true));
  }

  private stopCaptureLoop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.rvcHandle !== null && this.video?.cancelVideoFrameCallback) {
      try {
        this.video.cancelVideoFrameCallback(this.rvcHandle);
      } catch { /* already fired */ }
      this.rvcHandle = null;
    }
  }

  private async waitVideoReady(maxMs = 1500): Promise<boolean> {
    const video = this.video;
    if (!video) return false;
    const started = this.now;
    while (this.now - started < maxMs) {
      if (video.readyState >= 2 && video.videoWidth > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return video.readyState >= 2 && video.videoWidth > 0;
  }

  private maybeCapture(force: boolean): void {
    if (!this.state.active || this.state.paused || !this.video) return;
    const at = this.now;
    if (!force && at - this.lastCaptureAt < this.intervalMs) return;
    const frame = this.encodeCurrentFrame(force);
    if (!frame) return;
    this.lastCaptureAt = at;
    this.stats.lastFrameAt = at;
    this.stats.lastFrameBytes = frame.bytes;
    this.hooks.onFrame(frame);
  }

  /**
   * video → downscaled canvas → JPEG (with one quality fallback) →
   * perceptual signature gate. Returns null when the frame is unchanged,
   * the video isn't ready, or encoding fails — never throws.
   */
  private encodeCurrentFrame(force: boolean): CapturedScreenFrame | null {
    const video = this.video;
    if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
      return null;
    }

    const maxDimension = this.options.maxDimension ?? DEFAULTS.maxDimension;
    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    const scale = Math.min(1, maxDimension / Math.max(srcW, srcH));
    const width = Math.max(1, Math.round(srcW * scale));
    const height = Math.max(1, Math.round(srcH * scale));

    if (!this.canvas) this.canvas = document.createElement('canvas');
    const canvas = this.canvas;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    try {
      ctx.drawImage(video, 0, 0, width, height);
    } catch {
      return null; // track mid-teardown
    }

    // Change detection BEFORE the expensive encode: signature from a tiny
    // grayscale grid. Forced captures bypass the GATE (look-NOW requests
    // always emit) but still refresh the baseline so the next identical
    // frame is skipped again.
    const signature = this.computeSignature(ctx, width, height);
    if (signature) {
      if (
        !force &&
        this.lastSignature &&
        signature.length === this.lastSignature.length &&
        meanAbsDiff(signature, this.lastSignature) < (this.options.changeThreshold ?? DEFAULTS.changeThreshold)
      ) {
        this.stats.framesSkipped += 1;
        return null;
      }
      this.lastSignature = signature;
    }

    const quality = this.options.quality ?? DEFAULTS.quality;
    let dataUrl: string;
    try {
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    } catch {
      return null;
    }
    let payload = stripDataUrl(dataUrl);
    let bytes = Math.floor((payload.length * 3) / 4);

    // Byte-ceiling fallback: re-encode harder, then shrink.
    const maxBytes = this.options.maxFrameBytes ?? DEFAULTS.maxFrameBytes;
    if (bytes > maxBytes) {
      try {
        const retry = canvas.toDataURL('image/jpeg', Math.max(0.3, quality - 0.22));
        const retryPayload = stripDataUrl(retry);
        const retryBytes = Math.floor((retryPayload.length * 3) / 4);
        if (retryBytes <= maxBytes) {
          payload = retryPayload;
          bytes = retryBytes;
        } else {
          // Last resort: quarter the resolution — text stays readable at
          // 576px on the long edge for the model's purposes.
          const halfW = Math.max(1, Math.round(width / 2));
          const halfH = Math.max(1, Math.round(height / 2));
          const small = document.createElement('canvas');
          small.width = halfW;
          small.height = halfH;
          const smallCtx = small.getContext('2d');
          if (!smallCtx) return null;
          smallCtx.drawImage(canvas, 0, 0, halfW, halfH);
          const tiny = stripDataUrl(small.toDataURL('image/jpeg', 0.5));
          const tinyBytes = Math.floor((tiny.length * 3) / 4);
          if (tinyBytes > maxBytes) return null;
          payload = tiny;
          bytes = tinyBytes;
        }
      } catch {
        return null;
      }
    }

    this.stats.framesSent += 1;
    return { data: payload, mimeType: 'image/jpeg', width, height, bytes, at: this.now };
  }

  /** Tiny 32-column grayscale luma grid — cheap, stable, no deps. */
  private computeSignature(ctx: CanvasRenderingContext2D, width: number, height: number): Uint8Array | null {
    try {
      const gridX = 32;
      const gridY = Math.max(2, Math.round((32 * height) / width));
      if (!this.sigCanvas) this.sigCanvas = document.createElement('canvas');
      const sigCanvas = this.sigCanvas;
      sigCanvas.width = gridX;
      sigCanvas.height = gridY;
      const sigCtx = sigCanvas.getContext('2d');
      if (!sigCtx) return null;
      sigCtx.drawImage(ctx.canvas, 0, 0, gridX, gridY);
      const { data } = sigCtx.getImageData(0, 0, gridX, gridY);
      const signature = new Uint8Array(gridX * gridY);
      for (let i = 0; i < signature.length; i++) {
        const idx = i * 4;
        // Luma approximation — same weights as the server-side signature.
        signature[i] = Math.round((data[idx] * 2 + data[idx + 1] * 3 + data[idx + 2]) / 6);
      }
      return signature;
    } catch {
      return null;
    }
  }

  private teardownMedia(): void {
    this.stopCaptureLoop();
    if (this.stream) {
      this.stopTracks(this.stream);
      this.stream = null;
    }
    if (this.video) {
      try {
        this.video.srcObject = null;
        if (this.video.parentNode) this.video.parentNode.removeChild(this.video);
      } catch { /* already detached */ }
      this.video = null;
    }
    this.canvas = null;
    this.sigCanvas = null;
  }

  private stopTracks(stream: MediaStream): void {
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch { /* already stopped */ }
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────

function detectSourceKind(track: MediaStreamTrack): ScreenShareSourceKind {
  const label = (track.label || '').toLowerCase();
  if (label.includes('screen') || label.includes('monitor') || label.includes('display')) return 'monitor';
  if (label.includes('tab')) return 'browser';
  if (label.includes('window')) return 'window';
  return 'unknown';
}

export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 255;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

export function stripDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  if (dataUrl.startsWith('data:') && comma > 0) return dataUrl.slice(comma + 1);
  return dataUrl;
}
