import { describe, expect, it, vi } from 'vitest';
import { AudioStreamer } from '../audio/AudioStreamer';
import { WakeWordDetector, WakeWordStateMachine } from '../audio/WakeWordDetector';
import { extractWakePrompt } from '../audio/wakePhrase';

function makeSeraToneSample(): Float32Array {
  const samples = new Float32Array(16000 * 0.75);
  const sr = 16000;
  for (let i = 0; i < samples.length; i++) {
    const t = i / sr;
    const envelope = Math.exp(-((t - 0.3) ** 2) / 0.02);
    const vowel = Math.sin(2 * Math.PI * 190 * t) + 0.6 * Math.sin(2 * Math.PI * 290 * t);
    const consonant = 0.2 * Math.sin(2 * Math.PI * 1200 * t) * (1 + Math.sin(2 * Math.PI * 4 * t));
    samples[i] = (vowel + consonant) * envelope * 0.4;
  }
  return samples;
}

describe('WakeWordStateMachine', () => {
  it('transitions through the wake-word lifecycle', () => {
    const machine = new WakeWordStateMachine();
    expect(machine.getState()).toBe('idle');
    expect(machine.transition('wake_word_detected')).toBe(true);
    expect(machine.getState()).toBe('wake_word_detected');
    expect(machine.transition('listening')).toBe(true);
    expect(machine.getState()).toBe('listening');
    expect(machine.transition('processing')).toBe(true);
    expect(machine.getState()).toBe('processing');
    expect(machine.transition('speaking')).toBe(true);
    expect(machine.getState()).toBe('speaking');
    expect(machine.transition('idle')).toBe(true);
    expect(machine.getState()).toBe('idle');
  });

  it('rejects invalid transitions', () => {
    const machine = new WakeWordStateMachine();
    expect(machine.transition('speaking')).toBe(false);
    expect(machine.getState()).toBe('idle');
  });
});

describe('wake phrase matching', () => {
  it.each([
    ['Sera', undefined],
    ['Sarah', undefined],
    ['Sara', undefined],
    ['Sare', undefined],
    ['Shara', undefined],
    ['Saira', undefined],
    ['Seera', undefined],
    ['Seerah', undefined],
    ['Serah', undefined],
    ['Sayra', undefined],
    ['Sayrah', undefined],
    ['Seraah', undefined],
    ['Hey Sera', undefined],
    ['Hey Sarah', undefined],
    ['Hey Sara', undefined],
    ['Hey Sare', undefined],
    ['Hey Seera', undefined],
    ['Hey, Sera', undefined],
    ['Okay Sera', undefined],
    ['Okay Sara', undefined],
    ['Hello Sera', undefined],
    ['Hello Sara', undefined],
    ['Wake up Sera', undefined],
    ['Wake up Sara', undefined],
    ['Hey, wake up', undefined],
    ['Wake up', undefined],
    ['see ra', undefined],
    ['see rah', undefined],
    ['say ra', undefined],
    ['sea ra', undefined],
    ['see-ra', undefined],
    ['c ra', undefined],
    ['Cera', undefined],
    ['Zera', undefined],
    ['Zara', undefined],
    ['Zahra', undefined],
    ['Sierra', undefined],
    ['Sherah', undefined],
    ['Seira', undefined],
    ['Sahra', undefined],
    ['heysera', undefined],
    ['heysarah', undefined],
    ['heysara', undefined],
    ['wakeupsera', undefined],
    ['Hey, Sera, open Chrome', 'open Chrome'],
    ['Hey Sarah open Calculator', 'open Calculator'],
    ['Hey Sara, scroll down', 'scroll down'],
    ['Okay Sera open WhatsApp', 'open WhatsApp'],
    ['Hey there Sara, open Chrome', 'open Chrome'],
    ['Wake up Sarah', undefined],
    ['Wake up Sera and open WhatsApp', 'open WhatsApp'],
    ['Wake up, open Notepad', 'open Notepad'],
    ['Okay, Sara, what time is it?', 'what time is it?'],
    ['Hello Sarah, what time is it?', 'what time is it?'],
    ['heysarah open youtube', 'open youtube'],
    ['hisera what is the weather', 'what is the weather'],
    ['see ra open Chrome', 'open Chrome'],
    ['see rah tell me a joke', 'tell me a joke'],
  ])('recognizes %s', (transcript, expectedPrompt) => {
    expect(extractWakePrompt(transcript)).toBe(expectedPrompt);
  });

  it.each([
    'hey',
    'hello',
    'bro',
    'hi',
    'okay',
    'open Chrome',
    'Sarah is my friend',
    'Sera was great',
    'I said hello',
    'serious',
    'seriously',
    'cereal',
    'several',
    'service',
    'server',
    'scenario',
    'serial',
    'sera protein',
    'search',
    'search for something',
    'searching',
    'random conversation',
  ])('rejects unrelated speech: %s', (transcript) => {
    expect(extractWakePrompt(transcript)).toBeNull();
  });
});

describe('WakeWordDetector', () => {
  it('detects a SERA-like wake phrase and emits an event', () => {
    const detector = new WakeWordDetector();
    const onWake = vi.fn();
    detector.setListener(onWake);

    for (let i = 0; i < 25; i++) {
      const result = detector.process(makeSeraToneSample());
      if (result.detected) {
        break;
      }
    }

    expect(detector.getState()).toBe('wake_word_detected');
    expect(onWake).toHaveBeenCalled();
  });

  it('fails gracefully on invalid input and preserves idle state', () => {
    const detector = new WakeWordDetector();
    const result = detector.process(new Float32Array(0));
    expect(result.detected).toBe(false);
    expect(result.reason).toBe('empty-input');
    expect(detector.getState()).toBe('idle');
  });

  it('prevents repeated activation without reset', () => {
    const detector = new WakeWordDetector();
    detector.process(makeSeraToneSample());
    const result = detector.process(makeSeraToneSample());
    expect(result.detected).toBe(false);
    expect(detector.getState()).toBe('wake_word_detected');
  });
});

describe('AudioStreamer wake-word lifecycle', () => {
  it('stops cleanly without leaving duplicate streams active', () => {
    const streamer = new AudioStreamer({
      onWakeWordDetected: () => undefined,
    });

    streamer['isStreaming'] = true;
    streamer.stop();

    expect(streamer.getStreamingStatus()).toBe(false);
    expect(streamer['mediaStream']).toBeNull();
  });
});
