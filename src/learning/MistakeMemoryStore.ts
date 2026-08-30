import fs from 'node:fs';
import { userDataDir } from '../local/SERAPaths';
import path from 'node:path';

/**
 * A single learned mistake.
 *
 * Whenever a tool/action fails and Sera's reflection loop finds (or
 * suspects) a root cause plus a workaround that worked, an entry is
 * persisted here. Before future executions the reflection engine consults
 * this store (pre-flight anti-regression check) so Sera never repeats a
 * known mistake.
 */
export interface MistakeRecord {
  id: string;
  /** Stable, normalized signature used for exact anti-regression matching. */
  failureSignature: string;
  /** Tool (or action type) that failed, e.g. "controlComputerInput". */
  toolName: string;
  /** Short human/LLM-readable root cause, e.g. "target window lost focus". */
  rootCause: string;
  /** What actually worked last time, e.g. "focusWindow before typing". */
  successfulWorkaround?: string;
  /** Serialized context snapshot (window titles, args, error text, ...). */
  context?: Record<string, unknown>;
  /** Number of times this exact signature has failed. */
  occurrences: number;
  createdAt: number;
  lastSeenAt: number;
}

export interface MistakeQueryResult {
  record: MistakeRecord;
  /** 0..1 lexical similarity between the query and the stored mistake. */
  score: number;
  exact: boolean;
}

export interface MistakeMemoryStoreOptions {
  /** Directory that holds `sera_mistake_memory.json`. */
  directory?: string;
  /** Maximum number of retained records (oldest/least-seen evicted first). */
  maxRecords?: number;
  /** Logger override (defaults to console). */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

const DEFAULT_MAX_RECORDS = 500;
const STORE_FILE_NAME = 'sera_mistake_memory.json';

/**
 * Normalizes raw error text + args into a stable failure signature.
 *
 * The signature intentionally strips numbers, hex addresses, paths and
 * session-specific noise so that "Window 'Calc' not found (id 4812)" and
 * "Window 'Calc' not found (id 9903)" collapse to the same signature —
 * that is what makes the anti-regression check effective across sessions.
 */
export function buildFailureSignature(toolName: string, error: string, args?: unknown): string {
  const normalize = (input: string): string =>
    input
      .toLowerCase()
      // Strip common high-noise tokens
      .replace(/0x[0-9a-f]+/g, ' # ')
      .replace(/\b\d[\d.,:]*\b/g, ' # ')
      .replace(/[a-z]:\\[^"'\s]+/gi, ' <path> ')
      .replace(/\/[\w./-]{6,}/g, ' <path> ')
      .replace(/[^\w\s<>#-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const parts = [normalize(toolName || 'unknown-tool'), normalize(error || 'unknown-error')];
  if (args && typeof args === 'object') {
    const argKeys = Object.keys(args as Record<string, unknown>)
      .map((k) => normalize(k))
      .filter(Boolean)
      .sort();
    if (argKeys.length > 0) parts.push(`args:${argKeys.join('+')}`);
  }
  return parts.filter(Boolean).join(' :: ').slice(0, 512);
}

/** Tokenizing lexical similarity (Sørensen–Dice over word shingles). */
export function lexicalSimilarity(a: string, b: string): number {
  const tokenize = (text: string): Set<string> => {
    const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
    const shingles = new Set<string>();
    for (let i = 0; i < tokens.length; i++) {
      shingles.add(tokens[i]);
      if (i + 1 < tokens.length) shingles.add(`${tokens[i]}_${tokens[i + 1]}`);
    }
    return shingles;
  };

  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let overlap = 0;
  for (const token of setA) {
    if (setB.has(token)) overlap += 1;
  }
  return (2 * overlap) / (setA.size + setB.size);
}

/**
 * Persistent, file-backed mistake memory (`sera_mistake_memory.json`).
 *
 * Design notes:
 *  - Atomic writes via tmp-file + rename so a crash never corrupts memory.
 *  - A rotating `.bak` copy keeps one generation of history for forensics.
 *  - Bounded size with LRU-ish eviction (least recently seen, fewest
 *    occurrences first) so the store cannot grow unbounded.
 */
export class MistakeMemoryStore {
  private readonly filePath: string;
  private readonly maxRecords: number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private records: MistakeRecord[] = [];
  private loaded = false;
  private saveQueued = false;

  constructor(options: MistakeMemoryStoreOptions = {}) {
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.logger = options.logger ?? console;
    // v1.9.0 (BUG L5): default home is the per-user SERA data dir, never the
// (possibly read-only) install dir.
const dir = options.directory || userDataDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      this.logger.warn('[MistakeMemory] Could not create memory directory:', err);
    }
    this.filePath = path.join(dir, STORE_FILE_NAME);
  }

  /** Where the store lives (useful for diagnostics + tests). */
  public get location(): string {
    return this.filePath;
  }

  /** Lazily loads the JSON file; corrupted files fall back to a backup. */
  public load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as { records?: MistakeRecord[] };
      if (Array.isArray(parsed.records)) {
        this.records = parsed.records
          .filter((r) => r && typeof r.failureSignature === 'string' && typeof r.toolName === 'string')
          .slice(0, this.maxRecords);
      }
    } catch (err) {
      this.logger.warn('[MistakeMemory] Store corrupted, attempting backup:', err);
      try {
        const bak = `${this.filePath}.bak`;
        if (fs.existsSync(bak)) {
          const parsed = JSON.parse(fs.readFileSync(bak, 'utf8')) as { records?: MistakeRecord[] };
          this.records = Array.isArray(parsed.records) ? parsed.records : [];
        }
      } catch {
        this.records = [];
      }
    }
  }

  /** In-memory view (already loaded). */
  public all(): MistakeRecord[] {
    this.load();
    return [...this.records];
  }

  public size(): number {
    this.load();
    return this.records.length;
  }

  /**
   * Records (or reinforces) a failure. If the same failure signature
   * already exists the occurrence counter and workaround are updated
   * instead of duplicating entries.
   */
  public record(input: {
    toolName: string;
    error: string;
    rootCause: string;
    successfulWorkaround?: string;
    context?: Record<string, unknown>;
  }): MistakeRecord {
    this.load();
    const now = Date.now();
    const failureSignature = buildFailureSignature(input.toolName, input.error, input.context?.args);

    const existing = this.records.find((r) => r.failureSignature === failureSignature);
    if (existing) {
      existing.occurrences += 1;
      existing.lastSeenAt = now;
      if (input.rootCause) existing.rootCause = input.rootCause;
      if (input.successfulWorkaround) existing.successfulWorkaround = input.successfulWorkaround;
      if (input.context) existing.context = { ...existing.context, ...input.context };
      this.queueSave();
      return existing;
    }

    const record: MistakeRecord = {
      id: `mistake-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      failureSignature,
      toolName: input.toolName,
      rootCause: input.rootCause || 'unknown root cause',
      successfulWorkaround: input.successfulWorkaround,
      context: input.context,
      occurrences: 1,
      createdAt: now,
      lastSeenAt: now,
    };
    this.records.push(record);
    this.evictIfNeeded();
    this.queueSave();
    return record;
  }

  /**
   * Attaches/updates the workaround that finally worked for a signature.
   * Called by the reflection engine after a retry succeeds.
   *
   * Matching strategy: with args → exact signature (tool + error + arg
   * keys); without args → the most lexically similar record for the same
   * tool, so lessons survive even when callers lack the original args.
   */
  public recordWorkaround(toolName: string, error: string, workaround: string, context?: Record<string, unknown>): MistakeRecord | null {
    this.load();
    const args = context?.args;

    if (args && typeof args === 'object' && Object.keys(args as Record<string, unknown>).length > 0) {
      const failureSignature = buildFailureSignature(toolName, error, args);
      const existing = this.records.find((r) => r.failureSignature === failureSignature);
      if (existing) {
        existing.successfulWorkaround = workaround;
        existing.lastSeenAt = Date.now();
        this.queueSave();
        return existing;
      }
    } else {
      // No args — find the closest record for the same tool.
      const best = this.records
        .filter((r) => r.toolName === toolName)
        .map((r) => ({ record: r, score: lexicalSimilarity(`${toolName} ${error}`, r.failureSignature) }))
        .sort((a, b) => b.score - a.score)[0];
      if (best && best.score >= 0.5) {
        best.record.successfulWorkaround = workaround;
        best.record.lastSeenAt = Date.now();
        this.queueSave();
        return best.record;
      }
    }

    // Nothing matched — still persist the lesson.
    return this.record({ toolName, error, rootCause: 'recovered via workaround', successfulWorkaround: workaround, context });
  }

  /**
   * Exact-signature lookup used by the pre-flight anti-regression check.
   */
  public findExact(toolName: string, error: string, args?: unknown): MistakeRecord | undefined {
    this.load();
    const failureSignature = buildFailureSignature(toolName, error, args);
    return this.records.find((r) => r.failureSignature === failureSignature);
  }

  /**
   * Lexical similarity search across all stored mistakes. Used when no
   * exact signature matches — e.g. "have I failed anything *like* this
   * before?".
   */
  public query(text: string, limit = 3): MistakeQueryResult[] {
    this.load();
    if (!text.trim()) return [];
    return this.records
      .map((record) => ({
        record,
        score: Math.max(
          lexicalSimilarity(text, record.failureSignature),
          lexicalSimilarity(text, `${record.toolName} ${record.rootCause}`),
        ),
        exact: false,
      }))
      .filter((result) => result.score >= 0.18)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit));
  }

  /** Clears all learned mistakes (used by diagnostics / "forget all"). */
  public clear(): void {
    this.load();
    this.records = [];
    this.queueSave();
  }

  /** Forces a synchronous write (used in tests + shutdown paths). */
  public flush(): void {
    this.save();
  }

  private evictIfNeeded(): void {
    while (this.records.length > this.maxRecords) {
      // Evict least-recently-seen, tie-break on fewest occurrences.
      let victimIndex = 0;
      for (let i = 1; i < this.records.length; i++) {
        const candidate = this.records[i];
        const victim = this.records[victimIndex];
        if (candidate.lastSeenAt < victim.lastSeenAt
          || (candidate.lastSeenAt === victim.lastSeenAt && candidate.occurrences < victim.occurrences)) {
          victimIndex = i;
        }
      }
      this.records.splice(victimIndex, 1);
    }
  }

  /** Debounced save so a burst of failures doesn't thrash the disk. */
  private queueSave(): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    setTimeout(() => {
      this.saveQueued = false;
      this.save();
    }, 120);
  }

  private save(): void {
    try {
      const payload = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), records: this.records }, null, 2);
      if (fs.existsSync(this.filePath)) {
        try {
          fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
        } catch {
          // Backup failure is non-fatal.
        }
      }
      const tmpPath = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmpPath, payload, 'utf8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      this.logger.warn('[MistakeMemory] Failed to persist store:', err);
    }
  }
}

/** Process-wide default store, rooted at the current working directory. */
export const defaultMistakeMemoryStore = new MistakeMemoryStore();
