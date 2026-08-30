import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { ACTION_ERROR_CODES, ActionError } from '../actions/errors';
import { ScreenFrame } from '../actions/ControlProviders';

/**
 * Convert a robotjs-style raw BGRA bitmap (4 bytes per pixel, byte order
 * B, G, R, A) into a PNG buffer. Used by the Windows screen-capture
 * path (robotjs.screen.capture() returns this format).
 *
 * Throws if the frame isn't a BGRA bitmap — callers that already have
 * a PNG-encoded frame (e.g. the Linux scrot path returns base64 PNG
 * directly) should use `frameToPng` instead.
 */
export function rawBgraFrameToPng(frame: ScreenFrame): Buffer {
  if (frame.format !== 'raw-bgra' || !frame.data || !frame.bytesPerPixel || frame.bytesPerPixel !== 4) {
    throw new ActionError(ACTION_ERROR_CODES.CAPTURE_FAILED, 'The screen frame is not a supported raw BGRA image.');
  }
  const raw = Buffer.from(frame.data, 'base64');
  const expectedLength = frame.width * frame.height * 4;
  if (raw.length < expectedLength) throw new ActionError(ACTION_ERROR_CODES.CAPTURE_FAILED, 'The screen frame data is incomplete.');

  const png = new PNG({ width: frame.width, height: frame.height });
  for (let index = 0; index < expectedLength; index += 4) {
    png.data[index] = raw[index + 2];
    png.data[index + 1] = raw[index + 1];
    png.data[index + 2] = raw[index];
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

/**
 * Unified frame-to-PNG converter. Handles three frame variants:
 *
 *  1. `format === 'raw-bgra'` — robotjs Windows path. Delegates to
 *     `rawBgraFrameToPng` which swaps BGRA → RGBA and PNG-encodes.
 *
 *  2. `format === 'png'` — Linux scrot / gnome-screenshot / ImageMagick
 *     `import` path. The `data` field is already a base64-encoded PNG;
 *     we just decode the base64 and return the raw PNG bytes.
 *
 *  3. `format` is UNSET (the legacy / mock path) — `data` is treated as
 *     already-base64-encoded PNG bytes, same as case (2). This preserves
 *     backwards compatibility with test mocks and any other ScreenFrame
 *     producers that didn't set `format` explicitly.
 *
 * Throws a plain Error (not an ActionError) for empty / missing data,
 * so the ScreenshotExecutor's outer catch wraps it as
 * `SCREEN_CAPTURE_FAILED` — matching the original error code that
 * downstream consumers and tests expect.
 */
export function frameToPng(frame: ScreenFrame): Buffer {
  // BGRA path (Windows / robotjs).
  if (frame.format === 'raw-bgra' && frame.data && frame.bytesPerPixel === 4) {
    return rawBgraFrameToPng(frame);
  }
  // PNG path (Linux / scrot) and legacy path (no format set, data is
  // already a base64-encoded PNG string from a mock or pre-encoded
  // source). Both produce the same result: decode base64 → raw PNG bytes.
  if (frame.data) {
    const raw = Buffer.from(frame.data, 'base64');
    if (raw.length === 0) {
      // Plain Error so ScreenshotExecutor's catch wraps as
      // SCREEN_CAPTURE_FAILED, matching the original error code.
      throw new Error('Screen provider returned an empty image payload.');
    }
    return raw;
  }
  // No data field at all. Plain Error → wrapped as SCREEN_CAPTURE_FAILED
  // by ScreenshotExecutor's catch, preserving the original error code.
  throw new Error('Screen provider returned no image data.');
}

/* ------------------------------------------------------------------ */
/* v1.6.9 — screenshot shrinking for the Gemini Live wire              */
/* v1.6.10 — JPEG wire encoding for screenshots + live screen share    */
/* ------------------------------------------------------------------ */

/**
 * Box-average resample shared by every wire-image path. Averages the
 * source pixel block each target pixel covers — good quality/effort
 * trade-off for screen content (text stays legible down to ~768px).
 */
function resamplePng(decoded: PNG, targetW: number, targetH: number): PNG {
  const out = new PNG({ width: targetW, height: targetH });
  const sx = decoded.width / targetW;
  const sy = decoded.height / targetH;
  for (let y = 0; y < targetH; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(decoded.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
    for (let x = 0; x < targetW; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(decoded.width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const idx = (decoded.width * yy + xx) << 2;
          r += decoded.data[idx];
          g += decoded.data[idx + 1];
          b += decoded.data[idx + 2];
          a += decoded.data[idx + 3];
          count++;
        }
      }
      const oIdx = (targetW * y + x) << 2;
      out.data[oIdx] = r / count;
      out.data[oIdx + 1] = g / count;
      out.data[oIdx + 2] = b / count;
      out.data[oIdx + 3] = a / count;
    }
  }
  return out;
}

function decodePngBuffer(base64Png: string): PNG | null {
  try {
    const input = Buffer.from(base64Png, 'base64');
    if (input.length === 0) return null;
    const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (input.length < 8 || !input.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    return PNG.sync.read(input);
  } catch {
    return null;
  }
}

/**
 * Downscales + re-encodes a base64 PNG so it is small enough to inline in
 * a Gemini Live function response.
 *
 * WHY THIS EXISTS (field failure, v1.6.8 logs): the Live wire path shipped
 * the FULL-RESOLUTION screenshot as an inlineData Part inside the tool
 * response. Both observed sessions that sent a screenshot DIED ~15-20s
 * later with an empty close frame from Google while the client socket was
 * still open — the user experienced "I say see my screen, she goes quiet,
 * shows connecting and never comes back". Oversized inlineData in function
 * responses is the prime suspect.
 *
 * Strategy: box-average downscale to `maxDimension` on the long edge, then
 * if the re-encoded PNG STILL exceeds `maxBytes`, return null so the caller
 * falls back to a text-only tool response (metadata without pixels — the
 * session survives and the model can still speak about the capture).
 *
 * Returns the shrunk base64 PNG, or null when shrinking is impossible or
 * the result would still be too large. Never throws.
 */
export function shrinkPngBase64(
  base64Png: string,
  options?: { maxDimension?: number; maxBytes?: number },
): string | null {
  const maxDimension = options?.maxDimension ?? 1280;
  const maxBytes = options?.maxBytes ?? 700_000;
  try {
    const decoded = decodePngBuffer(base64Png);
    if (!decoded) return null;
    // NOTE (v1.6.10): the old "already small enough — pass through untouched"
    // shortcut is GONE. Field logs from v1.6.9 (session-1788032309352) show a
    // 482KB PNG sailing under the 700KB threshold untouched and Google
    // killing the session 3 seconds later. Even a "small" PNG is too heavy
    // for the Live wire; callers should prefer `encodeFrameForLiveWire`
    // (JPEG) and only use this PNG path as a fallback.

    const scale = Math.min(
      1,
      maxDimension / Math.max(decoded.width, decoded.height),
    );
    const targetW = Math.max(1, Math.round(decoded.width * scale));
    const targetH = Math.max(1, Math.round(decoded.height * scale));

    const out = resamplePng(decoded, targetW, targetH);
    const encoded = PNG.sync.write(out, { deflateLevel: 9 });
    if (encoded.length > maxBytes) return null;
    return encoded.toString('base64');
  } catch {
    // Any decode/encode failure must NEVER take the live session down —
    // the caller falls back to the text-only tool response.
    return null;
  }
}

export interface LiveWireImage {
  /** Base64-encoded JPEG bytes (no data: prefix). */
  data: string;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  bytes: number;
}

/**
 * v1.6.10 — THE wire-image path for everything Gemini Live receives.
 *
 * WHY JPEG (field failure, v1.6.9 log): PNG screenshots survived the 700KB
 * threshold and Google still killed the session 3-10s after each one.
 * Screenshots of desktop UI are photographic-ish content — JPEG encodes the
 * same frame 4-6x smaller than PNG. A 1024px q60 JPEG lands at 60-150KB,
 * which is safe BOTH in function responses and in the realtimeInput
 * media/video channel (the Discord-style live screen share feed).
 *
 * Accepts any ScreenFrame (raw-bgra robotjs, base64 PNG scrot path, or
 * legacy base64 PNG) via frameToPng. Never throws — returns null on any
 * failure so the caller falls back (PNG path → metadata-only).
 */
export function encodeFrameForLiveWire(
  frame: ScreenFrame,
  options?: { maxDimension?: number; quality?: number; maxBytes?: number },
): LiveWireImage | null {
  const maxDimension = options?.maxDimension ?? 1024;
  const quality = Math.min(100, Math.max(10, options?.quality ?? 60));
  const maxBytes = options?.maxBytes ?? 160_000;
  try {
    const pngBuffer = frameToPng(frame);
    const base64Png = pngBuffer.toString('base64');
    const decoded = decodePngBuffer(base64Png);
    if (!decoded || decoded.width <= 0 || decoded.height <= 0) return null;

    const scale = Math.min(1, maxDimension / Math.max(decoded.width, decoded.height));
    const targetW = Math.max(1, Math.round(decoded.width * scale));
    const targetH = Math.max(1, Math.round(decoded.height * scale));
    const resampled = scale < 1 ? resamplePng(decoded, targetW, targetH) : decoded;

    const encoded = jpeg.encode(
      { data: Buffer.from(resampled.data), width: resampled.width, height: resampled.height },
      quality,
    );
    if (!encoded.data || encoded.data.length === 0) return null;
    if (encoded.data.length > maxBytes) {
      // One retry at harsher settings before giving up — keeps usable
      // frames flowing even on visually dense screens.
      const retry = jpeg.encode(
        { data: Buffer.from(resampled.data), width: resampled.width, height: resampled.height },
        Math.max(30, quality - 25),
      );
      if (!retry.data || retry.data.length > maxBytes) return null;
      return {
        data: Buffer.from(retry.data).toString('base64'),
        mimeType: 'image/jpeg',
        width: resampled.width,
        height: resampled.height,
        bytes: retry.data.length,
      };
    }
    return {
      data: Buffer.from(encoded.data).toString('base64'),
      mimeType: 'image/jpeg',
      width: resampled.width,
      height: resampled.height,
      bytes: encoded.data.length,
    };
  } catch {
    return null;
  }
}

/**
 * Cheap perceptual signature for live-frame change detection: average
 * downscale to a tiny grayscale grid, returned as bytes. Two frames whose
 * signatures differ by less than ~1 level per cell look identical at a
 * glance — the live feed skips them (Discord behaves the same way: a
 * static screen sends no video data).
 */
export function frameSignature(base64JpegOrPng: string, mimeType: 'image/jpeg' | 'image/png', grid = 32): Uint8Array | null {
  try {
    const raw = Buffer.from(base64JpegOrPng, 'base64');
    if (raw.length === 0) return null;
    let rgba: { width: number; height: number; data: Uint8Array | Buffer } | null = null;
    if (mimeType === 'image/jpeg') {
      const decoded = jpeg.decode(raw, { useTArray: true, formatAsRGBA: true });
      rgba = { width: decoded.width, height: decoded.height, data: decoded.data };
    } else {
      const decoded = PNG.sync.read(raw);
      rgba = { width: decoded.width, height: decoded.height, data: decoded.data };
    }
    if (!rgba || rgba.width <= 0 || rgba.height <= 0) return null;
    const cellsX = grid;
    const cellsY = Math.max(2, Math.round((grid * rgba.height) / rgba.width));
    const sig = new Uint8Array(cellsX * cellsY);
    for (let cy = 0; cy < cellsY; cy++) {
      const y0 = Math.floor((cy * rgba.height) / cellsY);
      const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * rgba.height) / cellsY));
      for (let cx = 0; cx < cellsX; cx++) {
        const x0 = Math.floor((cx * rgba.width) / cellsX);
        const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * rgba.width) / cellsX));
        let sum = 0;
        let count = 0;
        // Sample a sparse stride within the cell — signatures do not need
        // exact averages, just stable comparisons.
        const stride = Math.max(1, Math.floor(((y1 - y0) * (x1 - x0)) / 16));
        for (let y = y0; y < y1; y += 1) {
          for (let x = x0; x < x1; x += 1) {
            const idx = (rgba.width * y + x) * 4;
            if (idx + 2 < rgba.data.length) {
              // luma approx: (r*2 + g*3 + b) / 6 keeps motion detection
              // honest for both bright UI and dark themes.
              sum += (rgba.data[idx] * 2 + rgba.data[idx + 1] * 3 + rgba.data[idx + 2]) / 6;
              count++;
            }
            if (count >= 64) break;
          }
          if (count >= 64) break;
        }
        sig[cy * cellsX + cx] = count > 0 ? Math.min(255, Math.round(sum / count)) : 0;
        void stride;
      }
    }
    return sig;
  } catch {
    return null;
  }
}

/** Mean absolute difference between two signatures (0-255 scale). */
export function signatureDiff(a: Uint8Array, b: Uint8Array): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 255;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}
