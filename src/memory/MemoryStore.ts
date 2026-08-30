import { MemoryItem } from './memoryTypes';

const STORAGE_KEY = 'sera_memory_v1';

export interface MemoryStoreLike {
  init(): Promise<void>;
  all(): Promise<MemoryItem[]>;
  save(input: Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryItem>;
  update(id: string, fact: string, category?: MemoryItem['category']): Promise<MemoryItem | null>;
  delete(id: string): Promise<boolean>;
  clear(): Promise<void>;
}

export class MemoryStore implements MemoryStoreLike {
  private items: MemoryItem[] = [];
  private initialized = false;

  public async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      this.items = Array.isArray(parsed) ? parsed : [];
    } catch { this.items = []; }
  }

  private async persist(): Promise<void> {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.items));
  }

  public async all(): Promise<MemoryItem[]> { await this.init(); return this.items.map((item) => ({ ...item })); }

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
    window.localStorage.removeItem(STORAGE_KEY);
  }
}

export const defaultMemoryStore = new MemoryStore();
