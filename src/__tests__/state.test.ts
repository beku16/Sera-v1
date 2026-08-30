import { describe, it, expect, vi } from 'vitest';
import { AssistantStateManager } from '../state/AssistantState';

describe('AssistantStateManager', () => {
  it('initializes in disconnected state', () => {
    const sm = new AssistantStateManager();
    expect(sm.getState()).toBe('disconnected');
    expect(sm.getErrorMessage()).toBeNull();
  });

  it('allows valid sequential state transitions', () => {
    const sm = new AssistantStateManager();

    // disconnected -> connecting
    expect(sm.transitionTo('connecting')).toBe(true);
    expect(sm.getState()).toBe('connecting');

    // connecting -> listening
    expect(sm.transitionTo('listening')).toBe(true);
    expect(sm.getState()).toBe('listening');

    // listening -> speaking
    expect(sm.transitionTo('speaking')).toBe(true);
    expect(sm.getState()).toBe('speaking');

    // speaking -> listening (turn over)
    expect(sm.transitionTo('listening')).toBe(true);
    expect(sm.getState()).toBe('listening');

    // listening -> disconnected
    expect(sm.transitionTo('disconnected')).toBe(true);
    expect(sm.getState()).toBe('disconnected');
  });

  it('blocks invalid transitions and maintains state integrity', () => {
    const sm = new AssistantStateManager('disconnected');

    // Cannot jump directly from disconnected to speaking
    const invalidRes = sm.transitionTo('speaking');
    expect(invalidRes).toBe(false);
    expect(sm.getState()).toBe('disconnected');
  });

  it('handles error transitions and preserves error messages', () => {
    const sm = new AssistantStateManager('listening');
    const listener = vi.fn();
    sm.subscribe(listener);

    sm.setError('Microphone permission rejected');
    expect(sm.getState()).toBe('error');
    expect(sm.getErrorMessage()).toBe('Microphone permission rejected');
    expect(listener).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ to: 'error', reason: 'Microphone permission rejected' })
    );

    // Can transition from error to connecting (reconnection)
    expect(sm.transitionTo('connecting')).toBe(true);
    expect(sm.getState()).toBe('connecting');
    expect(sm.getErrorMessage()).toBeNull();
  });
});
