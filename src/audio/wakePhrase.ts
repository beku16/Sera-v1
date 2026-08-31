/**
 * wakePhrase.ts — Production-Grade, High-Sensitivity Local Wake Word Extraction & Normalization
 *
 * Supports:
 *  - Direct names & natural pronunciations:
 *    "Sera", "Sarah", "Sara", "Sare", "Seera", "Seerah", "Serah", "Sayra", "Sayrah",
 *    "Saira", "Shara", "Sherah", "Sheera", "Sira", "Sirah", "Cera", "Zera", "Zara", "Zahra", etc.
 *  - Split STT transcripts:
 *    "see ra", "see rah", "say ra", "say rah", "sea ra", "sea rah", "c ra", "c rah", "sar ah", "ser a", "see-ra"
 *  - Prefixes:
 *    "Hey Sera", "Hey Sarah", "Okay Sera", "Hi Sera", "Hello Sera", "Yo Sera", "Listen Sera", "Hey there Sera", etc.
 *  - Wake-up commands:
 *    "Wake up", "Hey wake up", "Wake up Sera", "Sera wake up", etc.
 *  - Merged / contracted utterances:
 *    "heysera", "heysarah", "hisera", "oksera", "hellosera", "yosera", "wakeupsera"
 *  - Trailing commands:
 *    "Hey Sera open YouTube" → "open YouTube", "Hey Sarah what time is it?" → "what time is it?"
 *  - Phonetic signature matching & controlled fuzzy match (edit distance ≤ 1)
 *  - Strict false-activation rejection:
 *    "serious", "seriously", "cereal", "several", "service", "server", "scenario", "serial", "search",
 *    "Sarah is my friend", "Sera was nice", etc.
 */

export const WAKE_NAMES = [
  // Primary phonetic spellings of SERA
  'sera', 'sarah', 'sara', 'sare', 'seera', 'seerah', 'serah', 'sayra', 'sayrah',
  'saira', 'shara', 'sherah', 'sheera', 'sira', 'sirah', 'syra', 'cera', 'zera',
  'sarha', 'cyra', 'sehra', 'cerra', 'sarai', 'sarahi', 'seraah',
  // Indian English & regional accents
  'shera', 'seira', 'sierha', 'shira', 'sahra', 'sahrah', 'sirrah', 'serrah',
  // Related phonetics & common STT transcripts
  'zahra', 'zara', 'sierra', 'ciara', 'cira', 'serafina', 'sarita',
  'sero', 'sura', 'surah', 'siya',
];

export const WAKE_PREFIXES: string[][] = [
  ['hey'],
  ['hi'],
  ['hello'],
  ['okay'],
  ['ok'],
  ['yo'],
  ['oi'],
  ['sup'],
  ['ay'],
  ['listen'],
  ['hey', 'listen'],
  ['wake', 'up'],
  ['wake'],
  ['hey', 'wake', 'up'],
  ['hey', 'wake'],
  ['hey', 'there'],
  ['hello', 'there'],
  ['okay', 'there'],
  ['ok', 'there'],
  ['alright'],
  ['alright', 'then'],
  ['please'],
  ['now'],
  ['hey', 'now'],
];

// Words after name indicating a descriptive sentence rather than a command (e.g. "Sera is my friend")
const NON_COMMAND_CONTINUATIONS = new Set([
  'is', 'was', 'are', 'am', 'my', 'protein', 'friend', 'friends',
  'has', 'had', 'were', 'been', 'would', 'could', 'should', 'might',
  'said', 'told', 'asked', 'called', 'named',
]);

// False-positive phrases to ignore (exact whole-word or prefix matches)
const FALSE_ACTIVATION_STEMS = [
  'serious', 'seriously', 'cereal', 'several', 'service',
  'server', 'scenario', 'serial', 'cerebral', 'serum',
  'search', 'searching', 'circle', 'circumstance', 'zero',
  'certain', 'certainly', 'sentence',
];

/**
 * Normalizes input text for speech matching:
 * - Lowercases and strips all punctuation
 * - Merges split syllables common in STT ("see ra" -> "sera", "see rah" -> "sera")
 * - Expands merged contractions ("heysera" -> "hey sera")
 * - Collapses repeated characters ("seeeera" -> "seera", "heyy" -> "hey")
 */
export function normalize(value: string): string {
  if (!value || typeof value !== 'string') return '';

  let normalized = value
    .toLowerCase()
    .replace(/[.,!?;:()[\]{}"'\-_/\\~`#@$%^&*+=<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 1. Merge common 2-token STT phonetic splits for "Sera" / "Sarah"
  normalized = normalized.replace(/\b(see|sea|say|c|si|sy|sa|ser|sar)\s+(ra|rah|re|ro|ruh|a|ah)\b/g, 'sera');

  // 2. Split merged prefix+name words: "heysera" -> "hey sera", "heysarah" -> "hey sarah", "wakeupsera" -> "wake up sera"
  normalized = normalized.replace(
    /\b(hey|hi|hello|ok|okay|yo|listen|wake|wakeup)(sera|sarah|sara|sare|seera|seerah|serah|sayra|shara|sira|zara|zahra|cera)\b/g,
    '$1 $2',
  );
  normalized = normalized.replace(/\bwakeup\b/g, 'wake up');

  return normalized.replace(/\s+/g, ' ').trim();
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1]
        ? prev
        : Math.min(prev, row[j - 1], row[j]) + 1;
      prev = tmp;
    }
  }
  return row[b.length];
}

export function collapseRepeats(word: string): string {
  // "serraa" → "sera", "heyy" → "hey", "seeeera" → "seera"
  return word
    .replace(/(.)\1{2,}/g, '$1$1')
    .replace(/(.)\1+/g, '$1')
    .replace(/ah$/, 'a')
    .replace(/aa$/, 'a');
}

/**
 * Checks if a token matches the acoustic / phonetic pattern of SERA:
 * Initial sibilant [s, z, c, sh] + vowel [e, a, i, ay, ee, ai, ey] + liquid [r, rh, rr] + vowel [a, ah, e, eh, uh]
 */
export function isPhoneticSera(token: string): boolean {
  if (!token || token.length < 3 || token.length > 7) return false;
  const clean = token.toLowerCase();

  // Negative filter on false-positive stems
  if (FALSE_ACTIVATION_STEMS.some((stem) => clean.startsWith(stem))) {
    return false;
  }

  // Regex pattern for phonetic variations of "Sera" / "Sarah" / "Sare"
  const seraPhoneticPattern = /^(?:s|sh|z|c)(?:e|a|i|ay|ee|ai|ey|ea|eh)(?:r|rh|rr)(?:a|ah|e|eh|uh|o)?$/i;
  return seraPhoneticPattern.test(clean);
}

export function isWakeName(token: string): boolean {
  if (!token) return false;
  const clean = token.toLowerCase().trim();
  if (clean.length < 3 || clean.length > 10) return false;

  // Immediate false positive check
  if (FALSE_ACTIVATION_STEMS.some((stem) => clean.startsWith(stem))) {
    return false;
  }

  const collapsed = collapseRepeats(clean);

  // 1. Direct dictionary match
  if (WAKE_NAMES.includes(clean) || WAKE_NAMES.includes(collapsed)) {
    return true;
  }

  // 2. Phonetic pattern match
  if (isPhoneticSera(clean) || isPhoneticSera(collapsed)) {
    return true;
  }

  // 3. Controlled Levenshtein edit-distance check against core variations (length >= 4)
  if (collapsed.length >= 4) {
    const coreTargets = ['sera', 'sarah', 'sara', 'sare', 'seera', 'serah', 'sayra', 'shara'];
    return coreTargets.some((target) => editDistance(collapsed, target) <= 1);
  }

  return false;
}

function hasFalseActivationPhrase(normalized: string): boolean {
  const tokens = normalized.split(/\s+/);
  return tokens.some((token) =>
    FALSE_ACTIVATION_STEMS.some((stem) => token === stem || (token.startsWith(stem) && token.length > 4)),
  );
}

export interface WakeMatchResult {
  matched: boolean;
  confidence: number;
  wakePhrase: string;
  command?: string;
  sourceText: string;
}

/**
 * Detailed wake evaluation with confidence scoring and structured diagnostics.
 */
export function evaluateWakePhrase(transcript: string): WakeMatchResult {
  if (!transcript || typeof transcript !== 'string') {
    return { matched: false, confidence: 0, wakePhrase: '', sourceText: '' };
  }

  const original = transcript.trim().replace(/\s+/g, ' ');
  const normalized = normalize(original);
  if (!normalized) {
    return { matched: false, confidence: 0, wakePhrase: '', sourceText: original };
  }

  // Reject false activations like "serious", "cereal", etc.
  if (hasFalseActivationPhrase(normalized)) {
    return { matched: false, confidence: 0, wakePhrase: '', sourceText: original };
  }

  const tokens = normalized.split(' ').filter(Boolean);
  const originalTokens = original.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { matched: false, confidence: 0, wakePhrase: '', sourceText: original };
  }

  let nameIndex: number | null = null;
  let prefixConfidence = 0.85;

  // 1. Scan for wake name
  for (let i = 0; i < tokens.length; i++) {
    if (!isWakeName(tokens[i])) continue;

    const before = tokens.slice(0, i);

    // Name at start ("Sera", "Sarah", "Sera tell me the time")
    if (before.length === 0) {
      nameIndex = i;
      prefixConfidence = 0.92;
      break;
    }

    // Preceding tokens match a valid prefix ("Hey Sera", "Okay Sera", "Hey there Sera")
    const prefixMatched = WAKE_PREFIXES.some((prefix) => {
      if (before.length < prefix.length) return false;
      const subBefore = before.slice(-prefix.length);
      return prefix.every((t, pi) => subBefore[pi] === t);
    });

    if (prefixMatched) {
      nameIndex = i;
      prefixConfidence = 0.98;
      break;
    }

    // Or preceding tokens are filler preamble words ("um", "so", "please", "hey", "hi", "there")
    const isPreamble = before.every((w) =>
      ['um', 'uh', 'so', 'hey', 'hi', 'ok', 'okay', 'yo', 'please', 'and', 'now', 'eh', 'er', 'there'].includes(w),
    );

    if (isPreamble) {
      nameIndex = i;
      prefixConfidence = 0.94;
      break;
    }

    // Name embedded deeper in sentence
    nameIndex = i;
    prefixConfidence = 0.82;
    break;
  }

  // 2. Scan for bare "wake up" / "hey wake up" without a name
  if (nameIndex === null) {
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === 'wake' && i + 1 < tokens.length && tokens[i + 1] === 'up') {
        nameIndex = i + 1;
        prefixConfidence = 0.90;
        break;
      }
    }
  }

  if (nameIndex === null) {
    return { matched: false, confidence: 0, wakePhrase: '', sourceText: original };
  }

  // Extract command tokens after the trigger
  let cmdTokens = tokens.slice(nameIndex + 1);

  // Strip leading filler conjunctions ("and", "then", "please", "can you", "would you")
  while (
    cmdTokens.length > 0 &&
    ['and', 'then', 'please', 'can', 'could', 'would', 'just', 'you'].includes(cmdTokens[0])
  ) {
    cmdTokens = cmdTokens.slice(1);
  }

  // Reject non-command continuations (e.g. "Sera is my friend", "Sarah was great")
  if (cmdTokens.length > 0 && NON_COMMAND_CONTINUATIONS.has(cmdTokens[0])) {
    return { matched: false, confidence: 0, wakePhrase: '', sourceText: original };
  }

  const wakePhrase = tokens.slice(0, nameIndex + 1).join(' ');

  // If no command tokens remain after trigger, this is a pure wake word
  if (cmdTokens.length === 0) {
    return {
      matched: true,
      confidence: prefixConfidence,
      wakePhrase,
      command: undefined,
      sourceText: original,
    };
  }

  // Extract trailing command string from original preserving user capitalization
  const triggerRegex = /^(?:.*?(?:hey|hi|hello|ok|okay|yo|listen|wake\s+up|wake|alright|please|now)?\s*(?:sera|sarah|sara|sare|seera|seerah|serah|sayrah|sayra|shara|sherah|sheera|sira|sirah|cera|zera|zara|zahra|sierra|wake\s+up|see\s+rah|see\s+ra|say\s+rah|say\s+ra|sea\s+rah|sea\s+ra|c\s+rah|c\s+ra|sar\s+ah|ser\s+ah|ser\s+a|heysera|heysarah|heysara|hisera|hisarah|oksera|hellosera|yosera|wakeupsera))\b\s*/i;
  let rawPrompt = original.replace(triggerRegex, '').trim();

  // Strip leading punctuation and conjunctions from raw prompt
  rawPrompt = rawPrompt.replace(/^[.,!?;:\-]+\s*/, '').trim();
  rawPrompt = rawPrompt.replace(/^(?:and|then|please|can you|would you|just)\s+/i, '').trim();

  const prompt = rawPrompt || cmdTokens.join(' ');

  return {
    matched: true,
    confidence: prefixConfidence,
    wakePhrase,
    command: prompt || undefined,
    sourceText: original,
  };
}

/**
 * Extracts a prompt from user speech transcript.
 * Returns:
 *   null      — not a wake word event
 *   undefined — wake word detected, but no trailing command ("Hey Sera")
 *   string    — wake word + trailing command ("Hey Sera open YouTube" → "open YouTube")
 */
export function extractWakePrompt(transcript: string): string | undefined | null {
  const result = evaluateWakePhrase(transcript);
  if (!result.matched) return null;
  return result.command;
}