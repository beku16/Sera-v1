/**
 * Regression tests for the v1.6.9 "see my screen kills the session" fix.
 *
 * Field failure: full-resolution screenshots (1-4MB base64) were inlined
 * as-is into Gemini Live function responses; Google then tore the session
 * down 15-20s later (empty close frame, client socket still open). The
 * server now routes every image through shrinkPngBase64 before the wire.
 */
import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { shrinkPngBase64 } from '../vision/screenImage';

function makePngBase64(width: number, height: number, style: 'flat' | 'screenlike'): string {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      if (style === 'screenlike') {
        // Realistic desktop capture: blocky UI shapes + text-like grain
        // confined to "text line" bands, leaving large flat UI areas —
        // the structure real screenshots compress well.
        const block = ((x >> 4) * 7 + (y >> 4) * 13) % 5;
        const accent = ((x >> 7) + (y >> 6)) % 3 === 0;
        const textBand = (y >> 3) % 3 === 0 && x % 3 !== 0;
        const grain = textBand ? (x * 31 + y * 17) % 37 : 0;
        png.data[idx] = (accent ? 30 + block * 12 : 240 - block * 20) + grain;
        png.data[idx + 1] = (accent ? 120 + block * 8 : 128 - block * 10) + grain;
        png.data[idx + 2] = (accent ? 200 - block * 15 : 60 + block * 25) + grain;
        png.data[idx + 3] = 255;
      } else {
        png.data[idx] = 200;
        png.data[idx + 1] = 100;
        png.data[idx + 2] = 50;
        png.data[idx + 3] = 255;
      }
    }
  }
  return PNG.sync.write(png).toString('base64');
}

describe('shrinkPngBase64 (v1.6.9 live-wire screenshot cap)', () => {
  it('re-encodes small images instead of passing them through (v1.6.10: the pass-through leaked 482-700KB PNGs to the wire)', () => {
    const small = makePngBase64(320, 240, 'flat');
    const out = shrinkPngBase64(small, { maxDimension: 1280, maxBytes: 700_000 });
    expect(out).not.toBeNull();
    // Still a valid PNG at the same (under-cap) dimensions after re-encode.
    const decoded = PNG.sync.read(Buffer.from(out!, 'base64'));
    expect(decoded.width).toBe(320);
    expect(decoded.height).toBe(240);
  });

  it('downscales oversized images to the max dimension', () => {
    const big = makePngBase64(2560, 1440, 'screenlike');
    const inputBytes = Buffer.byteLength(big, 'base64');
    expect(inputBytes).toBeGreaterThan(700_000);
    const out = shrinkPngBase64(big, { maxDimension: 1280, maxBytes: 700_000 });
    expect(out).not.toBeNull();
    const decoded = PNG.sync.read(Buffer.from(out!, 'base64'));
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(1280);
    const outBytes = Buffer.byteLength(out!, 'base64');
    // A screen-like desktop capture shrinks a lot; assert real reduction
    // rather than an exact ratio (deflate results vary).
    expect(outBytes).toBeLessThan(inputBytes);
  });

  it('returns null instead of throwing on corrupt input (session must survive)', () => {
    expect(shrinkPngBase64('definitely-not-a-png')).toBeNull();
    expect(shrinkPngBase64('')).toBeNull();
  });

  it('returns null when even the shrunk image exceeds maxBytes', () => {
    const huge = makePngBase64(2000, 2000, 'flat');
    expect(shrinkPngBase64(huge, { maxDimension: 1280, maxBytes: 1 })).toBeNull();
  });
});
