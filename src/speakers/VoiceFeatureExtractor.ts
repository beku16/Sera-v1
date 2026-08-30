export function extractVoiceFeatures(samples: Int16Array): number[] {
  if (!samples.length) return [0, 0, 0, 0, 0, 0];

  let sum = 0;
  let energy = 0;
  let crossings = 0;
  for (let index = 0; index < samples.length; index++) {
    const value = samples[index] / 32768;
    sum += value;
    energy += value * value;
    if (index > 0 && ((samples[index] >= 0) !== (samples[index - 1] >= 0))) crossings++;
  }

  const rms = Math.sqrt(energy / samples.length);
  const mean = sum / samples.length;
  const variance = Math.max(0, energy / samples.length - mean * mean);
  let bestCorrelation = 0;
  let bestLag = 0;
  for (let lag = 40; lag <= 400; lag += 4) {
    let correlation = 0;
    for (let index = lag; index < samples.length; index++) correlation += (samples[index] / 32768) * (samples[index - lag] / 32768);
    correlation /= Math.max(1, samples.length - lag);
    if (correlation > bestCorrelation) { bestCorrelation = correlation; bestLag = lag; }
  }
  return [
    rms,
    Math.min(1, crossings / samples.length * 4),
    Math.sqrt(variance),
    bestLag / 400,
    Math.max(0, Math.min(1, bestCorrelation / Math.max(1e-9, energy / samples.length))),
    Math.min(1, energy / samples.length * 4),
  ];
}

export function featureDistance(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return Number.POSITIVE_INFINITY;
  return Math.sqrt(left.reduce((sum, value, index) => sum + (value - right[index]) ** 2, 0));
}
