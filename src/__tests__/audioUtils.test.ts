import { describe, it, expect } from 'vitest';
import {
  float32ToInt16Pcm,
  int16PcmToFloat32,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  calculateRms,
  downmixToMono,
} from '../audio/audioUtils';

describe('audioUtils', () => {
  it('converts Float32Array to Int16Array PCM with proper clamping', () => {
    const input = new Float32Array([0.0, 1.0, -1.0, 0.5, -0.5, 1.5, -2.0]);
    const pcm = float32ToInt16Pcm(input);

    expect(pcm[0]).toBe(0);
    expect(pcm[1]).toBe(0x7fff); // 32767
    expect(pcm[2]).toBe(-0x8000); // -32768
    expect(pcm[3]).toBe(16383); // 0.5 * 32767 truncated in Int16Array
    expect(pcm[4]).toBe(-16384); // -0.5 * 32768
    expect(pcm[5]).toBe(0x7fff); // Clamped at max
    expect(pcm[6]).toBe(-0x8000); // Clamped at min
  });

  it('converts Int16Array PCM back to Float32Array accurately', () => {
    const original = new Float32Array([0.0, 0.5, -0.5]);
    const pcm = float32ToInt16Pcm(original);
    const converted = int16PcmToFloat32(pcm);

    expect(converted[0]).toBeCloseTo(0.0, 4);
    expect(converted[1]).toBeCloseTo(0.5, 3);
    expect(converted[2]).toBeCloseTo(-0.5, 3);
  });

  it('encodes and decodes base64 buffers reversibly', () => {
    const bytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const base64 = arrayBufferToBase64(bytes.buffer);
    expect(typeof base64).toBe('string');

    const decodedBuffer = base64ToArrayBuffer(base64);
    const decodedBytes = new Uint8Array(decodedBuffer);

    expect(decodedBytes).toEqual(bytes);
  });

  it('calculates RMS volume levels accurately', () => {
    const silence = new Float32Array([0, 0, 0, 0]);
    expect(calculateRms(silence)).toBe(0);

    const loud = new Float32Array([1.0, -1.0, 1.0, -1.0]);
    expect(calculateRms(loud)).toBeGreaterThan(0.5);
  });

  it('downmixes stereo to mono', () => {
    const left = new Float32Array([1.0, 0.5]);
    const right = new Float32Array([0.0, 0.5]);
    const mono = downmixToMono([left, right]);

    expect(mono[0]).toBeCloseTo(0.5);
    expect(mono[1]).toBeCloseTo(0.5);
  });
});
