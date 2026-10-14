import { createHash } from 'node:crypto';
import { candidateSemanticId, validateCandidateParams } from '@arena/core';
import { mapBounded } from '../bounded.js';
import { canonicalJson } from '../canonical.js';
import { RunnerError } from '../errors.js';
import { qualityGates, renderGates, renderQualityTable, type MatchQuality, type QualityGateResult } from '../seat-quality.js';
import { estimateMean, scoreOutcome, type MatchOutcomeKind, type ScoredMatch } from './analysis.js';
import {
  opponentLabel,
  seedsOf,
  type CandidateSpec,
  type LeagueManifest,
  type OpponentSpec,
  type SeedManifest,
  type SeedSet,
} from './manifest.js';

export const LEAGUE_SEATS = [0, 1, 2, 3, 4, 5] as const;
export const ROUNDS = [0, 1] as const;
const CANDIDATE_SEATS_BY_ROUND: readonly (readonly number[])[] = [[0, 2, 4], [1, 3, 5]];

export interface MatchPlan {
  readonly matchId: string;
  readonly worldSeed: number;
  readonly round: 0 | 1;
  readonly candidate: CandidateSpec;
  readonly opponent: OpponentSpec;
  readonly candidateSeats: readonly number[];
  readonly opponentSeats: readonly number[];
}

export type MatchObservation =
  | Readonly<{
    status: 'completed';
    outcome: Readonly<{ kind: 'winner'; seat: number } | { kind: 'draw' }>;
    survivors: readonly number[];
    disconnects: number;
    degraded: boolean;
    attacks: Readonly<Record<number, Readonly<{ engaged: number; issued: number }>>>;
    quality?: MatchQuality | null;
    runId: string;
  }>
  | Readonly<{ status: 'failed'; reason: string; runId: string }>;

export interface MatchRunner {
  run(plan: MatchPlan, signal: AbortSignal): Promise<MatchObservation>;
}

export interface StoredMatch {
  readonly schema: 1;
  readonly match_id: string;
  readonly plan_digest: string;
  readonly candidate: string;
  readonly opponent: string;
  readonly world_seed: number;
  readonly round: 0 | 1;
  readonly candidate_seats: readonly number[];
  readonly concurrency?: number;
  readonly observation: MatchObservation;
}

export interface HeldoutLedgerEntry {
  readonly seed: number;
  readonly set: string;
  readonly league: string;
  readonly candidate_set_digest: string;
}

export interface LeagueStore {
  readMatch(matchId: string): Promise<StoredMatch | undefined>;
  writeMatch(match: StoredMatch): Promise<void>;
  readLedger(seeds: readonly number[]): Promise<readonly HeldoutLedgerEntry[]>;
  appendLedger(entries: readonly HeldoutLedgerEntry[]): Promise<void>;
  writeReport(report: object): Promise<string>;
}

export interface LeagueProgress {
  matchStarted?(plan: MatchPlan, index: number, total: number): void;
  matchSettled?(plan: MatchPlan, observation: MatchObservation, reused: boolean): void;
  summary?(text: string): void;
}

export function candidateSetDigest(manifest: LeagueManifest): string {
  const describe = (spec: CandidateSpec) => ({
    id: spec.id,
    semantic_id: candidateSemanticId(spec.id, validateCandidateParams(spec.id, spec.params)),
  });
  return createHash('sha256').update(canonicalJson({
    candidates: manifest.candidates.map(describe),
    opponents: manifest.opponents.map(describe),
  })).digest('hex');
}

export function resolveSeedSet(manifest: LeagueManifest, seeds: SeedManifest): SeedSet {
  const set = seeds.sets.find((entry) => entry.name === manifest.seedSet);
  if (set === undefined) throw new RunnerError('invalid_input', 'league manifest', { kind: 'unknown_seed_set' });
  return set;
}

export function planMatches(manifest: LeagueManifest, set: SeedSet): readonly MatchPlan[] {
  const plans: MatchPlan[] = [];
  for (const [candidateIndex, candidate] of manifest.candidates.entries()) {
    for (const [opponentIndex, opponent] of manifest.opponents.entries()) {
      for (const worldSeed of seedsOf(set)) {
        for (const round of ROUNDS) {
          const candidateSeats = CANDIDATE_SEATS_BY_ROUND[round]!;
          plans.push(Object.freeze({
            matchId: `c${candidateIndex}-o${opponentIndex}-s${worldSeed}-r${round}`,
            worldSeed, round, candidate, opponent,
            candidateSeats,
            opponentSeats: LEAGUE_SEATS.filter((seat) => !candidateSeats.includes(seat)),
          }));
        }
      }
    }
  }
  return Object.freeze(plans);
}

export function planDigest(plan: MatchPlan): string {
  const describe = (spec: CandidateSpec) => candidateSemanticId(spec.id, validateCandidateParams(spec.id, spec.params));
  return createHash('sha256').update(canonicalJson({
    seed: plan.worldSeed, round: plan.round, candidate: describe(plan.candidate), opponent: describe(plan.opponent),
    candidate_seats: plan.candidateSeats,
  })).digest('hex');
}

export async function runLeague(options: Readonly<{
  manifest: LeagueManifest;
  seeds: SeedManifest;
  store: LeagueStore;
  runner: MatchRunner;
  signal: AbortSignal;
  progress?: LeagueProgress;
  concurrency?: number;
}>): Promise<object> {
  const { manifest, store, runner, signal } = options;
  const set = resolveSeedSet(manifest, options.seeds);
  const digest = candidateSetDigest(manifest);
  const seedList = seedsOf(set);

  if (set.role === 'heldout') {
    const ledger = await store.readLedger(seedList);
    const consumed = ledger.filter((entry) => seedList.includes(entry.seed));
    const foreign = consumed.find((entry) => entry.candidate_set_digest !== digest || entry.league !== manifest.id);
    if (foreign !== undefined) {
      throw new RunnerError('invalid_input', 'held-out seeds', {
        kind: 'heldout_seed_already_consumed',
        field: `${foreign.seed}:${foreign.set}:${foreign.candidate_set_digest.slice(0, 12)}`,
      });
    }
    const fresh = seedList.filter((seed) => !consumed.some((entry) => entry.seed === seed));
    if (fresh.length > 0) {
      await store.appendLedger(fresh.map((seed) => ({
        seed, set: set.name, league: manifest.id, candidate_set_digest: digest,
      })));
    }
  }

  const concurrency = options.concurrency ?? 1;
  const plans = planMatches(manifest, set);
  const slots: (StoredMatch | undefined)[] = [];
  for (const plan of plans) {
    signal.throwIfAborted();
    const existing = await store.readMatch(plan.matchId);
    if (existing !== undefined && existing.plan_digest !== planDigest(plan)) {
      throw new RunnerError('corrupt_evidence', 'league results', { kind: 'league_results_plan_mismatch', field: plan.matchId });
    }
    slots.push(existing);
    if (existing !== undefined) options.progress?.matchSettled?.(plan, existing.observation, true);
  }
  const pending = plans.flatMap((plan, index) => slots[index] === undefined ? [{ plan, index }] : []);
  const running = Math.min(concurrency, Math.max(1, pending.length));
  await mapBounded(pending, concurrency, async ({ plan, index }) => {
    options.progress?.matchStarted?.(plan, index, plans.length);
    let observation: MatchObservation;
    try {
      observation = await runner.run(plan, signal);
    } catch (error) {
      if (error instanceof RunnerError && error.category === 'cancelled') throw error;
      if (signal.aborted) throw error;
      observation = Object.freeze({
        status: 'failed' as const,
        reason: error instanceof RunnerError ? error.source.kind : 'runner_exception',
        runId: plan.matchId,
      });
    }
    const record: StoredMatch = Object.freeze({
      schema: 1, match_id: plan.matchId, plan_digest: planDigest(plan),
      candidate: opponentLabel(plan.candidate), opponent: plan.opponent.label,
      world_seed: plan.worldSeed, round: plan.round, candidate_seats: plan.candidateSeats,
      concurrency: running, observation,
    });
    await store.writeMatch(record);
    slots[index] = record;
    options.progress?.matchSettled?.(plan, observation, false);
  }, signal);
  const stored = slots as readonly StoredMatch[];

  const report = buildReport(manifest, set, digest, plans, stored);
  const path = await store.writeReport(report);
  options.progress?.summary?.(renderLeagueQuality(plans, new Map(stored.map((entry) => [entry.match_id, entry]))));
  return { ...report, report_path: path };
}

interface PairTally {
  planned: number;
  completed: number;
  failed: number;
  failures: Record<string, number>;
  candidateWins: number;
  opponentWins: number;
  draws: number;
  degraded: number;
  disconnectMatches: number;
  candidateSurvivors: number;
  opponentSurvivors: number;
  candidateAttacks: { engaged: number; issued: number };
  opponentAttacks: { engaged: number; issued: number };
  scored: ScoredMatch[];
}

export function buildReport(
  manifest: LeagueManifest,
  set: SeedSet,
  digest: string,
  plans: readonly MatchPlan[],
  stored: readonly StoredMatch[],
): object {
  const byId = new Map(stored.map((entry) => [entry.match_id, entry]));
  const pairs = new Map<string, PairTally>();
  for (const plan of plans) {
    const key = `${opponentLabel(plan.candidate)} vs ${plan.opponent.label}`;
    const tally = pairs.get(key) ?? {
      planned: 0, completed: 0, failed: 0, failures: {}, candidateWins: 0, opponentWins: 0, draws: 0, degraded: 0,
      disconnectMatches: 0, candidateSurvivors: 0, opponentSurvivors: 0,
      candidateAttacks: { engaged: 0, issued: 0 }, opponentAttacks: { engaged: 0, issued: 0 }, scored: [],
    };
    pairs.set(key, tally);
    tally.planned += 1;
    const entry = byId.get(plan.matchId);
    const observation = entry?.observation;
    if (observation === undefined || observation.status === 'failed') {
      tally.failed += 1;
      const reason = observation === undefined ? 'not_run' : observation.reason;
      tally.failures[reason] = (tally.failures[reason] ?? 0) + 1;
      continue;
    }
    tally.completed += 1;
    if (observation.degraded) tally.degraded += 1;
    if (observation.disconnects > 0) tally.disconnectMatches += 1;
    let kind: MatchOutcomeKind;
    if (observation.outcome.kind === 'draw') kind = 'draw';
    else kind = plan.candidateSeats.includes(observation.outcome.seat) ? 'candidate_win' : 'opponent_win';
    if (kind === 'candidate_win') tally.candidateWins += 1;
    else if (kind === 'opponent_win') tally.opponentWins += 1;
    else tally.draws += 1;
    tally.scored.push({ worldSeed: plan.worldSeed, score: scoreOutcome(kind) });
    tally.candidateSurvivors += observation.survivors.filter((seat) => plan.candidateSeats.includes(seat)).length;
    tally.opponentSurvivors += observation.survivors.filter((seat) => plan.opponentSeats.includes(seat)).length;
    for (const [seatText, counts] of Object.entries(observation.attacks)) {
      const side = plan.candidateSeats.includes(Number(seatText)) ? tally.candidateAttacks : tally.opponentAttacks;
      side.engaged += counts.engaged;
      side.issued += counts.issued;
    }
  }

  const gates = manifest.promotion;
  const minSeeds = gates.minSeeds ?? (set.role === 'heldout' ? 24 : 12);
  const analysisOf = (scored: readonly ScoredMatch[]) =>
    estimateMean(scored, manifest.analysis.method, manifest.analysis.resamples, manifest.analysis.bootstrapSeed);
  const pairReports = [...pairs.entries()].map(([pair, tally]) => {
    const estimate = analysisOf(tally.scored);
    const seatSlots = tally.completed * 3;
    const candidateSurvival = seatSlots === 0 ? null : tally.candidateSurvivors / seatSlots;
    const opponentSurvival = seatSlots === 0 ? null : tally.opponentSurvivors / seatSlots;
    const issueRate = (value: { engaged: number; issued: number }) => value.engaged === 0 ? null : value.issued / value.engaged;
    const candidateIssue = issueRate(tally.candidateAttacks);
    const opponentIssue = issueRate(tally.opponentAttacks);
    const reasons: string[] = [];
    if (tally.failed > 0) reasons.push('incomplete_matches');
    if (tally.degraded > 0) reasons.push('degraded_matches');
    if (tally.disconnectMatches > 0) reasons.push('disconnects');
    if (estimate.clusters < minSeeds) reasons.push('insufficient_seeds');
    if (estimate.mean === null || estimate.lower === null) reasons.push('insufficient_world_seeds');
    else {
      if (estimate.mean < gates.minMean) reasons.push('mean_below_threshold');
      if (!(estimate.lower > gates.minLowerBound)) reasons.push('interval_lower_bound_not_above_threshold');
    }
    if (candidateSurvival !== null && opponentSurvival !== null
        && opponentSurvival - candidateSurvival > gates.maxSurvivalRegression) reasons.push('survival_regression');
    const attackGate = tally.candidateAttacks.engaged >= gates.minAttacksForGate
      && tally.opponentAttacks.engaged >= gates.minAttacksForGate;
    if (attackGate && candidateIssue !== null && opponentIssue !== null
        && opponentIssue - candidateIssue > gates.maxAttackIssueRegression) reasons.push('attack_issue_regression');
    return {
      pair,
      denominators: {
        planned: tally.planned, completed: tally.completed, censored_or_failed: tally.failed,
        failure_reasons: tally.failures, degraded: tally.degraded, matches_with_disconnects: tally.disconnectMatches,
        world_seeds: estimate.clusters,
      },
      outcomes: { candidate_wins: tally.candidateWins, opponent_wins: tally.opponentWins, draws: tally.draws },
      score: {
        mean: estimate.mean, lower: estimate.lower, upper: estimate.upper, method: estimate.method,
        standard_deviation: estimate.standardDeviation, effect_size_vs_even: estimate.effectSize,
        mean_if_censored_lost: tally.planned === 0 ? null
          : tally.scored.reduce((sum, match) => sum + match.score, 0) / tally.planned,
      },
      gates: {
        candidate_survival_fraction: candidateSurvival,
        opponent_survival_fraction: opponentSurvival,
        candidate_attack_issue_rate: candidateIssue,
        opponent_attack_issue_rate: opponentIssue,
        attack_gate_evaluated: attackGate,
      },
      verdict: reasons.length === 0 ? 'promote' : 'keep_baseline',
      verdict_reasons: reasons,
    };
  });
  const byCandidate = manifest.candidates.map((candidate) => {
    const label = opponentLabel(candidate);
    const own = pairReports.filter((entry) => entry.pair.startsWith(`${label} vs `));
    return {
      candidate: label,
      semantic_id: candidateSemanticId(candidate.id, validateCandidateParams(candidate.id, candidate.params)),
      verdict: own.length > 0 && own.every((entry) => entry.verdict === 'promote') ? 'promote' : 'keep_baseline',
    };
  });
  return {
    schema: 1,
    league: manifest.id,
    seed_set: { name: set.name, role: set.role, first: set.first, last: set.last },
    candidate_set_digest: digest,
    analysis: { method: manifest.analysis.method, confidence: 0.95, grouping: 'world_seed' },
    thresholds: { ...gates, minSeeds },
    pairs: pairReports,
    candidates: byCandidate,
    matches: matchRows(plans, byId),
    quality: leagueQuality(plans, byId),
  };
}

export function matchRows(plans: readonly MatchPlan[], byId: ReadonlyMap<string, StoredMatch>): readonly object[] {
  return plans.map((plan) => {
    const entry = byId.get(plan.matchId);
    const observation = entry?.observation;
    const base = {
      match_id: plan.matchId,
      world_seed: plan.worldSeed,
      round: plan.round,
      candidate: opponentLabel(plan.candidate),
      opponent: plan.opponent.label,
      concurrency: entry?.concurrency ?? null,
    };
    if (observation === undefined) return { ...base, status: 'not_run' };
    if (observation.status === 'failed') return { ...base, status: 'failed', reason: observation.reason, run_id: observation.runId };
    return {
      ...base,
      status: 'completed',
      outcome: observation.outcome,
      survivors: observation.survivors,
      degraded: observation.degraded,
      disconnects: observation.disconnects,
      run_id: observation.runId,
      quality: observation.quality ?? null,
    };
  });
}

export interface LeagueQualityReport {
  readonly gates: readonly QualityGateResult[];
  readonly matches_with_quality: number;
  readonly matches_planned: number;
  readonly max_concurrency: number;
  readonly timing_sensitive: boolean;
  readonly reasons_by_policy: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export function leagueQuality(plans: readonly MatchPlan[], byId: ReadonlyMap<string, StoredMatch>): LeagueQualityReport {
  const inputs = plans.map((plan) => {
    const observation = byId.get(plan.matchId)?.observation;
    return {
      label: plan.matchId,
      terminated: observation?.status === 'completed',
      quality: observation?.status === 'completed' ? observation.quality ?? null : null,
    };
  });
  const maxConcurrency = Math.max(1, ...plans.map((plan) => byId.get(plan.matchId)?.concurrency ?? 1));
  const reasons: Record<string, Record<string, number>> = {};
  for (const input of inputs) {
    for (const seat of input.quality?.seats ?? []) {
      const bucket = reasons[seat.candidate ?? 'default'] ??= {};
      for (const [reason, count] of Object.entries(seat.reasons)) bucket[reason] = (bucket[reason] ?? 0) + count;
    }
  }
  return {
    gates: qualityGates(inputs),
    matches_with_quality: inputs.filter((entry) => entry.quality !== null).length,
    matches_planned: plans.length,
    max_concurrency: maxConcurrency,
    timing_sensitive: maxConcurrency > 1,
    reasons_by_policy: reasons,
  };
}

export function renderLeagueQuality(plans: readonly MatchPlan[], byId: ReadonlyMap<string, StoredMatch>): string {
  const report = leagueQuality(plans, byId);
  const tables = plans.flatMap((plan) => {
    const observation = byId.get(plan.matchId)?.observation;
    if (observation?.status !== 'completed' || observation.quality === undefined || observation.quality === null) return [];
    return [{ label: `${plan.matchId} seed ${plan.worldSeed}`, quality: observation.quality,
      note: `concurrency ${byId.get(plan.matchId)?.concurrency ?? 1}` }];
  });
  return [
    renderQualityTable(tables),
    `quality gates over ${report.matches_with_quality}/${report.matches_planned} matches`
      + `${report.timing_sensitive ? ' (timing-sensitive outcomes: matches ran concurrently)' : ''}`,
    ...Object.entries(report.reasons_by_policy).map(([policy, counts]) =>
      `reasons ${policy}: ${Object.entries(counts).map(([reason, count]) => `${reason}=${count}`).join(' ')}`),
    renderGates(report.gates),
  ].join('\n');
}
