import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { memoryFilePath } from '../local/SERAPaths';
import { MemoryItem } from './memoryTypes';

/**
 * Canonical location of Sera's persistent memory store.
 *
 * Kept in sync with AutoRepairEngine and SystemDiagnosticService. Respecting
 * SERA_MEMORY_FILE lets users relocate the store (e.g. to a synced folder)
 * without breaking the diagnostic / repair subsystems.
 */
// v1.9.0 (BUG L5): the store lived at CWD/.data/sera_memories.json — a write
// into a read-only install dir. The authoritative home is now the per-user
// SERA data dir; SERAPaths.migrateLegacyData() copies the legacy file once.
const FILE_NAME = process.env.SERA_MEMORY_FILE || memoryFilePath();

export class NodeMemoryStore {
  constructor(private readonly fileName = FILE_NAME) {}

  private items: MemoryItem[] = [];
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialises the store from disk exactly once, even under concurrent calls.
   * The promise is memoised so racing callers share a single read instead of
   * stampeding the file system.
   */
  public async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          const raw = await readFile(this.fileName, 'utf8');
          const parsed = JSON.parse(raw);
          this.items = Array.isArray(parsed) ? parsed : [];
        } catch {
          this.items = [];
        }
        this.initialized = true;
      })();
    }
    await this.initPromise;
  }

  /**
   * v1.6.11 FIX: persistence is now ATOMIC (tmp file + rename) and
   * SERIALIZED (a promise chain). A crash mid-write used to truncate the
   * JSON — the next boot then failed to parse it and silently reset ALL
   * memories to []. Concurrent saves could also interleave writes into the
   * same file and corrupt it. The vault and provider registry have used
   * tmp+rename since the start; the memory store was the odd one out.
   */
  private persistChain: Promise<void> = Promise.resolve();

  private async persist(): Promise<void> {
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.fileName), { recursive: true });
      const tmp = `${this.fileName}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, JSON.stringify(this.items, null, 2), 'utf8');
      await rename(tmp, this.fileName);
    };
    this.persistChain = this.persistChain.then(write, write);
    return this.persistChain;
  }

  public async all(): Promise<MemoryItem[]> {
    await this.init();
    return this.items.map((item) => ({ ...item }));
  }

  public async save(input: Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryItem> {
    await this.init();
    const now = new Date().toISOString();
    const existing = input.key ? this.items.find((item) => item.key === input.key && item.speakerId === input.speakerId) : undefined;
    if (existing) {
      Object.assign(existing, input, { updatedAt: now });
      await this.persist();
      return { ...existing };
    }
    const item: MemoryItem = { ...input, id: `memory_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, createdAt: now, updatedAt: now };
    this.items.push(item);
    await this.persist();
    return { ...item };
  }

  public async update(id: string, fact: string, category?: MemoryItem['category']): Promise<MemoryItem | null> {
    await this.init();
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return null;
    item.fact = fact.trim();
    if (category) item.category = category;
    item.updatedAt = new Date().toISOString();
    await this.persist();
    return { ...item };
  }

  public async delete(id: string): Promise<boolean> {
    await this.init();
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    if (before !== this.items.length) await this.persist();
    return before !== this.items.length;
  }

  public async clear(): Promise<void> {
    this.items = [];
    this.initialized = true;
    this.initPromise = Promise.resolve();
    try { await unlink(this.fileName); } catch {}
  }
}

