import { describe, expect, it } from 'vitest';
import { ActionManager } from '../actions/ActionManager';
import { ClipboardExecutor } from '../actions/ClipboardExecutor';
import { ClipboardProvider } from '../clipboard/ClipboardManager';

class MockClipboard implements ClipboardProvider {
  constructor(private value: string | null = null) {}
  async get(): Promise<string | null> { return this.value; }
  async set(content: string): Promise<boolean> { this.value = content; return true; }
}

async function execute(manager: ActionManager, type: 'clipboard.save' | 'clipboard.set' | 'clipboard.restore', parameters: Record<string, unknown> = {}) {
  return manager.execute(manager.createAction({ type, parameters }));
}

describe('clipboard restoration', () => {
  it('restores the original clipboard after temporary replacement', async () => {
    const provider = new MockClipboard('original text');
    const manager = new ActionManager();
    manager.registerExecutor(new ClipboardExecutor(provider));

    expect((await execute(manager, 'clipboard.save')).status).toBe('succeeded');
    expect((await execute(manager, 'clipboard.set', { content: 'temporary text' })).status).toBe('succeeded');
    expect((await execute(manager, 'clipboard.restore')).status).toBe('succeeded');
    expect(await provider.get()).toBe('original text');
  });

  it('restores nested snapshots in last-in-first-out order', async () => {
    const provider = new MockClipboard('outer');
    const manager = new ActionManager();
    manager.registerExecutor(new ClipboardExecutor(provider));

    await execute(manager, 'clipboard.save');
    await execute(manager, 'clipboard.set', { content: 'inner' });
    await execute(manager, 'clipboard.save');
    await execute(manager, 'clipboard.set', { content: 'temporary' });
    await execute(manager, 'clipboard.restore');
    expect(await provider.get()).toBe('inner');
    await execute(manager, 'clipboard.restore');
    expect(await provider.get()).toBe('outer');
  });

  it('fails restore when no snapshot exists', async () => {
    const manager = new ActionManager();
    manager.registerExecutor(new ClipboardExecutor(new MockClipboard('text')));

    const result = await execute(manager, 'clipboard.restore');

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('CLIPBOARD_UNAVAILABLE');
  });
});

