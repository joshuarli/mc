import { mapBounded } from '../bounded.js';
import { RunnerError } from '../errors.js';
import {
  leagueQuality, matchRows, planDigest, renderLeagueQuality,
  type MatchObservation, type MatchPlan, type MatchRunner, type StoredMatch,
} from './harness.js';
import type { CandidateSpec } from './manifest.js';

export interface QualityRunRequest {
  readonly scenario: string;
  readonly seeds: readonly number[];
  readonly competitors: number;
  readonly candidate: CandidateSpec;
  readonly baseline: CandidateSpec;
  readonly runTag: string;
}

export function planQualityMatches(request: QualityRunRequest): readonly MatchPlan[] {
  const seats = Array.from({ length: request.competitors }, (_, seat) => seat);
  const candidateSeats = seats.filter((seat) => seat % 2 === 0);
  const opponentSeats = seats.filter((seat) => seat % 2 === 1);
  return Object.freeze(request.seeds.map((worldSeed) => Object.freeze({
    matchId: `q${request.runTag}-s${worldSeed}`,
    worldSeed,
    round: 0 as const,
    candidate: request.candidate,
    opponent: { ...request.baseline, label: request.baseline.id },
    candidateSeats,
    opponentSeats,
  })));
}

export async function runQuality(options: Readonly<{
  request: QualityRunRequest;
  runner: MatchRunner;
  concurrency: number;
  signal: AbortSignal;
  progress?: (message: string) => void;
}>): Promise<Readonly<{ report: object; text: string }>> {
  const plans = planQualityMatches(options.request);
  const running = Math.min(options.concurrency, Math.max(1, plans.length));
  const stored = await mapBounded(plans, options.concurrency, async (plan, index): Promise<StoredMatch> => {
    options.progress?.(`match ${index + 1}/${plans.length} ${plan.matchId} seed ${plan.worldSeed} started`);
    let observation: MatchObservation;
    try {
      observation = await options.runner.run(plan, options.signal);
    } catch (error) {
      if (options.signal.aborted) throw error;
      if (error instanceof RunnerError && error.category === 'cancelled') throw error;
      observation = Object.freeze({
        status: 'failed' as const,
        reason: error instanceof RunnerError ? error.source.kind : 'runner_exception',
        runId: plan.matchId,
      });
    }
    options.progress?.(`${plan.matchId} ${observation.status}`);
    return Object.freeze({
      schema: 1 as const, match_id: plan.matchId, plan_digest: planDigest(plan),
      candidate: plan.candidate.id, opponent: plan.opponent.label,
      world_seed: plan.worldSeed, round: plan.round, candidate_seats: plan.candidateSeats,
      concurrency: running, observation,
    });
  }, options.signal);
  const byId = new Map(stored.map((entry) => [entry.match_id, entry]));
  const report = {
    schema: 1,
    kind: 'quality',
    scenario: options.request.scenario,
    candidate: options.request.candidate.id,
    baseline: options.request.baseline.id,
    candidate_seats: plans[0]?.candidateSeats ?? [],
    seeds: options.request.seeds,
    concurrency: running,
    matches: matchRows(plans, byId),
    quality: leagueQuality(plans, byId),
  };
  return { report, text: renderLeagueQuality(plans, byId) };
}
