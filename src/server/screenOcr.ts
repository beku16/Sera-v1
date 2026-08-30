/**
 * v1.8.0 — Screen OCR engine (server side of Screen Vision).
 *
 * THE FEATURE: "ultra-precise reading." Vision models see a screen the way
 * a person does — they can misread small text, dense code, or tiny numbers.
 * This engine runs Tesseract OCR on the SAME frames the model sees and
 * hands the model the exact visible text as a machine-readable string:
 * URLs, identifiers, error messages, analytics figures. The model gets
 * the picture AND the ground truth.
 *
 * It is also the eyes of LOCAL MODE: Ollama cannot see images at all, but
 * with OCR the local model can still answer "read the visible text" /
 * "what does this error say" honestly — the extracted text is injected as
 * plain text context.
 *
 * DESIGN: same memoised-worker pattern as TesseractOcrProvider (one shared
 * worker, full init promise chained, rejection clears the memo so a failed
 * init can be retried). Extraction is FIRE-AND-FORGET from the registry's
 * point of view: a slow or failed OCR NEVER delays, blocks, or kills a
 * frame. Pure text utilities (distill, similarity) live here too so they
 * are unit-testable without Tesseract.
 */
import { createWorker, PSM, Worker as TesseractWorker } from 'tesseract.js';
import { ocrDataDir } from '../local/SERAPaths';

/** What the registry needs from an OCR engine (structural — easy to fake in tests). */
export interface ScreenOcrEngineLike {
  extract(base64Jpeg: string): Promise<{ text: string } | null>;
  close?(): Promise<void>;
}

export interface ScreenOcrExtraction {
  /** Distilled, model-ready visible text (already cleaned + capped). */
  text: string;
  /** Raw word count before distillation (telemetry / health). */
  wordCount: number;
  /** Mean word confidence 0..1. */
  confidence: number;
  at: number;
}

export const SCREEN_OCR_LIMITS = {
  /** Max characters of distilled text kept per frame. */
  maxTextChars: 4_000,
  /** Max characters injected into a model context part. */
  maxContextChars: 2_000,
  /** Max characters included in a persisted memory digest. */
  maxMemoryChars: 600,
  /** Below this many distilled characters an extraction counts as "nothing readable". */
  minUsefulChars: 12,
  /** OCR text older than this is not injected alongside frames. */
  maxContextAgeMs: 15_000,
  /** OCR text older than this is not included in the local-mode hint. */
  maxLocalHintAgeMs: 45_000,
  /** Default ms between OCR runs per channel (OCR is CPU-heavy). */
  defaultIntervalMs: 8_000,
  /**
   * v1.8.1 — client-selectable OCR interval bounds. The lower bound keeps
   * one browser tab from hammering the shared Tesseract worker (OCR is
   * CPU-heavy); the upper bound keeps the OCR text (and screen memory)
   * meaningfully fresh.
   */
  minIntervalMs: 2_000,
  maxIntervalMs: 120_000,
} as const;

/**
 * v1.8.1 — clamps a client-supplied OCR interval into the allowed range.
 * Returns null for non-numeric / non-finite input (caller falls back to
 * its default). Trusted server-side config is NOT clamped (tests use 0).
 */
export function clampOcrIntervalMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const ms = Math.round(value);
  if (ms < SCREEN_OCR_LIMITS.minIntervalMs) return SCREEN_OCR_LIMITS.minIntervalMs;
  if (ms > SCREEN_OCR_LIMITS.maxIntervalMs) return SCREEN_OCR_LIMITS.maxIntervalMs;
  return ms;
}

export class TesseractScreenOcrEngine implements ScreenOcrEngineLike {
  private workerPromise: Promise<TesseractWorker> | null = null;

  /** Memoised FULL init (createWorker + setParameters) shared by all callers. */
  private async worker(): Promise<TesseractWorker> {
    if (!this.workerPromise) {
      this.workerPromise = (async () => {
        // v1.9.0 (BUG L9): explicit langPath/cachePath in the per-user OCR
        // dir. tesseract.js used to cache traineddata in the CWD — read-only
        // (and wrong) in a packaged install, and a CDN refetch every boot.
        const w = await createWorker('eng', 1, {
          langPath: ocrDataDir(),
          cachePath: ocrDataDir(),
          gzip: false,
        });
        await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
        return w;
      })().catch((err) => {
        this.workerPromise = null;
        throw err;
      });
    }
    return this.workerPromise;
  }

  public async extract(base64Jpeg: string): Promise<ScreenOcrExtraction | null> {
    const buffer = Buffer.from(base64Jpeg, 'base64');
    if (buffer.length === 0) return null;
    const worker = await this.worker();
    // blocks:true gives word-level confidence/bboxes we could use later;
    // text is all we need today, but ask for blocks so the shape is stable.
    const result = await worker.recognize(buffer, {}, { blocks: true });
    const words = (result.data.blocks || []).flatMap((block) =>
      block.paragraphs.flatMap((paragraph) => paragraph.lines.flatMap((line) => line.words)),
    );
    const usable = words.filter((word) => word.text.trim().length > 0);
    if (usable.length === 0) return null;
    const meanConfidence =
      usable.reduce((total, word) => total + Math.max(0, Math.min(1, word.confidence / 100)), 0) /
      usable.length;
    // Line assembly: join words per line so layout reads naturally.
    const lines = (result.data.blocks || []).flatMap((block) =>
      block.paragraphs.flatMap((paragraph) => paragraph.lines.map((line) => line.text)),
    );
    const rawText = lines.join('\n');
    const text = distillOcrText(rawText, SCREEN_OCR_LIMITS.maxTextChars);
    if (text.length < SCREEN_OCR_LIMITS.minUsefulChars) return null;
    return { text, wordCount: usable.length, confidence: meanConfidence, at: Date.now() };
  }

  public async close(): Promise<void> {
    if (!this.workerPromise) return;
    const promise = this.workerPromise;
    this.workerPromise = null;
    try {
      const worker = await promise;
      await worker.terminate();
    } catch {
      // Already terminated or never initialised — nothing to do.
    }
  }
}

// ── pure text utilities (unit-tested without Tesseract) ─────────────

/**
 * Cleans raw OCR output into model-ready text: collapses whitespace,
 * drops junk lines (too short, pure symbols, single-letter noise), and
 * caps the length. Never throws.
 */
export function distillOcrText(raw: string, maxChars: number = SCREEN_OCR_LIMITS.maxTextChars): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (line.length < 2) continue; // single chars are noise at screen scale
    if (!/[a-z0-9]/i.test(line)) continue; // pure symbols/punctuation
    if (seen.has(line)) continue; // repeated headers/footers
    seen.add(line);
    lines.push(line);
    if (lines.join('\n').length >= maxChars) break;
  }
  let text = lines.join('\n');
  if (text.length > maxChars) {
    // Keep the head and the tail — screens put titles at the top and
    // status/errors at the bottom; the middle is usually the bulk.
    const head = Math.floor(maxChars * 0.7);
    const tail = Math.max(0, maxChars - head - 20);
    text = `${text.slice(0, head)}\n[…]\n${text.slice(text.length - tail)}`;
  }
  return text.trim();
}

/**
 * Word-set Jaccard similarity (0..1) — cheap, order-insensitive, good
 * enough to tell "same screen, minor flicker" from "user switched pages".
 */
export function ocrTokenJaccard(a: string, b: string): number {
  const tokenize = (s: string): Set<string> =>
    new Set(
      (s || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 2),
    );
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return setA.size === setB.size ? 1 : 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

/** True when two OCR texts describe effectively the same screen. */
export function isSameScreenText(a: string, b: string, threshold = 0.82): boolean {
  if (!a || !b) return false;
  return ocrTokenJaccard(a, b) >= threshold;
}
