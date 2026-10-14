import { createHash } from 'node:crypto';
import { mapBounded } from '../bounded.js';
import { canonicalJson } from '../canonical.js';
import { RunnerError } from '../errors.js';
import { renderQualityTable, type MatchQuality } from '../seat-quality.js';
import { estimateMean, scoreOutcome, type ScoredMatch } from './analysis.js';
import {
  planDigest,
  type MatchObservation, type MatchPlan, type MatchRunner, type StoredMatch,
} from './harness.js';
import { opponentLabel, type CandidateSpec } from './manifest.js';

export const DUEL_MAX_ROUNDS = 3;
export const DUEL_MAX_SEEDS = 24;

export const DUEL_ENGAGEMENT_OMITTED = Object.freeze([
  Object.freeze({
    field: 'swings',
    reason: 'match quality counts attack and shoot funnel entries together and does not record arm swings',
  }),
  Object.freeze({
    field: 'time_in_reach',
    reason: 'nearest opponent distance is on the explain timeline only, not on match quality',
  }),
  Object.freeze({
    field: 'heals',
    reason: 'match quality has no heal or consumption count',
  }),
  Object.freeze({
    field: 'bow_shots',
    reason: 'shoot funnel outcomes are not separated from attacks',
  }),
  Object.freeze({
    field: 'bow_hits',
    reason: 'damage causes are not retained on match quality',
  }),
  Object.freeze({
    field: 'first_strike',
    reason: 'damage event order is not retained on match quality',
  }),
]);

export interface DuelRunRequest {
  readonly scenario: string;
  readonly seeds: readonly number[];
  readonly rounds: number;
  readonly candidate: CandidateSpec;
  readonly opponent: CandidateSpec;
  readonly runTag: string;
}

export interface DuelPlannedMatch {
  readonly plan: MatchPlan;
  readonly duelRound: number;
  readonly assignment: 0 | 1;
}

export interface DuelSeatEngagement {
  readonly seat: number;
  readonly side: 'candidate' | 'opponent';
  readonly attacks_engaged: number;
  readonly attacks_issued: number;
  readonly attacks_rejected: number;
  readonly damage_dealt: number;
  readonly damage_taken: number;
  readonly damage_taken_from_competitors: number;
}

export interface DuelEngagement {
  readonly pvp_hits: number;
  readonly pvp_engagements: number;
  readonly seats: readonly DuelSeatEngagement[];
}

export function planDuelMatches(request: DuelRunRequest): readonly DuelPlannedMatch[] {
  const plans: DuelPlannedMatch[] = [];
  for (const worldSeed of request.seeds) {
    for (let duelRound = 0; duelRound < request.rounds; duelRound += 1) {
      for (const assignment of [0, 1] as const) {
        const candidateSeats = Object.freeze(assignment === 0 ? [0] : [1]);
        const opponentSeats = Object.freeze(assignment === 0 ? [1] : [0]);
        plans.push(Object.freeze({
          duelRound,
          assignment,
          plan: Object.freeze({
            matchId: `d${request.runTag}-s${worldSeed}-r${duelRound}-a${assignment}`,
            worldSeed,
            round: assignment,
            candidate: request.candidate,
            opponent: Object.freeze({ ...request.opponent, label: opponentLabel(request.opponent) }),
            candidateSeats,
            opponentSeats,
          }),
        }));
      }
    }
  }
  return Object.freeze(plans);
}

export function duelPlanDigest(plan: MatchPlan, duelRound: number): string {
  return createHash('sha256').update(canonicalJson({
    seat_plan: planDigest(plan),
    duel_round: duelRound,
  })).digest('hex');
}

export function scoreDuelMatch(plan: MatchPlan, observation: MatchObservation | undefined): 0 | 0.5 | 1 | null {
  if (observation === undefined || observation.status !== 'completed') return null;
  if (observation.outcome.kind === 'draw') return scoreOutcome('draw');
  return scoreOutcome(plan.candidateSeats.includes(observation.outcome.seat) ? 'candidate_win' : 'opponent_win');
}

export function duelEngagement(plan: MatchPlan, quality: MatchQuality | null | undefined): DuelEngagement | null {
  if (quality === null || quality === undefined) return null;
  const seats = [...plan.candidateSeats, ...plan.opponentSeats]
    .filter((seat, index, all) => all.indexOf(seat) === index)
    .sort((left, right) => left - right)
    .flatMap((seat): readonly DuelSeatEngagement[] => {
      const row = quality.seats.find((entry) => entry.seat === seat);
      if (row === undefined) return [];
      return [Object.freeze({
        seat,
        side: plan.candidateSeats.includes(seat) ? 'candidate' as const : 'opponent' as const,
        attacks_engaged: row.attacks.engaged,
        attacks_issued: row.attacks.issued,
        attacks_rejected: row.attacks.rejected,
        damage_dealt: row.damage.dealt,
        damage_taken: row.damage.taken,
        damage_taken_from_competitors: row.damage.taken_from_competitors,
      })];
    });
  return Object.freeze({ pvp_hits: quality.pvp_hits, pvp_engagements: quality.pvp_engagements, seats: Object.freeze(seats) });
}

export async function runDuel(options: Readonly<{
  request: DuelRunRequest;
  runner: MatchRunner;
  concurrency: number;
  signal: AbortSignal;
  progress?: (message: string) => void;
}>): Promise<Readonly<{ report: DuelReport; text: string }>> {
  const plans = planDuelMatches(options.request);
  const running = Math.min(options.concurrency, Math.max(1, plans.length));
  const stored = await mapBounded(plans, options.concurrency, async (planned, index): Promise<DuelStoredMatch> => {
    const plan = planned.plan;
    options.progress?.(`match ${index + 1}/${plans.length} ${plan.matchId} seed ${plan.worldSeed} round ${planned.duelRound} started`);
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
      schema: 1 as const,
      match_id: plan.matchId,
      plan_digest: duelPlanDigest(plan, planned.duelRound),
      candidate: opponentLabel(plan.candidate),
      opponent: plan.opponent.label,
      world_seed: plan.worldSeed,
      round: plan.round,
      candidate_seats: plan.candidateSeats,
      concurrency: running,
      observation,
      duelRound: planned.duelRound,
      assignment: planned.assignment,
    });
  }, options.signal);
  const report = duelReport(options.request, plans, stored, running);
  return { report, text: renderDuel(plans, stored, report) };
}

interface DuelStoredMatch extends StoredMatch {
  readonly duelRound: number;
  readonly assignment: 0 | 1;
}

interface DuelRoundEngagement {
  readonly candidate_attacks_engaged: number | null;
  readonly candidate_attacks_issued: number | null;
  readonly candidate_attacks_rejected: number | null;
  readonly candidate_damage_dealt: number | null;
  readonly candidate_damage_taken: number | null;
  readonly pvp_hits: number | null;
  readonly pvp_engagements: number | null;
  readonly matches_with_evidence: number;
}

export interface DuelReport {
  readonly schema: 1;
  readonly kind: 'duel';
  readonly scenario: string;
  readonly candidate: string;
  readonly opponent: string;
  readonly seeds: readonly number[];
  readonly rounds: number;
  readonly concurrency: number;
  readonly timing_sensitive: boolean;
  readonly analysis: Readonly<{ method: 'tInterval'; confidence: 0.95; grouping: 'world_seed' }>;
  readonly denominators: Readonly<{
    planned: number;
    completed: number;
    censored_or_failed: number;
    failure_reasons: Readonly<Record<string, number>>;
    degraded: number;
    matches_with_disconnects: number;
  }>;
  readonly outcomes: Readonly<{ wins: number; losses: number; draws: number }>;
  readonly score: Readonly<{
    mean: number | null;
    lower: number | null;
    upper: number | null;
    method: 'tInterval';
    standard_deviation: number | null;
    effect_size_vs_even: number | null;
    clusters: number;
    mean_if_censored_lost: number | null;
  }>;
  readonly by_seed: readonly Readonly<{ world_seed: number; scores: readonly (0 | 0.5 | 1 | null)[]; cluster_mean: number | null }>[];
  readonly engagement_omitted: typeof DUEL_ENGAGEMENT_OMITTED;
  readonly matches: readonly object[];
  readonly round_log: readonly object[];
}

function duelReport(
  request: DuelRunRequest,
  plans: readonly DuelPlannedMatch[],
  stored: readonly DuelStoredMatch[],
  running: number,
): DuelReport {
  const byId = new Map(stored.map((entry) => [entry.match_id, entry]));
  const failures: Record<string, number> = {};
  let completed = 0;
  let failed = 0;
  let degraded = 0;
  let disconnectMatches = 0;
  let wins = 0;
  let losses = 0;
  let draws = 0;
  const scored: ScoredMatch[] = [];
  let scoredSum = 0;
  const matches = plans.map((planned) => {
    const plan = planned.plan;
    const entry = byId.get(plan.matchId);
    const observation = entry?.observation;
    const score = scoreDuelMatch(plan, observation);
    const engagement = duelEngagement(plan, observation?.quality);
    if (observation === undefined || observation.status === 'failed') {
      failed += 1;
      const reason = observation === undefined ? 'not_run' : observation.reason;
      failures[reason] = (failures[reason] ?? 0) + 1;
    } else {
      completed += 1;
      if (observation.degraded) degraded += 1;
      if (observation.disconnects > 0) disconnectMatches += 1;
      if (score === 1) wins += 1;
      else if (score === 0) losses += 1;
      else draws += 1;
      scored.push({ worldSeed: plan.worldSeed, score: score! });
      scoredSum += score!;
    }
    const base = {
      match_id: plan.matchId,
      plan_digest: entry?.plan_digest ?? duelPlanDigest(plan, planned.duelRound),
      world_seed: plan.worldSeed,
      round: planned.duelRound,
      assignment: planned.assignment,
      candidate: opponentLabel(plan.candidate),
      opponent: plan.opponent.label,
      candidate_seats: plan.candidateSeats,
      opponent_seats: plan.opponentSeats,
      concurrency: entry?.concurrency ?? null,
      run_id: observation?.runId ?? null,
      score,
      engagement,
      quality: observation?.quality ?? null,
    };
    if (observation === undefined) return { ...base, status: 'not_run' };
    if (observation.status === 'failed') return { ...base, status: 'failed', reason: observation.reason };
    return {
      ...base,
      status: 'completed',
      outcome: observation.outcome,
      survivors: observation.survivors,
      degraded: observation.degraded,
      disconnects: observation.disconnects,
    };
  });
  const bySeed = request.seeds.map((worldSeed) => {
    const rows = plans.filter((planned) => planned.plan.worldSeed === worldSeed);
    const scores = rows.map((planned) => scoreDuelMatch(planned.plan, byId.get(planned.plan.matchId)?.observation));
    const present = scores.filter((score): score is 0 | 0.5 | 1 => score !== null);
    return Object.freeze({
      world_seed: worldSeed,
      scores,
      cluster_mean: present.length === 0 ? null : present.reduce((sum, score) => sum + score, 0 as number) / present.length,
    });
  });
  const estimate = estimateMean(scored, 'tInterval', 0, 0);
  const roundLog = roundEntries(plans, byId);
  return {
    schema: 1,
    kind: 'duel',
    scenario: request.scenario,
    candidate: request.candidate.id,
    opponent: request.opponent.id,
    seeds: request.seeds,
    rounds: request.rounds,
    concurrency: running,
    timing_sensitive: running > 1,
    analysis: { method: 'tInterval', confidence: 0.95, grouping: 'world_seed' },
    denominators: {
      planned: plans.length,
      completed,
      censored_or_failed: failed,
      failure_reasons: failures,
      degraded,
      matches_with_disconnects: disconnectMatches,
    },
    outcomes: { wins, losses, draws },
    score: {
      mean: estimate.mean,
      lower: estimate.lower,
      upper: estimate.upper,
      method: 'tInterval',
      standard_deviation: estimate.standardDeviation,
      effect_size_vs_even: estimate.effectSize,
      clusters: estimate.clusters,
      mean_if_censored_lost: plans.length === 0 ? null : scoredSum / plans.length,
    },
    by_seed: bySeed,
    engagement_omitted: DUEL_ENGAGEMENT_OMITTED,
    matches,
    round_log: roundLog,
  };
}

function roundEntries(plans: readonly DuelPlannedMatch[], byId: ReadonlyMap<string, DuelStoredMatch>): readonly object[] {
  const groups: { seed: number; round: number; planned: DuelPlannedMatch[] }[] = [];
  for (const planned of plans) {
    const last = groups.at(-1);
    if (last === undefined || last.seed !== planned.plan.worldSeed || last.round !== planned.duelRound) {
      groups.push({ seed: planned.plan.worldSeed, round: planned.duelRound, planned: [planned] });
    } else last.planned.push(planned);
  }
  return groups.map((group) => {
    const engagements = group.planned.map((planned) => {
      const observation = byId.get(planned.plan.matchId)?.observation;
      return duelEngagement(planned.plan, observation?.quality);
    });
    return {
      round: group.round,
      world_seed: group.seed,
      run_ids: group.planned.map((planned) => {
        const observation = byId.get(planned.plan.matchId)?.observation;
        return {
          assignment: planned.assignment,
          match_id: planned.plan.matchId,
          run_id: observation?.runId ?? null,
          status: observation === undefined ? 'not_run' : observation.status,
        };
      }),
      engagement: summarizeEngagement(engagements),
    };
  });
}

function summarizeEngagement(engagements: readonly (DuelEngagement | null)[]): DuelRoundEngagement {
  const present = engagements.filter((entry): entry is DuelEngagement => entry !== null);
  if (present.length === 0) {
    return {
      candidate_attacks_engaged: null, candidate_attacks_issued: null, candidate_attacks_rejected: null,
      candidate_damage_dealt: null, candidate_damage_taken: null, pvp_hits: null, pvp_engagements: null,
      matches_with_evidence: 0,
    };
  }
  const candidates = present.flatMap((entry) => entry.seats.filter((seat) => seat.side === 'candidate'));
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  const candidateSum = (read: (seat: DuelSeatEngagement) => number, places: 0 | 1) => {
    if (candidates.length === 0) return null;
    const total = sum(candidates.map(read));
    return places === 1 ? round1(total) : total;
  };
  return {
    candidate_attacks_engaged: candidateSum((seat) => seat.attacks_engaged, 0),
    candidate_attacks_issued: candidateSum((seat) => seat.attacks_issued, 0),
    candidate_attacks_rejected: candidateSum((seat) => seat.attacks_rejected, 0),
    candidate_damage_dealt: candidateSum((seat) => seat.damage_dealt, 1),
    candidate_damage_taken: candidateSum((seat) => seat.damage_taken, 1),
    pvp_hits: sum(present.map((entry) => entry.pvp_hits)),
    pvp_engagements: sum(present.map((entry) => entry.pvp_engagements)),
    matches_with_evidence: present.length,
  };
}

function renderDuel(plans: readonly DuelPlannedMatch[], stored: readonly DuelStoredMatch[], report: DuelReport): string {
  const byId = new Map(stored.map((entry) => [entry.match_id, entry]));
  const score = report.score;
  const lines = [
    `duel ${report.candidate} vs ${report.opponent}`,
    `planned ${report.denominators.planned} completed ${report.denominators.completed} failed ${report.denominators.censored_or_failed}`,
    `score mean ${score.mean ?? 'n/a'} lower ${score.lower ?? 'n/a'} upper ${score.upper ?? 'n/a'} method ${score.method} clusters ${score.clusters}`,
    `mean if censored lost ${score.mean_if_censored_lost ?? 'n/a'}`,
    `grouped by world seed across both seat assignments${report.timing_sensitive ? ' (timing-sensitive outcomes: matches ran concurrently)' : ''}`,
    `engagement omitted: ${DUEL_ENGAGEMENT_OMITTED.map((entry) => `${entry.field} (${entry.reason})`).join('; ')}`,
  ];
  for (const round of report.round_log) {
    const entry = round as {
      round: number; world_seed: number;
      run_ids: readonly { assignment: 0 | 1; match_id: string; run_id: string | null; status: string }[];
      engagement: DuelRoundEngagement;
    };
    const runs = entry.run_ids.map((run) =>
      `a${run.assignment} ${run.status} run_id ${run.run_id ?? 'none'}`).join('; ');
    const engagement = entry.engagement;
    lines.push(`round ${entry.round} seed ${entry.world_seed}: ${runs}`);
    lines.push(`  candidate attacks engaged/issued/rejected ${engagement.candidate_attacks_engaged ?? 'n/a'}`
      + `/${engagement.candidate_attacks_issued ?? 'n/a'}/${engagement.candidate_attacks_rejected ?? 'n/a'}`
      + ` damage dealt/taken ${engagement.candidate_damage_dealt ?? 'n/a'}/${engagement.candidate_damage_taken ?? 'n/a'}`
      + ` pvp hits ${engagement.pvp_hits ?? 'n/a'} engagements ${engagement.pvp_engagements ?? 'n/a'}`
      + ` evidence ${engagement.matches_with_evidence}/${entry.run_ids.length}`);
  }
  for (const [reason, count] of Object.entries(report.denominators.failure_reasons)) lines.push(`failure ${reason} ${count}`);
  const tables = plans.flatMap((planned) => {
    const observation = byId.get(planned.plan.matchId)?.observation;
    if (observation?.quality === undefined || observation.quality === null) return [];
    const failure = observation.status === 'failed' ? `, FAILED ${observation.reason}, partial evidence` : '';
    return [{
      label: `${planned.plan.matchId} seed ${planned.plan.worldSeed} round ${planned.duelRound}`,
      quality: observation.quality,
      note: `concurrency ${byId.get(planned.plan.matchId)?.concurrency ?? 1}${failure}`,
    }];
  });
  if (tables.length > 0) lines.push(renderQualityTable(tables));
  return lines.join('\n');
}

const round1 = (value: number): number => Math.round(value * 10) / 10;
