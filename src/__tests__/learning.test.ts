import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MistakeMemoryStore,
  buildFailureSignature,
  lexicalSimilarity,
} from '../learning/MistakeMemoryStore';
import { ErrorReflectionEngine } from '../learning/ErrorReflectionEngine';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sera-mistake-test-'));
}

describe('buildFailureSignature', () => {
  it('collapses session-specific noise into a stable signature', () => {
    const a = buildFailureSignature('focusWindow', 'Window "Calc" not found (id 4812)', { application: 'Calc' });
    const b = buildFailureSignature('focusWindow', 'Window "Calc" not found (id 9903)', { application: 'Calc' });
    expect(a).toBe(b);
  });

  it('differentiates different tools and errors', () => {
    const a = buildFailureSignature('focusWindow', 'window not found');
    const b = buildFailureSignature('setClipboard', 'clipboard locked');
    expect(a).not.toBe(b);
  });
});

describe('lexicalSimilarity', () => {
  it('returns 1 for identical text and 0 for disjoint text', () => {
    expect(lexicalSimilarity('window lost focus after typing', 'window lost focus after typing')).toBe(1);
    expect(lexicalSimilarity('apple banana cherry', 'quaternion matrix eigenvalue')).toBeLessThan(0.05);
  });
});

describe('MistakeMemoryStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* cleanup best-effort */ }
  });

  it('records, persists and reloads mistakes', () => {
    const store = new MistakeMemoryStore({ directory: dir });
    store.record({ toolName: 'controlComputerInput', error: 'no observable screen change was detected', rootCause: 'target lost focus' });
    store.flush();

    const reloaded = new MistakeMemoryStore({ directory: dir });
    expect(reloaded.size()).toBe(1);
    expect(reloaded.all()[0].toolName).toBe('controlComputerInput');
  });

  it('reinforces the same signature instead of duplicating', () => {
    const store = new MistakeMemoryStore({ directory: dir });
    store.record({ toolName: 't', error: 'boom 123', rootCause: 'x' });
    store.record({ toolName: 't', error: 'boom 456', rootCause: 'x' });
    expect(store.size()).toBe(1);
    expect(store.all()[0].occurrences).toBe(2);
  });

  it('stores and retrieves workarounds by exact signature', () => {
    const store = new MistakeMemoryStore({ directory: dir });
    store.record({ toolName: 'controlComputerInput', error: 'no observable screen change', rootCause: 'focus lost' });
    store.recordWorkaround('controlComputerInput', 'no observable screen change', 'focusWindow before typing', { args: { operation: 'type' } });

    const exact = store.findExact('controlComputerInput', 'no observable screen change', { operation: 'type' });
    expect(exact?.successfulWorkaround).toBe('focusWindow before typing');
  });

  it('query finds lexically similar mistakes', () => {
    const store = new MistakeMemoryStore({ directory: dir });
    store.record({ toolName: 'inspectScreen', error: 'ocr failed: no text recognized', rootCause: 'window minimized' });
    const results = store.query('inspectScreen ocr no text found');
    expect(results.length).toBeGreaterThan(0);
  });

  it('respects maxRecords eviction', () => {
    const store = new MistakeMemoryStore({ directory: dir, maxRecords: 3 });
    for (let i = 0; i < 6; i++) {
      store.record({ toolName: `tool${i}`, error: `error-${i}-unique`, rootCause: 'r' });
    }
    expect(store.size()).toBe(3);
  });
});

describe('ErrorReflectionEngine', () => {
  let dir: string;
  let store: MistakeMemoryStore;
  let engine: ErrorReflectionEngine;

  beforeEach(() => {
    dir = makeTempDir();
    store = new MistakeMemoryStore({ directory: dir });
    engine = new ErrorReflectionEngine(store);
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* cleanup best-effort */ }
  });

  it('classifies authorization failures', () => {
    const reflection = engine.reflect('focusWindow', { application: 'X' }, 'Tool requires authorization for this session');
    expect(reflection.errorClass).toBe('auth');
    expect(reflection.shouldRetry).toBe(false);
    expect(reflection.correctiveHint).toMatch(/setComputerControlAuthorization/i);
  });

  it('gives the focus heuristic for lost-focus errors with adjusted args', () => {
    const reflection = engine.reflect(
      'controlComputerInput',
      { operation: 'type', text: 'hello' },
      'Input executed, but no observable screen change was detected',
    );
    expect(reflection.analysis).toMatch(/focus/i);
    expect(reflection.correctiveHint).toMatch(/focusWindow/i);
    expect(reflection.shouldRetry).toBe(true);
  });

  it('reuses a previously learned exact workaround', () => {
    engine.reflect('controlComputerInput', { operation: 'type', text: 'hi' }, 'no observable screen change was detected');
    engine.learnWorkaround('controlComputerInput', 'no observable screen change was detected', 'focusWindow({application:"Calc"}) then retry');

    const second = engine.reflect('controlComputerInput', { operation: 'type', text: 'hi' }, 'no observable screen change was detected');
    expect(second.matchedMistake?.successfulWorkaround).toMatch(/focusWindow/);
    expect(second.correctiveHint).toMatch(/focusWindow\(/);
  });

  it('pre-flight check surfaces a hint when a similar mistake exists', () => {
    engine.reflect('controlComputerInput', { operation: 'type', text: 'hi' }, 'no observable screen change was detected');
    const preFlight = engine.preFlightCheck('controlComputerInput', { operation: 'type', text: 'hi again' });
    expect(preFlight.allowed).toBe(true);
    expect(preFlight.hint).toBeTruthy();
  });
});
