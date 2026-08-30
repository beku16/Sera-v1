/**
 * Web Audio and PCM utility functions for Sera Voice Pipeline
 */

/**
 * Converts Float32Array audio samples (-1.0 to 1.0) into 16-bit signed PCM (Int16Array).
 * Handles clamping to prevent integer overflow distortion.
 */
export function float32ToInt16Pcm(float32Array: Float32Array): Int16Array {
  const length = float32Array.length;
  const pcm16 = new Int16Array(length);

  for (let i = 0; i < length; i++) {
    const sample = Math.max(-1, Math.min(1, float32Array[i]));
    pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return pcm16;
}

/**
 * Converts 16-bit signed PCM (Int16Array or ArrayBuffer) to Float32Array (-1.0 to 1.0)
 */
export function int16PcmToFloat32(int16Array: Int16Array): Float32Array {
  const length = int16Array.length;
  const float32 = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    float32[i] = int16Array[i] / 32768.0;
  }

  return float32;
}

/**
 * Encodes ArrayBuffer / Uint8Array to base64 string efficiently without stack overflow
 */
export function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  const len = bytes.byteLength;
  const chunkSize = 0x8000; // 32KB chunks to avoid call stack limits

  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }

  return btoa(binary);
}

/**
 * Decodes base64 string into an ArrayBuffer safely
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);

  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return bytes.buffer;
}

/**
 * Decodes base64 string containing raw 16-bit PCM Little-Endian into Float32Array audio samples (-1.0 to 1.0)
 * Safe against odd-byte lengths and memory alignment issues.
 */
export function base64PcmToFloat32(base64: string): Float32Array {
  if (!base64) return new Float32Array(0);

  const binaryString = atob(base64);
  const totalBytes = binaryString.length;
  // Ensure even number of bytes for 16-bit PCM
  const validBytes = totalBytes - (totalBytes % 2);
  const sampleCount = validBytes / 2;
  const float32 = new Float32Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    const byteLow = binaryString.charCodeAt(i * 2);
    const byteHigh = binaryString.charCodeAt(i * 2 + 1);
    let int16 = (byteHigh << 8) | byteLow;
    if (int16 >= 0x8000) int16 -= 0x10000; // Sign-extend 16-bit signed
    float32[i] = int16 / 32768.0;
  }

  return float32;
}

/**
 * Calculates Root Mean Square (RMS) volume of Float32 audio samples
 * Returns normalized level between 0.0 and 1.0
 */
export function calculateRms(samples: Float32Array): number {
  if (!samples || samples.length === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i];
  }

  const rms = Math.sqrt(sumSquares / samples.length);
  // Scale with a curve for visual responsiveness
  return Math.min(1.0, rms * 4.0);
}

/**
 * Downmixes multi-channel Float32Array audio buffers to mono
 */
export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];

  const length = channels[0].length;
  const mono = new Float32Array(length);
  const numChannels = channels.length;

  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let c = 0; c < numChannels; c++) {
      sum += channels[c][i];
    }
    mono[i] = sum / numChannels;
  }

  return mono;
}
