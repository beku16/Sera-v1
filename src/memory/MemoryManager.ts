import { MemoryCategory, MemoryItem, MemoryQueryResult } from './memoryTypes';
import { defaultMemoryStore, MemoryStoreLike } from './MemoryStore';
import { hybridRecallScore } from './SemanticIndex';

const SECRET_PATTERN = /password|passcode|otp|one[- ]time|credit card|cvv|api[_-]?key|token|secret/i;

const CATEGORY_WORDS: Record<MemoryCategory, string[]> = {
  identity: ['name', 'call me', 'location', 'language', 'birthday', 'date of birth', 'birth date', 'born'],
  preference: ['prefer', 'favorite', 'like', 'response style', 'always'],
  project: ['project', 'building', 'working on'],
  routine: ['every day', 'usually', 'routine', 'schedule'],
  relationship: ['friend', 'family', 'brother', 'sister', 'partner'],
  skill: ['know', 'learn', 'skill', 'experience'],
  other: [],
};

export class MemoryManager {
  private store: MemoryStoreLike;

  constructor(store: MemoryStoreLike = defaultMemoryStore) {
    this.store = store;
  }

  public setStore(store: MemoryStoreLike): void {
    this.store = store;
  }
  public async list(query = ''): Promise<MemoryItem[]> {
    const items = await this.store.all();
    const normalized = query.trim().toLowerCase();
    return normalized ? items.filter((item) => `${item.fact} ${item.category}`.toLowerCase().includes(normalized)) : items;
  }

  public containsSensitiveData(fact: string): boolean { return SECRET_PATTERN.test(fact); }

  public inferCategory(fact: string): MemoryCategory {
    const lower = fact.toLowerCase();
    for (const [category, words] of Object.entries(CATEGORY_WORDS) as Array<[MemoryCategory, string[]]>) {
      if (words.some((word) => lower.includes(word))) return category;
    }
    return 'other';
  }

  public inferKey(fact: string, category: MemoryCategory): string | undefined {
    const lower = fact.toLowerCase();
    if (category === 'identity' && (lower.includes('name') || lower.includes('call me'))) return 'identity:name';
    if (category === 'identity' && lower.includes('location')) return 'identity:location';
    if (category === 'identity' && (lower.includes('date of birth') || lower.includes('birth date') || lower.includes('birthday') || lower.includes('born'))) return 'identity:date-of-birth';
    if (category === 'preference' && lower.includes('response style')) return 'preference:response-style';
    if (category === 'project' && lower.includes('project')) return 'project:current';
    return undefined;
  }

  public async remember(fact: string, category?: MemoryCategory, key?: string, confidence: MemoryItem['confidence'] = 'high'): Promise<MemoryItem | null> {
    const cleanFact = fact.trim();
    if (!cleanFact || this.containsSensitiveData(cleanFact)) return null;
    const resolvedCategory = category || this.inferCategory(cleanFact);
    return this.store.save({ fact: cleanFact, category: resolvedCategory, key: key || this.inferKey(cleanFact, resolvedCategory), confidence, source: 'user' });
  }

  public async rememberForSpeaker(speakerId: string, fact: string, category?: MemoryCategory, key?: string, confidence: MemoryItem['confidence'] = 'high'): Promise<MemoryItem | null> {
    const cleanFact = fact.trim();
    if (!speakerId.trim() || !cleanFact || this.containsSensitiveData(cleanFact)) return null;
    const resolvedCategory = category || this.inferCategory(cleanFact);
    return this.store.save({ fact: cleanFact, category: resolvedCategory, key: key || this.inferKey(cleanFact, resolvedCategory), confidence, source: 'user', speakerId });
  }

  public async recallForSpeaker(speakerId: string, query = '', limit = 3): Promise<MemoryQueryResult[]> {
    const items = (await this.list()).filter((item) => item.speakerId === speakerId);
    const normalized = query.trim().toLowerCase();
    if (!normalized) return items.slice(0, limit).map((item) => ({ item, score: 1 }));
    const terms = normalized.split(/\s+/).filter((term) => !['what', 'is', 'my', 'the', 'of', 'when', 'was'].includes(term));
    return items
      .map((item) => {
        const keywordScore = terms.filter((term) => item.fact.toLowerCase().includes(term) || item.category.includes(term)).length / Math.max(1, terms.length);
        // Deep semantic recall (spec F): blend keyword overlap with hashed
        // n-gram embedding similarity so fuzzy phrasings still retrieve.
        return { item, score: hybridRecallScore(normalized, item.fact, keywordScore) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  public async recall(query = '', limit = 3): Promise<MemoryQueryResult[]> {
    const items = await this.list();
    const aliases: Record<string, string[]> = {
      dob: ['date', 'birth'],
      birthday: ['date', 'birth'],
      born: ['date', 'birth'],
      name: ['name'],
    };
    const terms = query.toLowerCase().split(/\s+/).filter((term) => !['what', 'is', 'my', 'the', 'of', 'when', 'was'].includes(term));
    const expandedTerms = Array.from(new Set(terms.flatMap((term) => [term, ...(aliases[term] || [])])));
    return items
      .map((item) => {
        const keywordScore = expandedTerms.length
          ? expandedTerms.filter((term) => item.fact.toLowerCase().includes(term) || item.category.includes(term)).length / expandedTerms.length
          : 1;
        // Deep semantic recall (spec F): hybrid keyword + vector score.
        return { item, score: hybridRecallScore(query, item.fact, keywordScore) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  public async forget(target: string): Promise<boolean> {
    const items = await this.list();
    const item = items.find((entry) => entry.id === target || entry.fact.toLowerCase() === target.toLowerCase());
    return item ? this.store.delete(item.id) : false;
  }

  public async update(id: string, fact: string, category?: MemoryCategory): Promise<MemoryItem | null> {
    const cleanFact = fact.trim();
    if (!cleanFact || this.containsSensitiveData(cleanFact)) return null;
    return this.store.update(id, cleanFact, category);
  }

  public async clear(): Promise<void> {
    await this.store.clear();
  }

  public async context(limit = 3): Promise<string> {
    const items = await this.recall('', limit);
    return items.length ? items.map(({ item }) => `- [${item.category}] ${item.fact}`).join('\n') : '';
  }
}

export const defaultMemoryManager = new MemoryManager();

