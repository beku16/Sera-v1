import { describe, expect, it } from 'vitest';
import { createShutdownCoordinator } from '../server/shutdown';

describe('shutdown — createShutdownCoordinator', () => {
  it('runs steps LIFO (last registered runs first)', async () => {
    const order: string[] = [];
    const coordinator = createShutdownCoordinator();
    coordinator.addStep({ name: 'first', run: () => { order.push('first'); } });
    coordinator.addStep({ name: 'second', run: () => { order.push('second'); } });
    coordinator.addStep({ name: 'third', run: () => { order.push('third'); } });

    await coordinator.shutdown('test');

    expect(order).toEqual(['third', 'second', 'first']);
    expect(coordinator.hasRun).toBe(true);
  });

  it('a failing step never blocks the remaining steps', async () => {
    const order: string[] = [];
    const coordinator = createShutdownCoordinator();
    coordinator.addStep({ name: 'ok-early', run: () => { order.push('ok-early'); } });
    coordinator.addStep({
      name: 'boom',
      run: () => {
        throw new Error('cleanup exploded');
      },
    });
    coordinator.addStep({ name: 'ok-late', run: () => { order.push('ok-late'); } });

    await expect(coordinator.shutdown('test')).resolves.toBeUndefined();
    expect(order).toEqual(['ok-late', 'ok-early']);
  });

  it('a step that exceeds its timeout is skipped, not hung', async () => {
    const coordinator = createShutdownCoordinator();
    let hangReleased = false;
    coordinator.addStep({ name: 'hangs', timeoutMs: 50, run: () => new Promise<void>(() => undefined) });
    const finished: string[] = [];
    coordinator.addStep({ name: 'after', run: () => { finished.push('after'); } });

    const startedAt = Date.now();
    await coordinator.shutdown('test');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(finished).toEqual(['after']);
    hangReleased = true; // silence lint; the hung promise is intentionally orphaned
  });

  it('second shutdown call is a no-op (idempotent)', async () => {
    let count = 0;
    const coordinator = createShutdownCoordinator();
    coordinator.addStep({ name: 'once', run: () => { count += 1; } });

    await coordinator.shutdown('first');
    await coordinator.shutdown('second');
    expect(count).toBe(1);
  });

  it('awaited async steps complete before shutdown resolves', async () => {
    const seen: string[] = [];
    const coordinator = createShutdownCoordinator();
    coordinator.addStep({
      name: 'async',
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        seen.push('async-done');
      },
    });

    await coordinator.shutdown('test');
    expect(seen).toEqual(['async-done']);
  });

  it('unsubscribed steps do not run', async () => {
    const ran: string[] = [];
    const coordinator = createShutdownCoordinator();
    const unsubscribe = coordinator.addStep({ name: 'removed', run: () => { ran.push('removed'); } });
    coordinator.addStep({ name: 'kept', run: () => { ran.push('kept'); } });
    unsubscribe();

    await coordinator.shutdown('test');
    expect(ran).toEqual(['kept']);
  });
});
