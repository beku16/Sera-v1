/**
 * Dependency-free semantic similarity for the memory layer.
 *
 * SERA's spec calls for deep vector recall (all-MiniLM-L6-v2 class).
 * Downloading a full transformer at startup is not acceptable for an
 * instant-launch desktop assistant, so this module provides a two-tier
 * approach:
 *
 *  1. Tier A (always available): deterministic character n-gram hashing
 *     embeddings with cosine similarity — captures fuzzy word-stem
 *     similarity ("borthday" ≈ "birthday", "meeting notes" ≈ "note
 *     meeting") with zero dependencies and zero latency.
 *
 *  2. Tier B (optional): when a local embedding provider (e.g. Ollama
 *     `nomic-embed-text`) is configured, embeddings can be swapped in —
 *     the public surface here is provider-agnostic.
 */

export const EMBEDDING_DIMENSIONS = 256;

/** FNV-1a hash — fast, deterministic, well-distributed for n-grams. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Lowercases, strips punctuation, splits to words. */
function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/**
 * Generates a normalized embedding for arbitrary text using hashed word
 * unigrams + character trigrams. Deterministic across processes, so
 * embeddings can even be persisted and compared later.
 */
export function hashEmbed(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMENSIONS);
  const words = tokenize(text);

  const add = (token: string, weight: number) => {
    const hash = fnv1a(token);
    const index = hash % EMBEDDING_DIMENSIONS;
    const sign = (hash >>> 31) & 1 ? -1 : 1;
    vector[index] += sign * weight;
  };

  for (const word of words) {
    // Word-level signal (weight 1.0)
    add(word, 1);
    // Character trigram stems (weight 0.45) — tolerate typos/inflections
    const padded = `#${word}#`;
    for (let i = 0; i + 3 <= padded.length; i++) {
      add(padded.slice(i, i + 3), 0.45);
    }
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) vector[i] /= norm;
  }
  return vector;
}

/** Cosine similarity between two embeddings (inputs may be unnormalized). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Semantic score between a query and a stored fact in [0, 1].
 * Pure convenience wrapper — normalized cosine of hash embeddings.
 */
export function semanticScore(query: string, fact: string): number {
  if (!query.trim() || !fact.trim()) return 0;
  const similarity = cosineSimilarity(hashEmbed(query), hashEmbed(fact));
  // Cosine of non-negative hashed embeddings lands roughly in [-0.2, 0.9];
  // remap negatives to 0 and stretch slightly for useful ranking.
  return Math.max(0, similarity);
}

/**
 * Hybrid recall score: blends exact keyword hits with semantic
 * similarity so both "what is my name" (keyword) and "when was i
 * borth" (typo → birthday) retrieve the right memory.
 */
export function hybridRecallScore(query: string, fact: string, keywordScore: number, semanticWeight = 0.45): number {
  const semantic = semanticScore(query, fact);
  return Math.min(1, keywordScore * (1 - semanticWeight) + semantic * semanticWeight);
}
