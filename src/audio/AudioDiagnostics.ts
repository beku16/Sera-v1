import { AudioDiagnosticsInfo } from '../types';

export class AudioDiagnosticsTracker {
  private inputSampleRate: number = 0;
  private outputSampleRate: number = 24000;
  private audioContextState: string = 'closed';
  private isStreaming: boolean = false;
  private noiseFloorDb: number = -60;
  private inputRmsDb: number = -60;
  private snrDb: number = 0;
  private isSpeechDetected: boolean = false;
  private speechProbability: number = 0;
  private processingLatencyMs: number = 0;
  private updatedAt = 0;
  private constraintsSupported = {
    echoCancellation: true,
    autoGainControl: true,
  };

  public updateContext(state: string, inputSampleRate: number): void {
    this.updatedAt = Date.now();
    this.audioContextState = state;
    this.inputSampleRate = inputSampleRate;
  }

  public updateStreaming(isStreaming: boolean): void {
    this.updatedAt = Date.now();
    this.isStreaming = isStreaming;
  }

  public updateMetrics(data: {
    noiseFloorDb: number;
    inputRmsDb: number;
    snrDb: number;
    isSpeechDetected: boolean;
    speechProbability: number;
    processingLatencyMs?: number;
  }): void {
    this.updatedAt = Date.now();
    this.noiseFloorDb = data.noiseFloorDb;
    this.inputRmsDb = data.inputRmsDb;
    this.snrDb = data.snrDb;
    this.isSpeechDetected = data.isSpeechDetected;
    this.speechProbability = data.speechProbability;
    if (data.processingLatencyMs !== undefined) {
      this.processingLatencyMs = data.processingLatencyMs;
    }
  }

  public updateConstraints(constraints: {
    echoCancellation: boolean;
    autoGainControl: boolean;
  }): void {
    this.updatedAt = Date.now();
    this.constraintsSupported = { ...constraints };
  }

  public getSnapshot(): AudioDiagnosticsInfo {
    return {
      updatedAt: this.updatedAt,
      inputSampleRate: this.inputSampleRate,
      outputSampleRate: this.outputSampleRate,
      audioContextState: this.audioContextState,
      isStreaming: this.isStreaming,
      noiseFloorDb: this.noiseFloorDb,
      inputRmsDb: this.inputRmsDb,
      snrDb: this.snrDb,
      isSpeechDetected: this.isSpeechDetected,
      speechProbability: Math.round(this.speechProbability * 100) / 100,
      processingLatencyMs: Math.round(this.processingLatencyMs * 10) / 10,
      constraintsSupported: { ...this.constraintsSupported },
    };
  }
}

