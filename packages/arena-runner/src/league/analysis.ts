import { DeterministicRandom } from '@arena/core';

export type MatchOutcomeKind = 'candidate_win' | 'opponent_win' | 'draw';

export interface ScoredMatch {
  readonly worldSeed: number;
  readonly score: 0 | 0.5 | 1;
}

export interface IntervalEstimate {
  readonly method: 'bootstrap' | 'tInterval';
  readonly clusters: number;
  readonly mean: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly standardDeviation: number | null;
  readonly effectSize: number | null;
}

const T_975 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131,
  2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
] as const;

export function tCritical975(degreesOfFreedom: number): number {
  if (degreesOfFreedom < 1) throw new RangeError('degrees of freedom must be positive');
  if (degreesOfFreedom <= 30) return T_975[degreesOfFreedom - 1]!;
  if (degreesOfFreedom <= 40) return 2.021;
  if (degreesOfFreedom <= 60) return 2.000;
  if (degreesOfFreedom <= 120) return 1.980;
  return 1.960;
}

export function scoreOutcome(side: MatchOutcomeKind): 0 | 0.5 | 1 {
  return side === 'candidate_win' ? 1 : side === 'draw' ? 0.5 : 0;
}

export function clusterMeans(matches: readonly ScoredMatch[]): readonly number[] {
  const bySeed = new Map<number, { sum: number; count: number }>();
  for (const match of matches) {
    const entry = bySeed.get(match.worldSeed) ?? { sum: 0, count: 0 };
    entry.sum += match.score;
    entry.count += 1;
    bySeed.set(match.worldSeed, entry);
  }
  return [...bySeed.entries()].sort(([a], [b]) => a - b).map(([, entry]) => entry.sum / entry.count);
}

export function estimateMean(
  matches: readonly ScoredMatch[],
  method: 'bootstrap' | 'tInterval',
  resamples: number,
  bootstrapSeed: number,
): IntervalEstimate {
  const means = clusterMeans(matches);
  const n = means.length;
  if (n === 0) return { method, clusters: 0, mean: null, lower: null, upper: null, standardDeviation: null, effectSize: null };
  const mean = means.reduce((sum, value) => sum + value, 0) / n;
  if (n === 1) {
    return { method, clusters: 1, mean, lower: null, upper: null, standardDeviation: null, effectSize: null };
  }
  const variance = means.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const standardDeviation = Math.sqrt(variance);
  const effectSize = standardDeviation === 0 ? null : (mean - 0.5) / standardDeviation;
  if (method === 'tInterval') {
    const half = tCritical975(n - 1) * standardDeviation / Math.sqrt(n);
    return { method, clusters: n, mean, lower: mean - half, upper: mean + half, standardDeviation, effectSize };
  }
  const random = DeterministicRandom.fromState(BigInt(bootstrapSeed) + 0x9e3779b97f4a7c15n);
  const samples: number[] = [];
  for (let round = 0; round < resamples; round += 1) {
    let sum = 0;
    for (let draw = 0; draw < n; draw += 1) sum += means[Number(random.nextU64() % BigInt(n))]!;
    samples.push(sum / n);
  }
  samples.sort((a, b) => a - b);
  const lower = samples[Math.floor(0.025 * (resamples - 1))]!;
  const upper = samples[Math.ceil(0.975 * (resamples - 1))]!;
  return { method, clusters: n, mean, lower, upper, standardDeviation, effectSize };
}
