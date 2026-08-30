import { describe, expect, it, vi } from 'vitest';
import { AudioDiagnosticsTracker } from '../audio/AudioDiagnostics';

describe('AudioDiagnosticsTracker', () => {
  it('starts without a telemetry timestamp', () => {
    const tracker = new AudioDiagnosticsTracker();
    expect(tracker.getSnapshot().updatedAt).toBe(0);
  });

  it('timestamps metric updates', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000);
    const tracker = new AudioDiagnosticsTracker();

    tracker.updateMetrics({ noiseFloorDb: -50, inputRmsDb: -20, snrDb: 30, isSpeechDetected: true, speechProbability: 0.9 });
    expect(tracker.getSnapshot().updatedAt).toBe(1000);
    tracker.updateStreaming(true);
    expect(tracker.getSnapshot().updatedAt).toBe(2000);
    vi.restoreAllMocks();
  });
});
