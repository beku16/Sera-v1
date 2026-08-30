export type WakeWordState = 'idle' | 'wake_word_detected' | 'listening' | 'processing' | 'speaking';

export interface WakeWordDetectionResult {
  detected: boolean;
  confidence: number;
  state: WakeWordState;
  reason?: string;
}

const VALID_WAKE_TRANSITIONS: Record<WakeWordState, WakeWordState[]> = {
  idle: ['wake_word_detected', 'listening'],
  wake_word_detected: ['listening', 'idle'],
  listening: ['processing', 'speaking', 'idle'],
  processing: ['speaking', 'idle'],
  speaking: ['idle'],
};

export class WakeWordStateMachine {
  private currentState: WakeWordState = 'idle';

  public getState(): WakeWordState {
    return this.currentState;
  }

  public transition(targetState: WakeWordState): boolean {
    if (this.currentState === targetState) {
      return true;
    }

    const allowed = VALID_WAKE_TRANSITIONS[this.currentState] ?? [];
    if (!allowed.includes(targetState)) {
      return false;
    }

    this.currentState = targetState;
    return true;
  }

  public reset(): void {
    this.currentState = 'idle';
  }
}

export class WakeWordDetector {
  private stateMachine = new WakeWordStateMachine();
  private listener: ((result: WakeWordDetectionResult) => void) | null = null;
  private lastDetectionAt = 0;
  private cooldownMs = 5000;
  private pendingSamples: Float32Array[] = [];
  private readonly maxPendingSamples = 32000;

  public setListener(listener: ((result: WakeWordDetectionResult) => void) | null): void {
    this.listener = listener;
  }

  public getState(): WakeWordState {
    return this.stateMachine.getState();
  }

  public reset(): void {
    this.pendingSamples = [];
    this.lastDetectionAt = 0;
    this.stateMachine.reset();
  }

  public process(samples: Float32Array): WakeWordDetectionResult {
    if (!samples || samples.length === 0) {
      return { detected: false, confidence: 0, state: this.stateMachine.getState(), reason: 'empty-input' };
    }

    if (this.stateMachine.getState() === 'wake_word_detected') {
      return { detected: false, confidence: 1, state: 'wake_word_detected', reason: 'already-detected' };
    }

    this.pendingSamples.push(samples);
    let totalLength = 0;
    for (const frame of this.pendingSamples) {
      totalLength += frame.length;
    }
    while (totalLength > this.maxPendingSamples) {
      const removed = this.pendingSamples.shift();
      if (removed) totalLength -= removed.length;
    }

    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const frame of this.pendingSamples) {
      combined.set(frame, offset);
      offset += frame.length;
    }

    const minWindowLength = 2560;
    if (combined.length < minWindowLength) {
      return { detected: false, confidence: 0, state: this.stateMachine.getState(), reason: 'insufficient-samples' };
    }

    const metrics = this.analyzeWindow(combined);
    const now = Date.now();
    const withinCooldown = now - this.lastDetectionAt < this.cooldownMs;

    const detected = !withinCooldown && metrics.score >= 0.7 && metrics.voiceLikeRatio >= 0.5;

    if (detected) {
      this.lastDetectionAt = now;
      this.stateMachine.transition('wake_word_detected');
      const result = {
        detected: true,
        confidence: metrics.score,
        state: 'wake_word_detected' as const,
        reason: 'wake-word-detected',
      };
      this.listener?.(result);
      return result;
    }

    return {
      detected: false,
      confidence: metrics.score,
      state: this.stateMachine.getState(),
      reason: withinCooldown ? 'cooldown-window' : 'no-wake-pattern-match',
    };
  }

  private analyzeWindow(samples: Float32Array): { score: number; voiceLikeRatio: number } {
    const n = samples.length;
    let energy = 0;
    let lowBand = 0;
    let midBand = 0;
    let highBand = 0;
    let zeroCrossings = 0;

    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const abs = Math.abs(s);
      energy += abs * abs;
      if (i > 0 && ((samples[i] >= 0 && samples[i - 1] < 0) || (samples[i] < 0 && samples[i - 1] >= 0))) {
        zeroCrossings++;
      }
    }

    const rms = Math.sqrt(Math.max(1e-9, energy / n));
    const zcr = zeroCrossings / n;

    for (let i = 0; i < n; i++) {
      const sample = samples[i];
      const frequency = Math.abs(sample);
      if (frequency < 1e-6) continue;
      const harmonicWeight = 1 + Math.min(1, (Math.abs(sample) / (rms + 1e-9)) * 2.4);
      lowBand += Math.abs(sample) * Math.max(0, 1 - Math.abs(sample) * 0.7) * harmonicWeight;
      midBand += Math.abs(sample) * (0.5 + Math.sin((i / n) * Math.PI)) * harmonicWeight;
      highBand += Math.abs(sample) * (0.3 + (i / n)) * harmonicWeight;
    }

    const norm = Math.max(1e-9, lowBand + midBand + highBand);
    const lowRatio = lowBand / norm;
    const midRatio = midBand / norm;
    const highRatio = highBand / norm;
    const voiceLikeRatio = Math.min(1, (midRatio * 2.2 + lowRatio * 0.8) / (0.9 + highRatio));

    const energyScore = Math.min(1, rms * 28);
    const zcrScore = Math.min(1, (zcr * 10) / (0.25 + zcr * 10));
    const spectralScore = Math.min(1, Math.max(0, voiceLikeRatio - 0.1) * 1.6);

    const score = Math.min(1, energyScore * 0.35 + zcrScore * 0.2 + spectralScore * 0.45);

    return {
      score,
      voiceLikeRatio: Math.min(1, Math.max(0, voiceLikeRatio)),
    };
  }
}
