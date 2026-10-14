export const MIN_SAMPLES_FOR_P95 = 20;
export const MIN_SAMPLES_FOR_P99 = 100;

export interface SampleSummary {
  readonly count: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
  readonly insufficient_samples: readonly ('p95' | 'p99')[];
}

export function nearestRankPercentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) throw new RangeError('percentile of an empty sample');
  if (!(fraction > 0 && fraction <= 1)) throw new RangeError('percentile fraction must be in (0, 1]');
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function summarize(samples: readonly number[]): SampleSummary {
  const finite = samples.filter((value) => Number.isFinite(value));
  if (finite.length !== samples.length) throw new RangeError('samples must be finite');
  const sorted = [...finite].sort((left, right) => left - right);
  const insufficient: ('p95' | 'p99')[] = [];
  if (sorted.length < MIN_SAMPLES_FOR_P95) insufficient.push('p95');
  if (sorted.length < MIN_SAMPLES_FOR_P99) insufficient.push('p99');
  return Object.freeze({
    count: sorted.length,
    p50: sorted.length === 0 ? null : nearestRankPercentile(sorted, 0.5),
    p95: sorted.length < MIN_SAMPLES_FOR_P95 ? null : nearestRankPercentile(sorted, 0.95),
    p99: sorted.length < MIN_SAMPLES_FOR_P99 ? null : nearestRankPercentile(sorted, 0.99),
    max: sorted.length === 0 ? null : sorted[sorted.length - 1]!,
    insufficient_samples: Object.freeze(insufficient),
  });
}

export function mean(samples: readonly number[]): number | null {
  return samples.length === 0 ? null : samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

export function queueGrowthIsUnbounded(depths: readonly number[], minimumDepth = 64): boolean | null {
  if (depths.length < 9) return null;
  const third = Math.floor(depths.length / 3);
  const first = mean(depths.slice(0, third))!;
  const last = mean(depths.slice(depths.length - third))!;
  return last > minimumDepth && last > 2 * Math.max(first, 1);
}
