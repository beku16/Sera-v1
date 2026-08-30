import { describe, expect, it } from 'vitest';
import {
  foldPullEvent,
  formatBytes,
  IDLE_PULL_VIEW,
  isModelInstalled,
  modelFamily,
} from '../local/pullClient';

describe('pullClient — foldPullEvent', () => {
  it('never claims success after an Ollama error event (the ghost-install bug)', () => {
    let view = foldPullEvent(IDLE_PULL_VIEW, { status: 'pulling manifest' });
    view = foldPullEvent(view, { status: 'downloading digest', total: 2000, completed: 500 });
    // Ollama dies mid-pull (disk full, registry unreachable, bad tag…)
    view = foldPullEvent(view, { status: 'error', done: true, error: 'pull model manifest: file does not exist' });

    expect(view.error).toBe('pull model manifest: file does not exist');
    expect(view.done).toBe(true);
    expect(view.active).toBe(false);
    // The caller checks `error` before ever saying "installed".
  });

  it('tracks progress across downloading events', () => {
    let view = foldPullEvent(IDLE_PULL_VIEW, { status: 'downloading digest', total: 1000, completed: 250 });
    expect(view.fraction).toBeCloseTo(0.25);
    expect(view.active).toBe(true);
    view = foldPullEvent(view, { status: 'downloading digest', total: 1000, completed: 900 });
    expect(view.fraction).toBeCloseTo(0.9);
    expect(view.completedBytes).toBe(900);
    expect(view.totalBytes).toBe(1000);
  });

  it('marks the server final "complete" event as done', () => {
    const view = foldPullEvent(
      foldPullEvent(IDLE_PULL_VIEW, { status: 'downloading digest', total: 100, completed: 100 }),
      { status: 'complete', done: true, fraction: 1, completedBytes: null, totalBytes: null },
    );
    expect(view.done).toBe(true);
    expect(view.active).toBe(false);
    expect(view.fraction).toBe(1);
  });

  it('keeps the last label when a line has no status', () => {
    const view = foldPullEvent(
      foldPullEvent(IDLE_PULL_VIEW, { status: 'downloading digest' }),
      { total: 10, completed: 1 },
    );
    expect(view.label).toBe('downloading digest');
  });
});

describe('pullClient — isModelInstalled', () => {
  it('matches the exact tag', () => {
    expect(
      isModelInstalled('llama3.2:3b-instruct-q4_K_M', [{ name: 'llama3.2:3b-instruct-q4_K_M' }]),
    ).toBe(true);
  });

  it('falls back to family match (Ollama normalizes tags)', () => {
    expect(isModelInstalled('llama3.2:3b-instruct-q4_K_M', [{ name: 'llama3.2:latest' }])).toBe(true);
  });

  it('returns false when the library is empty — no more ghost installs', () => {
    expect(isModelInstalled('llama3.2:3b-instruct-q4_K_M', [])).toBe(false);
    expect(isModelInstalled('llama3.2:3b-instruct-q4_K_M', [{ name: 'qwen2.5:7b-instruct-q4_K_M' }])).toBe(false);
  });
});

describe('pullClient — helpers', () => {
  it('splits model family', () => {
    expect(modelFamily('llama3.2:3b-instruct-q4_K_M')).toBe('llama3.2');
    expect(modelFamily('llama3.2')).toBe('llama3.2');
  });

  it('formats bytes for the progress bar', () => {
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.00 GB');
    expect(formatBytes(700 * 1024 * 1024)).toBe('700 MB');
    expect(formatBytes(0)).toBe('0 B');
  });
});
