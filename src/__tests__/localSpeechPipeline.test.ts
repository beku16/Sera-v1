import { describe, expect, it, vi } from 'vitest';
import { LocalWakeEngine } from '../audio/LocalWakeEngine';
import { extractWakePrompt } from '../audio/wakePhrase';
import { LocalSession } from '../local/LocalSession';
import { AssistantStateManager } from '../state/AssistantState';
import { APP_CONFIG } from '../config/config';

describe('simulated local speech pipeline', () => {
  it('delivers a transcript from the Electron bridge to LocalWakeEngine', async () => {
    let transcriptListener: ((payload: { text?: string }) => void) | undefined;
    const onTranscript = vi.fn();
    window.seraDesktop = {
      isDesktop: true,
      openExternal: vi.fn(),
      startLocalSpeech: vi.fn(async () => true),
      stopLocalSpeech: vi.fn(async () => true),
      getLocalSpeechState: vi.fn(async () => ({ state: 'STARTED', pid: 1, exitCode: null, owners: 1 })),
      onLocalSpeechTranscript: (listener) => {
        transcriptListener = listener;
        return () => { transcriptListener = undefined; };
      },
      onLocalSpeechStatus: () => () => undefined,
      onLocalSpeechError: () => () => undefined,
      onLocalSpeechDiagnostic: () => () => undefined,
    };

    const engine = new LocalWakeEngine({ onTranscript });
    await expect(engine.start()).resolves.toBe(true);
    transcriptListener?.({ text: 'hello this is a microphone test' });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(onTranscript).toHaveBeenCalledWith('hello this is a microphone test');
    engine.stop();
  });

  it.each([
    ['hello this is a microphone test', null],
    ['hey sara', undefined],
    ['hey sara open calculator', 'open calculator'],
  ])('keeps simulated transcript semantics for %s', (transcript, expectedCommand) => {
    expect(extractWakePrompt(transcript)).toBe(expectedCommand);
  });

  it('LocalSession rejects low-confidence noise and emits clean single turns with confidence check', async () => {
    let transcriptListener: ((payload: Record<string, unknown>) => void) | undefined;
    const finalTranscripts: Array<{ id: string; text: string; isPartial?: boolean }> = [];
    const onTranscript = vi.fn((item) => {
      if (!item.isPartial) finalTranscripts.push(item);
    });

    window.seraDesktop = {
      isDesktop: true,
      openExternal: vi.fn(),
      startLocalSpeech: vi.fn(async () => true),
      stopLocalSpeech: vi.fn(async () => true),
      getLocalSpeechState: vi.fn(async () => ({ state: 'STARTED', pid: 1, exitCode: null, owners: 1 })),
      onLocalSpeechTranscript: (listener) => {
        transcriptListener = listener;
        return () => { transcriptListener = undefined; };
      },
      onLocalSpeechStatus: () => () => undefined,
      onLocalSpeechError: () => () => undefined,
      onLocalSpeechDiagnostic: () => () => undefined,
    };

    const stateManager = new AssistantStateManager();
    const session = new LocalSession(stateManager, APP_CONFIG.defaultSettings, { onTranscript });
    
    // Start desktop recognition
    // @ts-expect-error accessing private method for test verification
    session.startDesktopRecognition();

    // 1. Send hypotheses (must NOT trigger final turns)
    transcriptListener?.({ text: 'can you', isHypothesis: true });
    transcriptListener?.({ text: 'can you hear me', isHypothesis: true });
    expect(finalTranscripts.length).toBe(0);

    // 2. Low confidence acoustic noise hallucination (e.g. 0.12) -> MUST BE REJECTED!
    transcriptListener?.({ text: 'the but but if', confidence: 0.12, isHypothesis: false });
    transcriptListener?.({ text: 'a zone a zone', confidence: 0.08, isHypothesis: false });
    expect(finalTranscripts.length).toBe(0);

    // 3. Clean recognized speech (confidence 0.85) -> MUST BE ACCEPTED!
    transcriptListener?.({ text: 'Can you hear me', confidence: 0.85, isHypothesis: false });
    expect(finalTranscripts.length).toBe(1);
    expect(finalTranscripts[0].text).toBe('Can you hear me');

    // 4. Duplicate utterance within 1.5s -> MUST BE REJECTED!
    transcriptListener?.({ text: 'Can you hear me', confidence: 0.85, isHypothesis: false });
    expect(finalTranscripts.length).toBe(1);

    // 5. Visualizer reflection test: when SAPI audio level is received, frequencies are active
    // @ts-expect-error accessing private method
    session.desktopUnsubscribers; // Verify active
    // Send SAPI audio level 45%
    // @ts-expect-error accessing private field for verification
    session.sapiMicLevel = 0.45;
    stateManager.transitionTo('connecting', 'test');
    stateManager.transitionTo('listening', 'test');
    const viz = session.getVisualizerData();
    expect(viz.micLevel).toBe(0.45);
    expect(viz.frequencies.some((v) => v > 0)).toBe(true);

    session.disconnect();
  });
});

