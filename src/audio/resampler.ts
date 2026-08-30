/**
 * High-performance audio resampler with phase-continuous linear interpolation.
 *
 * Tracks a fractional phase accumulator across successive calls to resample()
 * so that chunk boundaries are seamless — no micro-clicks, no buzzing.
 *
 * Used for:
 *  - Mic input:  48 kHz / 44.1 kHz → 16 kHz (downsampling for Gemini Live input)
 */
export class AudioResampler {
  private readonly sourceSampleRate: number;
  private readonly targetSampleRate: number;
  private readonly ratio: number;
  /** Fractional source-sample offset carried between chunks for phase continuity */
  private phaseOffset: number = 0;

  constructor(sourceSampleRate: number, targetSampleRate: number = 16000) {
    this.sourceSampleRate = sourceSampleRate;
    this.targetSampleRate = targetSampleRate;
    this.ratio = sourceSampleRate / targetSampleRate;
  }

  public reset(): void {
    this.phaseOffset = 0;
  }

  /**
   * Resamples a Float32Array from sourceSampleRate to targetSampleRate
   * using phase-continuous linear interpolation.
   */
  public resample(input: Float32Array): Float32Array {
    if (this.sourceSampleRate === this.targetSampleRate) {
      return input;
    }

    if (input.length === 0) {
      return new Float32Array(0);
    }

    // Calculate how many output samples we can produce from this chunk,
    // accounting for the carried-over fractional phase offset.
    const availableSourceSamples = input.length - this.phaseOffset;
    const outputLength = Math.floor(availableSourceSamples / this.ratio);
    if (outputLength <= 0) {
      // Not enough new input to produce even one output sample;
      // accumulate the phase debt for the next chunk.
      this.phaseOffset -= input.length;
      return new Float32Array(0);
    }

    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const sourceIndex = this.phaseOffset + i * this.ratio;
      const indexFloor = Math.floor(sourceIndex);
      const indexCeil = Math.min(input.length - 1, indexFloor + 1);
      const fraction = sourceIndex - indexFloor;

      output[i] = input[indexFloor] * (1 - fraction) + input[indexCeil] * fraction;
    }

    // Carry fractional remainder into the next chunk for seamless continuity
    this.phaseOffset = (this.phaseOffset + outputLength * this.ratio) - input.length;

    return output;
  }

  public getSourceRate(): number {
    return this.sourceSampleRate;
  }

  public getTargetRate(): number {
    return this.targetSampleRate;
  }
}
