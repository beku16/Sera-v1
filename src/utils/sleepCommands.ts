/**
 * sleepCommands.ts — Deterministic "stop talking to me" voice intents.
 *
 * The user told SERA "we full quit — when I need you I will ask" and she
 * kept interrupting anyway, because the phrase was routed through the LLM
 * (which chatted back) instead of being treated as a hard control command.
 *
 * This matcher is intentionally DETERMINISTIC and runs BEFORE anything
 * reaches the model. Two tiers:
 *
 *   'sleep'         — fully stop everything: disconnect the live session,
 *                     silence TTS, disable the wake-word listener. SERA is
 *                     unreachable until the user clicks / types to her.
 *   'stop_speaking' — only shut up mid-answer (barge-in), keep listening.
 *
 * False-positive strategy: risky single words ("quit", "bye", "stop") only
 * match when they are the WHOLE utterance, so dictating "quit Chrome" or
 * "I said stop the music" never puts SERA to sleep. Multi-word phrases
 * ("full quit", "stop listening", "go to sleep") may match anywhere in the
 * utterance — they are unambiguous enough.
 */

export type SleepIntent = 'sleep' | 'stop_speaking';

export function normalizeSleepText(text: string): string {
  return (text || '')
    .toLowerCase()
    // Apostrophes vanish ("that's all" -> "thats all") instead of turning
    // into spaces, so contractions keep matching their phrase entries.
    .replace(/[''`]/g, '')
    .replace(/[.,!?;:()[\]{}"\-…]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Phrases that put SERA into FULL sleep when they appear anywhere in the
 * utterance. Every entry is specific enough that ordinary sentences and
 * app/task commands almost never contain them.
 */
const SLEEP_SUBSTRINGS: string[] = [
  'full quit',
  'fullquit',
  'go to sleep',
  'sleep now',
  'stop listening',
  'stop the listening',
  'leave me alone',
  'shut up',
  'close the session',
  'end the session',
  'end session',
  'thats all',
  "that's all",
  'that will be all',
  "that'll be all",
  'talk to you later',
  'see you later',
  'catch you later',
];

/**
 * Bare utterances (whole transcript, after normalization) that mean sleep.
 * Short risky words live here so "quit chrome" / "bye the way" never match.
 */
const SLEEP_EXACT: ReadonlySet<string> = new Set([
  'quit',
  'quit now',
  'quit sera',
  'sera quit',
  'i said quit',
  'bye',
  'bye bye',
  'bye sera',
  'sera bye',
  'ok bye',
  'okay bye',
  'good bye',
  'goodbye',
  'goodbye sera',
  'good night',
  'goodnight',
  'good night sera',
  'sleep',
  'sleep sera',
  'sera sleep',
  'disconnect',
  'disconnect sera',
  'go away',
  'sera go away',
  'leave',
  'leave now',
  'nothing else',
  'sera stop listening',
  'sera full quit',
  'sera shut up',
]);

/**
 * Bare utterances / substrings that only mean "stop talking right now"
 * (keep the session alive, keep listening).
 */
const STOP_SPEAKING_SUBSTRINGS: string[] = [
  'be quiet',
  'stop talking',
  'stop speaking',
  'cut it out',
  'zip it',
];

const STOP_SPEAKING_EXACT: ReadonlySet<string> = new Set([
  'stop',
  'stop it',
  'stop stop',
  'stop sera',
  'sera stop',
  'quiet',
  'shush',
  'shh',
  'silence',
  'enough',
  'cancel',
  'cancel that',
  'sera quiet',
  'hey stop',
  'no stop',
]);

/**
 * Classifies a user utterance into a hard control intent.
 * Returns null when the utterance is ordinary conversation.
 */
export function matchSleepIntent(text: string): SleepIntent | null {
  const normalized = normalizeSleepText(text);
  if (!normalized) return null;

  // Bare-word exact hits are checked first (highest confidence).
  if (SLEEP_EXACT.has(normalized)) return 'sleep';
  if (STOP_SPEAKING_EXACT.has(normalized)) return 'stop_speaking';

  for (const phrase of SLEEP_SUBSTRINGS) {
    if (normalized.includes(phrase)) return 'sleep';
  }
  for (const phrase of STOP_SPEAKING_SUBSTRINGS) {
    if (normalized.includes(phrase)) return 'stop_speaking';
  }
  return null;
}

/** Short farewell SERA speaks (locally, never via the LLM) before sleeping. */
export const SLEEP_FAREWELL = 'Okay, going fully quiet. Click me or type whenever you need me.';

/** Phrases that trigger the secure uninstallation flow. */
const UNINSTALL_SUBSTRINGS: string[] = [
  'uninstall yourself',
  'uninstall sera',
  'uninstall sara',
  'i want to uninstall sera',
  'i want to uninstall',
  'remove sera from my computer',
  'delete sera from my computer',
  'delete yourself',
  'delete sera',
  'delete sara',
  'remove yourself',
  'remove sera',
  'remove sara',
  'erase sera',
  'wipe sera',
  'uninstall app',
  'uninstall the app',
];

const UNINSTALL_EXACT: ReadonlySet<string> = new Set([
  'uninstall',
  'uninstall sera',
  'uninstall sara',
  'uninstall yourself',
  'delete sera',
  'remove sera',
  'remove yourself',
  'self destruct',
]);

/**
 * Checks if the user explicitly commanded SERA to uninstall herself.
 */
export function matchUninstallIntent(text: string): boolean {
  const normalized = normalizeSleepText(text);
  if (!normalized) return false;
  if (UNINSTALL_EXACT.has(normalized)) return true;
  for (const phrase of UNINSTALL_SUBSTRINGS) {
    if (normalized.includes(phrase)) return true;
  }
  return false;
}

export const UNINSTALL_FAREWELL = 'I have opened the uninstallation security gate on your screen. To prevent accidental triggers, please say or type the confirmation code to proceed.';

