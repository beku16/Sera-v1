import { describe, it, expect } from 'vitest';
import { matchSleepIntent, normalizeSleepText, SLEEP_FAREWELL } from '../utils/sleepCommands';

describe('sleepCommands — full-quit voice intents', () => {
  it('detects the user\'s exact complaint phrase "we full quit"', () => {
    expect(matchSleepIntent('we full quit')).toBe('sleep');
    expect(matchSleepIntent('Full quit, when I need you I will ask')).toBe('sleep');
  });

  it('detects sleep phrases anywhere in the utterance', () => {
    expect(matchSleepIntent('hey sera go to sleep now')).toBe('sleep');
    expect(matchSleepIntent('stop listening please')).toBe('sleep');
    expect(matchSleepIntent('okay leave me alone')).toBe('sleep');
    expect(matchSleepIntent('SERA SHUT UP')).toBe('sleep');
    expect(matchSleepIntent('ok that\'s all')).toBe('sleep');
    expect(matchSleepIntent('talk to you later!')).toBe('sleep');
  });

  it('sleeps on bare risky words but NOT when they are part of a task', () => {
    expect(matchSleepIntent('quit')).toBe('sleep');
    expect(matchSleepIntent('bye')).toBe('sleep');
    expect(matchSleepIntent('good night')).toBe('sleep');
    expect(matchSleepIntent('quit chrome')).toBeNull();
    expect(matchSleepIntent('bye the way open youtube')).toBeNull();
    expect(matchSleepIntent('good night music playlist on spotify')).toBeNull();
  });

  it('stop_speaking tier interrupts without sleeping', () => {
    expect(matchSleepIntent('stop')).toBe('stop_speaking');
    expect(matchSleepIntent('be quiet')).toBe('stop_speaking');
    expect(matchSleepIntent('stop talking')).toBe('stop_speaking');
    expect(matchSleepIntent('cancel that')).toBe('stop_speaking');
    // task commands survive
    expect(matchSleepIntent('stop the music')).toBeNull();
    expect(matchSleepIntent('cancel my meeting reminder')).toBeNull();
  });

  it('ignores ordinary conversation', () => {
    expect(matchSleepIntent("what's the weather today")).toBeNull();
    expect(matchSleepIntent('open youtube and search lofi beats')).toBeNull();
    expect(matchSleepIntent('tell me a joke')).toBeNull();
    expect(matchSleepIntent('')).toBeNull();
    expect(matchSleepIntent('   ')).toBeNull();
  });

  it('normalizer strips punctuation so "full quit!" still matches', () => {
    expect(normalizeSleepText('Full quit!!')).toBe('full quit');
    expect(matchSleepIntent('bye!')).toBe('sleep');
    expect(matchSleepIntent('stop...')).toBe('stop_speaking');
  });

  it('farewell is short and mentions how to come back', () => {
    expect(SLEEP_FAREWELL.length).toBeLessThan(100);
    expect(SLEEP_FAREWELL).toMatch(/click|type/i);
  });
});
