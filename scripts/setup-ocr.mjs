/**
 * setup-ocr.mjs — Downloads eng.traineddata (Tesseract OCR English model)
 * so VisionExecutor OCR element-location works offline.
 *
 * v1.9.0: the target is the per-user OCR cache (SERA_OCR_DIR, set by the
 * server to %LOCALAPPDATA%\SERA\ocr) instead of the project root — the
 * install dir can be read-only and tesseract.js no longer shares the CWD.
 * Legacy copy in the repo root is still honored as an existing source.
 *
 * Usage: npm run setup:ocr  (or auto-invoked by the server on first boot)
 */
import { createWriteStream, existsSync, statSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { get } from 'node:https';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// v1.9.0: server passes SERA_OCR_DIR (per-user cache); manual runs default
// to <project>/ocr-data so nothing is written next to node_modules anymore.
const OCR_DIR = process.env.SERA_OCR_DIR || resolve(PROJECT_ROOT, 'ocr-data');
const TARGET = resolve(OCR_DIR, 'eng.traineddata');
const LEGACY_TARGET = resolve(PROJECT_ROOT, 'eng.traineddata');
const MIN_SIZE = 1_000_000; // diagnostics treat <1MB as suspicious

const SOURCES = [
  'https://github.com/tesseract-ocr/tessdata/raw/main/eng.traineddata',
  'https://raw.githubusercontent.com/tesseract-ocr/tessdata/main/eng.traineddata',
];

function download(url, redirectsLeft = 4) {
  return new Promise((res, rej) => {
    const req = get(url, (resp) => {
      if (resp.statusCode && resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        if (redirectsLeft <= 0) return rej(new Error('Too many redirects'));
        resp.resume();
        return res(download(resp.headers.location, redirectsLeft - 1));
      }
      if (resp.statusCode !== 200) {
        resp.resume();
        return rej(new Error(`HTTP ${resp.statusCode} for ${url}`));
      }
      const tmp = `${TARGET}.download`;
      const file = createWriteStream(tmp);
      resp.pipe(file);
      file.on('finish', () => file.close(() => res(tmp)));
      file.on('error', (e) => { try { unlinkSync(tmp); } catch { /* ignore */ } rej(e); });
    });
    req.on('error', rej);
    req.setTimeout(60_000, () => req.destroy(new Error(`Timed out fetching ${url}`)));
  });
}

async function main() {
  // Adopt a healthy legacy copy instead of re-downloading.
  if (!existsSync(TARGET) && existsSync(LEGACY_TARGET) && statSync(LEGACY_TARGET).size >= MIN_SIZE) {
    try {
      mkdirSync(OCR_DIR, { recursive: true });
      renameSync(LEGACY_TARGET, TARGET);
      console.log(`[setup-ocr] Adopted legacy eng.traineddata → ${TARGET}`);
    } catch {
      /* fall through to a fresh download */
    }
  }
  if (existsSync(TARGET) && statSync(TARGET).size >= MIN_SIZE) {
    console.log(`[setup-ocr] eng.traineddata already present (${(statSync(TARGET).size / 1024 / 1024).toFixed(1)}MB). Nothing to do.`);
    process.exit(0);
  }
  mkdirSync(OCR_DIR, { recursive: true });
  let lastErr;
  for (const url of SOURCES) {
    try {
      console.log(`[setup-ocr] Downloading eng.traineddata from ${url} ...`);
      const tmp = await download(url);
      renameSync(tmp, TARGET);
      console.log(`[setup-ocr] Saved ${TARGET} (${(statSync(TARGET).size / 1024 / 1024).toFixed(1)}MB). OCR ready.`);
      process.exit(0);
    } catch (e) {
      lastErr = e;
      console.warn(`[setup-ocr] Source failed: ${e.message}`);
    }
  }
  console.error(`[setup-ocr] Could not download eng.traineddata: ${lastErr?.message ?? 'unknown error'}`);
  console.error('[setup-ocr] SERA will still run; OCR element-location falls back to slower paths.');
  console.error('[setup-ocr] Retry later or download manually from https://github.com/tesseract-ocr/tessdata');
  process.exit(1); // non-fatal for setup flows, but signal failure to callers
}

main();
