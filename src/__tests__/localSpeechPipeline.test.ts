import { describe, expect, it, vi } from 'vitest';
import { LocalWakeEngine } from '../audio/LocalWakeEngine';
import { extractWakePrompt } from '../audio/wakePhrase';

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
});
