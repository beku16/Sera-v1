import { beforeEach, describe, expect, it } from 'vitest';
import { defaultMemoryStore } from '../memory/MemoryStore';
import { MemoryManager } from '../memory/MemoryManager';

describe('SERA memory system', () => {
  const manager = new MemoryManager();

  beforeEach(async () => {
    await defaultMemoryStore.clear();
  });

  it('updates stable details instead of creating duplicates', async () => {
    await manager.remember('User preferred name is Vivek', 'identity', 'identity:name');
    await manager.remember('User preferred name is Alex', 'identity', 'identity:name');

    const items = await manager.list();
    expect(items).toHaveLength(1);
    expect(items[0].fact).toBe('User preferred name is Alex');
  });

  it('rejects secrets and limits injected context to three facts', async () => {
    expect(await manager.remember('User password is secret123', 'other')).toBeNull();
    for (let index = 0; index < 5; index++) {
      await manager.remember(`User likes topic ${index}`, 'preference', `preference:${index}`);
    }

    const context = await manager.context(3);
    expect(context.split('\n')).toHaveLength(3);
  });

  it('forgets a matching saved fact', async () => {
    const saved = await manager.remember('User is learning TypeScript', 'skill');
    expect(saved).not.toBeNull();
    expect(await manager.forget('User is learning TypeScript')).toBe(true);
    expect(await manager.list()).toHaveLength(0);
  });

  it('persists and recalls date of birth as a stable identity fact', async () => {
    const saved = await manager.remember('User date of birth is 12 March 1995');
    expect(saved?.key).toBe('identity:date-of-birth');

    const results = await manager.recall('What is my date of birth?');
    expect(results[0].item.fact).toContain('12 March 1995');

    await manager.remember('User date of birth is 14 March 1995');
    expect((await manager.list()).filter((item) => item.key === 'identity:date-of-birth')).toHaveLength(1);
  });

  it('isolates memory by speaker', async () => {
    await manager.rememberForSpeaker('alex', 'Alex is learning Python', 'skill', 'skill:language');
    await manager.rememberForSpeaker('blair', 'Blair is learning Java', 'skill', 'skill:language');

    expect((await manager.recallForSpeaker('alex', 'language'))[0].item.fact).toContain('Python');
    expect((await manager.recallForSpeaker('blair', 'language'))[0].item.fact).toContain('Java');
    expect(await manager.list()).toHaveLength(2);
  });
});
