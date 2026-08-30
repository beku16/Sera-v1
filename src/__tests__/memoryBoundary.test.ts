import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeMemoryStore } from '../memory/NodeMemoryStore';
import { MemoryStore } from '../memory/MemoryStore';

describe('memory storage boundary', () => {
  it('persists server memory across store instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sera-memory-'));
    const fileName = join(directory, 'memories.json');
    try {
      const first = new NodeMemoryStore(fileName);
      await first.save({ fact: 'server fact', category: 'other', confidence: 'high', source: 'user' });
      const second = new NodeMemoryStore(fileName);
      expect((await second.all()).map((item) => item.fact)).toEqual(['server fact']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the browser store free of Node filesystem imports', async () => {
    const source = await import('../memory/MemoryStore');
    expect(source.MemoryStore).toBeDefined();
    expect(source.defaultMemoryStore).toBeInstanceOf(MemoryStore);
  });
});
