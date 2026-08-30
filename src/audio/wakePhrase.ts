/**
 * wakePhrase.ts — Ultra-Sensitive, High-Precision Local Wake Word Extraction
 *
 * Supports:
 *  - Direct name: "Sera", "Sarah", "Sara", "Shara", "Sira", "Seera", "Cera", "Zera", etc.
 *  - Prefixes: "Hey Sera", "Okay Sera", "Hi Sera", "Hello Sera", "Yo Sera", "Listen Sera", "Hey there Sera", etc.
 *  - Wake-up commands: "Wake up", "Hey wake up", "Wake up Sera", "Sera wake up", etc.
 *  - Merged / contracted utterances: "heysera", "heysarah", "hisera", "oksera", "hellosera", "wakeupsera"
 *  - Trailing commands: "Hey Sera open YouTube" → "open YouTube", "Hey Sera what time is it?" → "what time is it?"
 *  - Phonetic fuzz: edit-distance ≤ 1 on names ≥ 4 characters
 *  - Regional accents: Indian English & global phonemes ("shera", "seira", "shira", "zahra", "sierra", etc.)
 *  - False-activation rejection: "serious", "cereal", "search", "Sarah is my friend", etc.
 */

export const WAKE_NAMES = [
  // Primary phonetic spellings of SERA
  'sera', 'sarah', 'sara', 'shara', 'saira', 'seera', 'seraah',
  'sira', 'sirah', 'syra', 'cera', 'zera', 'sarha', 'serah', 'sherah',
  'sheera', 'cyra', 'sehra', 'sayra', 'cerra', 'sarai', 'sarahi',
  // Indian English & regional accents
  'shera', 'seira', 'sierha', 'shira', 'sahra',
  // Related phonetics & common STT transcripts
  'zahra', 'zara', 'sierra', 'ciara', 'cira', 'serafina', 'sarita',
  'zero', 'sero', 'sura', 'surah', 'sayrah', 'sahrah', 'sirrah', 'serrah', 'siya',
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

// False-positive phrases to ignore (substring match)
const FALSE_ACTIVATION_PHRASES = [
  'serious', 'seriously', 'cereal', 'several', 'service',
  'server', 'scenario', 'serial', 'cerebral',
];

export function normalize(value: string): string {
  let normalized = value
    .toLowerCase()
    .replace(/[.,!?;:()[\]{}'"\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Split merged words like "heysera" -> "hey sera", "hisera" -> "hi sera", "oksera" -> "ok sera"
  normalized = normalized.replace(/\b(hey|hi|hello|ok|okay|wake|wakeup)(sera|sarah|sara|sira|seera)\b/g, '$1 $2');
  normalized = normalized.replace(/\bwakeup\b/g, 'wake up');

  return normalized;
}

export function editDistance(a: string, b: string): number {
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
  // "serraa" → "sera", "heyy" → "hey", "seraa" → "sera"
  return word.replace(/(.)\1+/g, '$1').replace(/ah$/, 'a').replace(/aa$/, 'a');
}

export function isWakeName(token: string): boolean {
  if (!token) return false;
  const clean = token.toLowerCase().trim();
  const collapsed = collapseRepeats(clean);

  // Exact match
  if (WAKE_NAMES.includes(clean) || WAKE_NAMES.includes(collapsed)) {
    return true;
  }

  // Edit distance check for words of length >= 4
  if (collapsed.length >= 4) {
    return WAKE_NAMES.some(
      (name) => name.length >= 4 && editDistance(collapsed, name) <= 1,
    );
  }

  return false;
}

function hasFalseActivationPhrase(normalized: string): boolean {
  // Check if any false activation phrase appears as a whole word or substring
  return FALSE_ACTIVATION_PHRASES.some((phrase) => {
    const regex = new RegExp(`\\b${phrase}`, 'i');
    return regex.test(normalized);
  });
}

/**
 * Extracts a prompt from user speech transcript.
 * Returns:
 *   null      — not a wake word event
 *   undefined — wake word detected, but no trailing command ("Hey Sera")
 *   string    — wake word + trailing command ("Hey Sera tell me the time" → "tell me the time")
 */
export function extractWakePrompt(transcript: string): string | undefined | null {
  if (!transcript || typeof transcript !== 'string') return null;

  const original = transcript.trim().replace(/\s+/g, ' ');
  const normalized = normalize(original);
  if (!normalized) return null;

  // Reject false activations like "serious", "cereal", etc.
  if (hasFalseActivationPhrase(normalized)) return null;

  const tokens = normalized.split(' ').filter(Boolean);
  const originalTokens = original.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let nameIndex: number | null = null;

  // 1. Scan for wake name
  for (let i = 0; i < tokens.length; i++) {
    if (!isWakeName(tokens[i])) continue;

    const before = tokens.slice(0, i);

    // Name at start ("Sera", "Sera tell me the time")
    if (before.length === 0) {
      nameIndex = i;
      break;
    }

    // Preceding tokens match a valid prefix ("Hey Sera", "Okay Sera", "Hey there Sera")
    const prefixMatched = WAKE_PREFIXES.some((prefix) => {
      if (before.length < prefix.length) return false;
      const subBefore = before.slice(-prefix.length);
      return prefix.every((t, pi) => subBefore[pi] === t);
    });

    // Or preceding tokens are filler preamble words ("um", "so", "please", "hey", "hi")
    const isPreamble = before.every((w) =>
      ['um', 'uh', 'so', 'hey', 'hi', 'ok', 'okay', 'yo', 'please', 'and', 'now', 'eh', 'er', 'there'].includes(w),
    );

    if (prefixMatched || isPreamble) {
      nameIndex = i;
      break;
    }

    // Match name anywhere in utterance
    nameIndex = i;
    break;
  }

  // 2. Scan for bare "wake up" / "hey wake up" without a name
  if (nameIndex === null) {
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === 'wake' && i + 1 < tokens.length && tokens[i + 1] === 'up') {
        nameIndex = i + 1;
        break;
      }
    }
  }

  if (nameIndex === null) return null;

  // Extract command tokens after the trigger
  let cmdTokens = tokens.slice(nameIndex + 1);
  let origCmdTokens = originalTokens.slice(nameIndex + 1);

  // If the trigger was a merged word like "heysera open chrome", originalTokens might need adjusting
  if (origCmdTokens.length < cmdTokens.length && originalTokens.length > 0) {
    const afterTriggerStr = original.replace(/^.*?(?:sera|sarah|sara|sira|seera|wake\s+up)/i, '').trim();
    if (afterTriggerStr) {
      origCmdTokens = afterTriggerStr.split(/\s+/).filter(Boolean);
    }
  }

  // Strip leading filler conjunctions ("and", "then", "please")
  while (
    cmdTokens.length > 0 &&
    ['and', 'then', 'please', 'can', 'could', 'would', 'just'].includes(cmdTokens[0])
  ) {
    cmdTokens = cmdTokens.slice(1);
    origCmdTokens = origCmdTokens.slice(1);
  }

  if (cmdTokens.length === 0) return undefined; // Pure wake word (e.g. "Hey Sera")

  // Reject non-command continuations (e.g. "Sera is my friend")
  if (NON_COMMAND_CONTINUATIONS.has(cmdTokens[0])) return null;

  const prompt = origCmdTokens.join(' ').replace(/^[,;:!?]+\s*/, '').trim();
  return prompt || undefined;
}