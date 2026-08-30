/**
 * v1.6.10 — Discord-style live screen share tests.
 *
 * Field failure driving this file (v1.6.9 server log, session
 * 1788032309352): screen.startSharing executed "successfully" but NOTHING
 * streamed — the model got one screenshot and stayed blind, and every
 * screenshot that DID go out as a 400-700KB PNG inlineData was followed by
 * Google killing the session 3-10s later. These tests pin the two halves
 * of the fix:
 *
 *  1. encodeFrameForLiveWire — JPEG (not PNG) wire images at a hard byte cap.
 *  2. LiveScreenShareFeed — continuous changed-frame feed with idle-skip,
 *     error auto-stop, and session-death stop.
 */
import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import {
  encodeFrameForLiveWire,
  frameSignature,
  signatureDiff,
  LiveWireImage,
} from '../vision/screenImage';
import { LiveScreenShareFeed } from '../vision/liveScreenShare';
import type { ScreenFrame } from '../actions/ControlProviders';

function makePngFrame(width: number, height: number, variant: number): ScreenFrame {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      // Blocky desktop-like content; `variant` shifts the palette so two
      // frames of different variants clearly differ, and two frames of the
      // same variant are byte-identical.
      const block = ((x >> 4) * 7 + (y >> 4) * 13) % 5;
      png.data[idx] = (30 + block * 12 + variant * 25) % 256;
      png.data[idx + 1] = (120 + block * 8 + variant * 9) % 256;
      png.data[idx + 2] = (200 - block * 15 + variant * 17) % 256;
      png.data[idx + 3] = 255;
    }
  }
  return {
    format: 'png',
    data: PNG.sync.write(png).toString('base64'),
    width,
    height,
    capturedAt: new Date().toISOString(),
  } as unknown as ScreenFrame;
}

const JPEG_SOI = 0xffd8; // JPEG starts with FFD8

function isJpegBase64(base64: string): boolean {
  const head = Buffer.from(base64, 'base64').subarray(0, 2);
  return head[0] === (JPEG_SOI >> 8) && head[1] === (JPEG_SOI & 0xff);
}

describe('encodeFrameForLiveWire (v1.6.10 JPEG wire path)', () => {
  it('produces a JPEG under the byte cap from a desktop-like PNG frame', () => {
    const image = encodeFrameForLiveWire(makePngFrame(1536, 960, 1), { maxDimension: 1024, quality: 60, maxBytes: 160_000 });
    expect(image).not.toBeNull();
    expect(image!.mimeType).toBe('image/jpeg');
    expect(isJpegBase64(image!.data)).toBe(true);
    expect(image!.bytes).toBeLessThanOrEqual(160_000);
    // The v1.6.9 log's lethal screenshots were 482-566KB as PNG. The same
    // content as a wire JPEG must be a small fraction of that.
    expect(image!.bytes).toBeLessThan(200_000);
    expect(Math.max(image!.width, image!.height)).toBeLessThanOrEqual(1024);
  });

  it('returns null on corrupt / empty frames instead of throwing', () => {
    expect(encodeFrameForLiveWire({ format: 'png', data: 'not-a-png', width: 10, height: 10 } as unknown as ScreenFrame)).toBeNull();
    expect(encodeFrameForLiveWire({ format: 'png', data: '', width: 0, height: 0 } as unknown as ScreenFrame)).toBeNull();
  });

  it('downscales to the requested max dimension', () => {
    const image = encodeFrameForLiveWire(makePngFrame(2560, 1440, 2), { maxDimension: 768, quality: 60, maxBytes: 400_000 });
    expect(image).not.toBeNull();
    expect(Math.max(image!.width, image!.height)).toBeLessThanOrEqual(768);
  });
});

describe('frameSignature / signatureDiff (change detection)', () => {
  it('scores identical frames ~0 and different frames clearly higher', () => {
    const a = encodeFrameForLiveWire(makePngFrame(640, 400, 3), { quality: 60, maxBytes: 400_000 })!;
    const a2 = encodeFrameForLiveWire(makePngFrame(640, 400, 3), { quality: 60, maxBytes: 400_000 })!;
    const b = encodeFrameForLiveWire(makePngFrame(640, 400, 9), { quality: 60, maxBytes: 400_000 })!;

    const sigA = frameSignature(a.data, 'image/jpeg')!;
    const sigA2 = frameSignature(a2.data, 'image/jpeg')!;
    const sigB = frameSignature(b.data, 'image/jpeg')!;

    const sameDiff = signatureDiff(sigA, sigA2);
    const otherDiff = signatureDiff(sigA, sigB);
    // JPEG noise alone must stay under the feed's change threshold…
    expect(sameDiff).toBeLessThan(1.2);
    // …while a genuinely different screen must cross it.
    expect(otherDiff).toBeGreaterThan(sameDiff * 3);
  });
});

function makeFeed(overrides?: {
  frames?: Array<ScreenFrame | null>;
  sendResults?: Array<boolean>;
}) {
  const sentImages: LiveWireImage[] = [];
  const stateEvents: Array<{ active: boolean; reason?: string }> = [];
  const frames = overrides?.frames ?? [];
  const sendResults = overrides?.sendResults ?? [];
  let frameIndex = 0;
  let sendIndex = 0;
  const feed = new LiveScreenShareFeed(
    {
      capture: () => (frameIndex < frames.length ? frames[frameIndex++] : null),
      send: (image) => {
        sentImages.push(image);
        const result = sendIndex < sendResults.length ? sendResults[sendIndex++] : true;
        return result;
      },
      onStateChange: (event) => stateEvents.push(event),
    },
    { intervalMs: 1, maxConsecutiveErrors: 3, changeThreshold: 1.2 },
  );
  return { feed, sentImages, stateEvents };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('LiveScreenShareFeed (v1.6.10 Discord-style feed)', () => {
  it('sends changed frames and SKIPS identical ones (idle screen costs nothing)', async () => {
    const frame1 = makePngFrame(640, 400, 1);
    const frame2 = makePngFrame(640, 400, 1); // identical content
    const frame3 = makePngFrame(640, 400, 5); // user did something
    const { feed, sentImages, stateEvents } = makeFeed({ frames: [frame1, frame2, frame3] });

    feed.start();
    await wait(700); // 3 ticks @50ms floor + ~30ms JPEG encode each
    feed.stop('test_done');

    expect(stateEvents.some((e) => e.active)).toBe(true);
    expect(stateEvents.some((e) => !e.active)).toBe(true);
    // First + third frames sent, the identical second one skipped.
    expect(sentImages.length).toBe(2);
    const { framesSent, framesSkipped } = feed.stats;
    expect(framesSent).toBe(2);
    expect(framesSkipped).toBeGreaterThanOrEqual(1);
  });

  it('stops itself when the session can no longer accept frames', async () => {
    const frame1 = makePngFrame(640, 400, 1);
    const { feed, stateEvents } = makeFeed({ frames: [frame1, frame1, frame1], sendResults: [false] });

    feed.start();
    await wait(700);
    feed.stop('test_done');

    expect(stateEvents.filter((e) => !e.active).some((e) => e.reason === 'session_closed')).toBe(true);
  });

  it('gives up after repeated capture failures instead of spinning forever', async () => {
    const { feed, stateEvents } = makeFeed({ frames: [null, null, null] });

    feed.start();
    await wait(600); // 3 failures @50ms floor
    feed.stop('test_done');

    expect(stateEvents.filter((e) => !e.active).some((e) => e.reason === 'capture_failures')).toBe(true);
  });

  it('stop() is idempotent and reports stats', () => {
    const { feed, stateEvents } = makeFeed();
    feed.start();
    feed.stop('user_stop');
    feed.stop('user_stop_again');
    // Exactly one OFF event despite the double stop.
    expect(stateEvents.filter((e) => !e.active)).toHaveLength(1);
  });
});
