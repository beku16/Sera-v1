export type MemoryCategory = 'identity' | 'preference' | 'project' | 'routine' | 'relationship' | 'skill' | 'other';

export interface MemoryItem {
  id: string;
  category: MemoryCategory;
  fact: string;
  key?: string;
  confidence: 'high' | 'medium' | 'low';
  source: 'user' | 'assistant' | 'imported';
  speakerId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryQueryResult {
  item: MemoryItem;
  score: number;
}
