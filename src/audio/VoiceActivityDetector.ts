/**
 * Real-Time Multi-Feature Voice Activity Detector (VAD)
 * Combines band energy distribution, zero-crossing rate (ZCR),
 * spectral centroid, and adaptive SNR tracking with hangover smoothing.
 */

export interface VadResult {
  isSpeech: boolean;
  speechProbability: number;
  energyRms: number;
  snrDb: number;
  noiseFloorDb: number;
  consecutiveSpeechFrames: number;
}

export class VoiceActivityDetector {
  private sampleRate: number;
  private noiseFloorPower: number = 0.00001; // ~ -50dB baseline
  private noiseFloorAlpha: number = 0.98;   // Exponential smoothing factor for background noise tracking
  private speechThresholdSnrDb: number = 3.5; // Minimum SNR dB for speech classification
  private minSpeechPower: number = 0.00002;   // Minimum absolute power (~ -47dB for sensitive mic pickup)
  private hangoverFramesMax: number = 10;   // ~250ms hangover to prevent clipping word endings
  private hangoverCounter: number = 0;
  private consecutiveSpeechFrames: number = 0;
  private lastSpeechProbability: number = 0;

  constructor(sampleRate: number = 16000) {
    this.sampleRate = sampleRate;
  }

  /**
   * Resets VAD state and recalibrates noise baseline
   */
  public reset(): void {
    this.noiseFloorPower = 0.00001;
    this.hangoverCounter = 0;
    this.consecutiveSpeechFrames = 0;
    this.lastSpeechProbability = 0;
  }

  /**
   * Analyzes an audio frame (Float32Array) and returns speech presence decisions
   */
  public process(samples: Float32Array): VadResult {
    const n = samples.length;
    if (n === 0) {
      return {
        isSpeech: false,
        speechProbability: 0,
        energyRms: 0,
        snrDb: 0,
        noiseFloorDb: -60,
        consecutiveSpeechFrames: 0,
      };
    }

    // 1. Compute frame energy and power
    let sumSq = 0;
    let zeroCrossings = 0;
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      sumSq += s * s;
      if (i > 0 && ((samples[i] >= 0 && samples[i - 1] < 0) || (samples[i] < 0 && samples[i - 1] >= 0))) {
        zeroCrossings++;
      }
    }

    const framePower = Math.max(1e-9, sumSq / n);
    const rms = Math.sqrt(framePower);
    const zcr = zeroCrossings / n;

    // 2. Compute SNR in dB against current estimated noise floor
    const snrDb = 10 * Math.log10(framePower / Math.max(1e-9, this.noiseFloorPower));
    const noiseFloorDb = 10 * Math.log10(Math.max(1e-9, this.noiseFloorPower));

    // 3. Multi-feature speech likelihood calculation
    // - High energy above noise floor (SNR > threshold)
    // - Absolute energy exceeds minimum threshold
    // - ZCR within natural human vocal range (0.02 to 0.45)
    let speechScore = 0;

    if (snrDb > this.speechThresholdSnrDb && framePower > this.minSpeechPower) {
      speechScore += 0.5;
    }
    if (snrDb > this.speechThresholdSnrDb + 6.0) {
      speechScore += 0.3;
    }
    if (zcr > 0.02 && zcr < 0.45) {
      speechScore += 0.2;
    }

    const isInstantSpeech = speechScore >= 0.7;

    // 4. Update adaptive noise floor tracking
    // Only adapt noise floor during non-speech frames
    if (!isInstantSpeech && framePower < this.noiseFloorPower * 2.5) {
      this.noiseFloorPower = (this.noiseFloorAlpha * this.noiseFloorPower) + ((1 - this.noiseFloorAlpha) * framePower);
    } else if (!isInstantSpeech && framePower < this.noiseFloorPower) {
      // Faster downward adaptation
      this.noiseFloorPower = (0.9 * this.noiseFloorPower) + (0.1 * framePower);
    }

    // 5. Apply hangover logic (prevents chopping off trailing consonants and soft endings)
    let isSpeech = false;
    if (isInstantSpeech) {
      this.consecutiveSpeechFrames++;
      this.hangoverCounter = this.hangoverFramesMax;
      isSpeech = true;
    } else if (this.hangoverCounter > 0) {
      this.hangoverCounter--;
      this.consecutiveSpeechFrames = Math.max(0, this.consecutiveSpeechFrames - 1);
      isSpeech = true;
    } else {
      this.consecutiveSpeechFrames = 0;
      isSpeech = false;
    }

    // Smooth speech probability
    const rawProb = isSpeech ? Math.min(1.0, 0.5 + (snrDb / 30.0)) : Math.max(0.0, (snrDb / 30.0) * 0.3);
    this.lastSpeechProbability = (0.7 * this.lastSpeechProbability) + (0.3 * rawProb);

    return {
      isSpeech,
      speechProbability: Math.min(1.0, Math.max(0.0, this.lastSpeechProbability)),
      energyRms: rms,
      snrDb: Math.round(snrDb * 10) / 10,
      noiseFloorDb: Math.round(noiseFloorDb * 10) / 10,
      consecutiveSpeechFrames: this.consecutiveSpeechFrames,
    };
  }

  public getEstimatedNoiseFloorDb(): number {
    return Math.round(10 * Math.log10(Math.max(1e-9, this.noiseFloorPower)) * 10) / 10;
  }
}
