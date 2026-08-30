/**
 * v1.8.0 — Screen Memory bridge ("remember what was on my screen").
 *
 * THE FEATURE: while Screen Vision runs, every distinct screen state the
 * OCR engine can read is distilled into a short digest and kept here,
 * newest-last, per user. The digests give SERA a TEXT MEMORY of screens:
 *
 *   - during a share: "what was on my screen before this?" is answered
 *     from the digest log even though the model only ever SAW the newest
 *     two frames;
 *   - after a share stops: "remember the page I was showing you?" still
 *     works — the digest log outlives the channel;
 *   - across sessions: when a share ends, server.ts commits a summary
 *     into the persistent MemoryManager (same store as "my name is …"),
 *     so screen context survives restarts.
 *
 * PRIVACY: digests are plain TEXT the user consciously shared (they were
 * streaming the frames anyway), the log is bounded and age-pruned, and the
 * persisted memory goes through MemoryManager's secret filter, which
 * refuses to store anything that smells like a password, token, or card
 * number.
 *
 * PURE LOGIC: injectable clock, no fs / ws / express imports — fully
 * unit-testable.
 */

export interface ScreenMemoryEntry {
  /** When this screen state was seen (ms epoch). */
  at: number;
  /** Share source at the time: 'monitor' | 'window' | 'browser' | … */
  source: string;
  /** Distilled OCR digest of the visible text. */
  digest: string;
}

/** What the registry needs (structural — easy to fake in tests). */
export interface ScreenMemoryLogLike {
  record(entry: { at: number; source: string; digest: string }): void;
  recent(limit?: number): ScreenMemoryEntry[];
  latestDigest(): string | null;
  /** Formatted digest context for "past screen" questions. */
  formatContext(limit?: number, maxChars?: number): string;
  /** Entry count (telemetry / tests). */
  size(): number;
}

export const SCREEN_MEMORY_LIMITS = {
  /** Bounded per-user digest log (dedup keeps this small in practice). */
  maxEntries: 40,
  /** Digests older than this are pruned at record time. */
  maxAgeMs: 2 * 60 * 60 * 1000,
  /** Skip recording when Jaccard with the previous digest is ≥ this. */
  sameScreenThreshold: 0.82,
  /** Minimum digest length worth remembering. */
  minDigestChars: 24,
  /** Max entries quoted when answering "what was on my screen". */
  contextEntries: 8,
  /** Inject the memory answer at most once per this window. */
  minInjectIntervalMs: 20_000,
  /** Max characters of the digest persisted into the MemoryManager. */
  maxDigestChars: 600,
} as const;

/**
 * Matches questions about PAST screens — requires a recall-ish cue AND a
 * screen-ish noun so ordinary chatter never triggers it.
 */
const RECALL_CUE_RE =
  /\b(what was|what did|remember|recall|earlier|before|previously|ago|last|was showing|were showing|was looking|went back|brought back|showed you|that page|that site|that video|that error|that code)\b/i;
const SCREEN_NOUN_RE =
  /\b(screen|page|tab|window|website|site|browser|youtube|code|error|thumbnail|analytics|document|spreadsheet|email|dashboard|chart)\b/i;

export function looksLikeScreenMemoryQuestion(text: string): boolean {
  if (typeof text !== 'string' || text.length < 8) return false;
  return RECALL_CUE_RE.test(text) && SCREEN_NOUN_RE.test(text);
}

/** hh:mm (local server time) for context strings — short and readable. */
function hhmm(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export class ScreenMemoryLog implements ScreenMemoryLogLike {
  private entries: ScreenMemoryEntry[] = [];
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxAgeMs: number;

  constructor(options?: { now?: () => number; maxEntries?: number; maxAgeMs?: number }) {
    this.now = options?.now ?? (() => Date.now());
    this.maxEntries = options?.maxEntries ?? SCREEN_MEMORY_LIMITS.maxEntries;
    this.maxAgeMs = options?.maxAgeMs ?? SCREEN_MEMORY_LIMITS.maxAgeMs;
  }

  /**
   * Record a screen state. Deduplicates against the previous entry (a
   * static screen must not spam N identical digests), prunes by age, and
   * keeps the log bounded.
   */
  public record(entry: { at: number; source: string; digest: string }): void {
    const digest = (entry.digest || '').trim();
    if (digest.length < SCREEN_MEMORY_LIMITS.minDigestChars) return;
    const last = this.entries[this.entries.length - 1];
    if (last) {
      // Same screen as the previous entry → refresh its timestamp in
      // place instead of appending a near-duplicate.
      if (ocrJaccard(last.digest, digest) >= SCREEN_MEMORY_LIMITS.sameScreenThreshold) {
        last.at = entry.at;
        last.source = entry.source || last.source;
        return;
      }
    }
    this.entries.push({ at: entry.at, source: entry.source || 'unknown', digest });
    this.prune();
  }

  private prune(): void {
    const cutoff = this.now() - this.maxAgeMs;
    this.entries = this.entries.filter((e) => e.at >= cutoff);
    while (this.entries.length > this.maxEntries) this.entries.shift();
  }

  /** Newest-last slice of the log. */
  public recent(limit = SCREEN_MEMORY_LIMITS.contextEntries): ScreenMemoryEntry[] {
    this.prune();
    return this.entries.slice(Math.max(0, this.entries.length - limit));
  }

  /** Most recent digest (used for the share-ended memory commit). */
  public latestDigest(): string | null {
    return this.entries.length ? this.entries[this.entries.length - 1].digest : null;
  }

  /** Entry count (telemetry / tests). */
  public size(): number {
    return this.entries.length;
  }

  /**
   * Formats the log as model context for "what was on my screen" style
   * questions. Empty string when there is nothing worth quoting.
   */
  public formatContext(limit = SCREEN_MEMORY_LIMITS.contextEntries, maxChars = 2_500): string {
    const entries = this.recent(limit);
    if (entries.length === 0) return '';
    const lines: string[] = [];
    let total = 0;
    for (const entry of entries) {
      const line = `${hhmm(entry.at)} (${entry.source}): ${firstLineSummary(entry.digest)}`;
      if (total + line.length > maxChars) break;
      lines.push(line);
      total += line.length;
    }
    if (lines.length === 0) return '';
    return lines.join('\n');
  }

  /**
   * Formats the fact persisted into the app's MemoryManager when a share
   * session ends — one honest sentence plus the last digest, capped.
   */
  public formatShareEndedFact(startedAt: number, endedAt: number, source: string): string {
    return formatShareEndedFact(this.latestDigest(), startedAt, endedAt, source);
  }
}

/**
 * Standalone share-ended fact builder (server.ts uses this directly with
 * the digest from the registry's summary — no log instance needed).
 */
export function formatShareEndedFact(
  digest: string | null,
  startedAt: number,
  endedAt: number,
  source: string,
): string {
  const minutes = Math.max(1, Math.round((endedAt - startedAt) / 60_000));
  const head = `Screen share session (${hhmm(startedAt)}–${hhmm(endedAt)}, ${minutes} min, ${source})`;
  if (!digest) return `${head}: no readable text was on screen.`;
  const capped = digest.slice(0, SCREEN_MEMORY_LIMITS.maxDigestChars);
  return `${head}. Last visible content: ${capped}`;
}

// Local copy to avoid importing the OCR module here (keep this file
// dependency-free): same word-set Jaccard as screenOcr.ts.
function ocrJaccard(a: string, b: string): number {
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

/** First content line(s) of a digest for one-line summaries. */
function firstLineSummary(digest: string, maxChars = 160): string {
  const firstTwo = digest.split('\n').slice(0, 2).join(' — ');
  return firstTwo.length > maxChars ? `${firstTwo.slice(0, maxChars - 1)}…` : firstTwo;
}
