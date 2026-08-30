import { ScreenFrame } from '../actions/ControlProviders';
import {
  encodeFrameForLiveWire,
  frameSignature,
  signatureDiff,
  LiveWireImage,
} from './screenImage';

/**
 * v1.6.10 — Discord-style LIVE screen share for Gemini Live sessions.
 *
 * THE FIELD PROBLEM (user, v1.6.9): "I want it to start the screen share
 * just like Discord — I just want him to see live." The old flow had SERA
 * take ONE screenshot per request; screen.startSharing only refreshed an
 * in-memory frame cache nothing ever streamed. The model stayed blind
 * after its first look.
 *
 * THE FIX: a server-side frame feed. While sharing is active the feed
 * captures the screen ~once per second, JPEG-encodes the frame small
 * (60-150KB), skips frames whose perceptual signature matches the last
 * sent one (a static screen costs NOTHING, exactly like Discord pauses
 * video on a static scene), and pushes changed frames into the Gemini
 * Live session through the realtimeInput media channel — the wire path
 * Google designed for continuous vision. The model now SEES the screen
 * continuously and can talk about what is happening as it happens.
 *
 * SAFETY: every frame is JPEG (not PNG) via encodeFrameForLiveWire;
 * capture/encode errors never throw out of the feed; 5 consecutive
 * failures or a hard 15-minute ceiling stop the feed cleanly; the feed
 * always dies with its session (server.ts stops it on every close path).
 */

export interface LiveScreenShareFrameInfo {
  width: number;
  height: number;
  bytes: number;
  /** True when the frame was actually pushed to the model (screen changed). */
  sent: boolean;
}

export interface LiveScreenShareStateEvent {
  active: boolean;
  reason?: string;
  fps?: number;
  framesSent?: number;
  framesSkipped?: number;
}

export interface LiveScreenShareFeedOptions {
  /** Target interval between capture attempts. Default 1200ms (~0.8fps). */
  intervalMs?: number;
  /** Long-edge cap for fed frames. Default 1024px. */
  maxDimension?: number;
  /** JPEG quality. Default 60. */
  quality?: number;
  /** Hard per-frame byte ceiling. Default 160KB. */
  maxFrameBytes?: number;
  /**
   * Signature diff below which a frame counts as "unchanged" and is NOT
   * sent. 0-255 scale, mean per cell. Default 1.2 — cursor blinks and
   * video content cross it, idle desktops do not.
   */
  changeThreshold?: number;
  /** Safety ceiling — sharing auto-stops after this long. Default 15 min. */
  maxDurationMs?: number;
  /** Consecutive capture/encode failures before the feed gives up. */
  maxConsecutiveErrors?: number;
}

export interface LiveScreenShareFeedHooks {
  /** Captures one screen frame. Throwing is allowed — the feed counts errors. */
  capture: () => Promise<ScreenFrame | null> | ScreenFrame | null;
  /**
   * Sends one frame to the live model. Return false (or throw) when the
   * session can no longer accept frames — the feed stops itself.
   */
  send: (image: LiveWireImage) => boolean | void;
  /** Notified on every start/stop so the server can mirror state to the UI. */
  onStateChange?: (event: LiveScreenShareStateEvent) => void;
  /** Optional per-frame telemetry hook (kept out of the console by default). */
  onFrame?: (info: LiveScreenShareFrameInfo) => void;
}

const DEFAULTS = {
  intervalMs: 1200,
  maxDimension: 1024,
  quality: 60,
  maxFrameBytes: 160_000,
  changeThreshold: 1.2,
  maxDurationMs: 15 * 60 * 1000,
  maxConsecutiveErrors: 5,
};

export class LiveScreenShareFeed {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stoppedReason: string | null = null;

  private framesSent = 0;
  private framesSkipped = 0;
  private consecutiveErrors = 0;

  private lastSignature: Uint8Array | null = null;
  private startedAt = 0;

  constructor(
    private readonly hooks: LiveScreenShareFeedHooks,
    private readonly options: LiveScreenShareFeedOptions = {},
  ) {}

  public get isActive(): boolean {
    return this.running;
  }

  public get stats(): { framesSent: number; framesSkipped: number } {
    return { framesSent: this.framesSent, framesSkipped: this.framesSkipped };
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.stoppedReason = null;
    this.framesSent = 0;
    this.framesSkipped = 0;
    this.consecutiveErrors = 0;
    this.lastSignature = null;
    this.startedAt = Date.now();
    this.hooks.onStateChange?.({ active: true, fps: this.fps() });
    // First frame goes out immediately, then on the interval.
    void this.tick();
  }

  public stop(reason = 'stopped'): void {
    if (!this.running && !this.timer) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const wasReason = this.stoppedReason ?? reason;
    this.hooks.onStateChange?.({
      active: false,
      reason: wasReason,
      framesSent: this.framesSent,
      framesSkipped: this.framesSkipped,
    });
  }

  private fps(): number {
    // Floor matches scheduleNext's clamp — see the note there.
    const interval = Math.max(50, this.options.intervalMs ?? DEFAULTS.intervalMs);
    return Math.round((1000 / interval) * 10) / 10;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    // Hard duration ceiling — never share longer than maxDurationMs.
    if (Date.now() - this.startedAt > (this.options.maxDurationMs ?? DEFAULTS.maxDurationMs)) {
      this.stop('max_duration_reached');
      return;
    }
    // 50ms floor: prevents a misconfigured hot loop without making tests
    // crawl. Production runs at 1200ms — far above the floor.
    const interval = Math.max(50, this.options.intervalMs ?? DEFAULTS.intervalMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, interval);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    let frame: ScreenFrame | null = null;
    try {
      frame = await this.hooks.capture();
    } catch {
      frame = null;
    }

    if (!frame) {
      this.consecutiveErrors += 1;
      if (this.consecutiveErrors >= (this.options.maxConsecutiveErrors ?? DEFAULTS.maxConsecutiveErrors)) {
        this.stop('capture_failures');
        return;
      }
      this.scheduleNext();
      return;
    }

    const image = encodeFrameForLiveWire(frame, {
      maxDimension: this.options.maxDimension ?? DEFAULTS.maxDimension,
      quality: this.options.quality ?? DEFAULTS.quality,
      maxBytes: this.options.maxFrameBytes ?? DEFAULTS.maxFrameBytes,
    });

    if (!image) {
      this.consecutiveErrors += 1;
      if (this.consecutiveErrors >= (this.options.maxConsecutiveErrors ?? DEFAULTS.maxConsecutiveErrors)) {
        this.stop('encode_failures');
        return;
      }
      this.scheduleNext();
      return;
    }
    this.consecutiveErrors = 0;

    // Change detection: skip frames that look identical to the last SENT
    // frame. This is what makes the feed safe for long sessions — an idle
    // screen costs zero bandwidth and zero Gemini quota.
    const signature = frameSignature(image.data, image.mimeType);
    if (signature && this.lastSignature) {
      const diff = signatureDiff(signature, this.lastSignature);
      if (diff < (this.options.changeThreshold ?? DEFAULTS.changeThreshold)) {
        this.framesSkipped += 1;
        this.hooks.onFrame?.({ width: image.width, height: image.height, bytes: image.bytes, sent: false });
        this.scheduleNext();
        return;
      }
    }

    let accepted = true;
    try {
      accepted = this.hooks.send(image) !== false;
    } catch {
      accepted = false;
    }
    if (!accepted) {
      this.stop('session_closed');
      return;
    }

    this.framesSent += 1;
    if (signature) this.lastSignature = signature;
    this.hooks.onFrame?.({ width: image.width, height: image.height, bytes: image.bytes, sent: true });
    this.scheduleNext();
  }
}
