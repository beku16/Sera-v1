import { describe, it, expect } from 'vitest';
import { AudioResampler } from '../audio/resampler';

describe('AudioResampler', () => {
  it('handles identity resampling (same sample rate)', () => {
    const resampler = new AudioResampler(16000, 16000);
    const input = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const output = resampler.resample(input);

    expect(output).toBe(input);
  });

  it('resamples from 48000Hz to 16000Hz (3:1 ratio)', () => {
    const resampler = new AudioResampler(48000, 16000);
    const input = new Float32Array(300);
    for (let i = 0; i < 300; i++) {
      input[i] = Math.sin((i / 48000) * 440 * 2 * Math.PI);
    }

    const output = resampler.resample(input);
    expect(output.length).toBe(100);
  });

  it('resamples from 44100Hz to 16000Hz correctly', () => {
    const resampler = new AudioResampler(44100, 16000);
    const input = new Float32Array(441);
    const output = resampler.resample(input);

    expect(output.length).toBe(160);
  });

  it('handles empty input arrays gracefully', () => {
    const resampler = new AudioResampler(48000, 16000);
    const output = resampler.resample(new Float32Array(0));
    expect(output.length).toBe(0);
  });
});
