import { beforeEach, describe, expect, it } from 'vitest';
import { ConversationRouter } from '../speakers/ConversationRouter';
import { SpeakerManager } from '../speakers/SpeakerManager';

function samples(value: number): Int16Array { return Int16Array.from({ length: 2048 }, (_, index) => Math.round(Math.sin(index / 8) * value)); }

describe('speaker awareness', () => {
  let manager: SpeakerManager;
  beforeEach(() => { manager = new SpeakerManager(null); });

  it('enrolls and matches a known voice without exposing stored features', () => {
    const profile = manager.enroll('Alex', samples(6000));
    expect(profile?.name).toBe('Alex');
    expect(profile?.voiceProfile).toEqual([]);
    expect(manager.match(samples(6000))).toMatchObject({ name: 'Alex', known: true, confidence: 'high' });
  });

  it('keeps dissimilar voices unknown and stable within a session', () => {
    const first = manager.match(samples(4000));
    const second = manager.match(samples(4000));
    expect(first.known).toBe(false);
    expect(second.speakerId).toBe(first.speakerId);
    expect(second.name).toContain('Unknown Speaker');
  });

  it('routes direct address and follow-up, but ignores unrelated conversation', () => {
    const router = new ConversationRouter();
    const speaker = { speakerId: 'a', name: 'Alex', confidence: 'high' as const, score: 1, known: true };
    expect(router.shouldRespond('Sera, open YouTube', speaker)).toBe(true);
    router.observe(speaker, 'Sera, open YouTube');
    expect(router.shouldRespond('What about tomorrow?', speaker)).toBe(true);
    const other = { ...speaker, speakerId: 'b', name: 'Blair' };
    expect(router.shouldRespond('Did you finish?', other)).toBe(false);
  });

  it('assigns primary permission only to the selected profile', () => {
    const alex = manager.enroll('Alex', samples(5000));
    const blair = manager.enroll('Blair', samples(9000));
    expect(manager.setPrimary(alex!.speakerId)).toBe(true);
    expect(manager.permissionFor(manager.match(samples(5000)))).toBe('full_control');
    expect(manager.permissionFor(manager.match(samples(9000)))).toBe('conversation');
  });
});
