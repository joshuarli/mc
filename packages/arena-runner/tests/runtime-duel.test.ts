import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { RunnerError } from '../src/errors.js';
import { estimateMean } from '../src/league/analysis.js';
import { DUEL_POOL_IDS } from '@arena/core';
import {
  DUEL_ENGAGEMENT_OMITTED, duelPlanDigest, planDuelMatches, runDuel, scoreDuelMatch,
  type DuelEngagement,
} from '../src/league/duel.js';
import { planDigest, type MatchObservation, type MatchPlan, type MatchRunner } from '../src/league/harness.js';
import { seatOpponent } from '../src/league/live-runner.js';
import { runCli } from '../src/index.js';
import type { MatchQuality, SeatQuality } from '../src/seat-quality.js';

const never = new AbortController().signal;
const request = {
  scenario: 'scenarios/duel.toml',
  seeds: [10, 11],
  rounds: 2,
  candidate: { id: 'improved' as const, params: {} },
  opponent: { kind: 'candidate' as const, spec: { id: 'baseline' as const, params: {} } },
  runTag: 'tag',
};

function attacks(engaged: number, issued: number): SeatQuality['attacks'] {
  return {
    engaged, issued, rejected: engaged - issued, rejected_by_cause: {}, self_inflicted_rejected: 0,
  };
}

function seat(seatNumber: number, candidate: string, dealt: number, taken: number, engaged: number, issued: number): SeatQuality {
  return {
    seat: seatNumber,
    candidate,
    decisions: 1,
    loot: { actions_started: 0, containers_opened: 0, drops_collected: 0, failed: 0, looted: false },
    distance_blocks: 0,
    idle: { ticks: 0, unexplained_ticks: 0, max_unexplained_span_ticks: 0, trapped_ticks: 0, max_trapped_span_ticks: 0, by_reason: {} },
    attacks: attacks(engaged, issued),
    damage: { dealt, taken, taken_from_competitors: taken },
    time_alive_ticks: 20,
    death: null,
    pvp_share: taken === 0 ? null : 1,
    reasons: {},
  };
}

function quality(candidateSeat: number, hits: number): MatchQuality {
  const opponentSeat = candidateSeat === 0 ? 1 : 0;
  return {
    schema: 1,
    end_tick: 40,
    seats: [
      seat(candidateSeat, 'improved', 4.5, 1, 3, 2),
      seat(opponentSeat, 'baseline', 1, 4.5, 2, 1),
    ].sort((left, right) => left.seat - right.seat),
    pvp_engagements: 1,
    pvp_hits: hits,
    reasons: {},
    eliminations: { total: 0, pvp: 0, by_cause: {} },
  };
}

function winner(plan: MatchPlan, hits: number): MatchObservation {
  return {
    status: 'completed',
    outcome: { kind: 'winner', seat: plan.candidateSeats[0]! },
    survivors: [plan.candidateSeats[0]!],
    disconnects: 0,
    degraded: false,
    attacks: {},
    quality: quality(plan.candidateSeats[0]!, hits),
    runId: `run-${plan.matchId}`,
  };
}

test('duel plans both seat assignments per seed and round', () => {
  const plans = planDuelMatches(request);
  assert.equal(plans.length, 8);
  assert.deepEqual(plans.map((planned) => planned.plan.matchId), [
    'dtag-s10-r0-a0', 'dtag-s10-r0-a1', 'dtag-s10-r1-a0', 'dtag-s10-r1-a1',
    'dtag-s11-r0-a0', 'dtag-s11-r0-a1', 'dtag-s11-r1-a0', 'dtag-s11-r1-a1',
  ]);
  assert.deepEqual(plans[0]!.plan.candidateSeats, [0]);
  assert.deepEqual(plans[0]!.plan.opponentSeats, [1]);
  assert.equal(plans[0]!.plan.round, 0);
  assert.deepEqual(plans[1]!.plan.candidateSeats, [1]);
  assert.deepEqual(plans[1]!.plan.opponentSeats, [0]);
  assert.equal(plans[1]!.assignment, 1);
  assert.equal(plans[2]!.duelRound, 1);
  assert.equal(planDigest(plans[0]!.plan), planDigest(plans[2]!.plan));
  assert.notEqual(duelPlanDigest(plans[0]!.plan, 0), duelPlanDigest(plans[2]!.plan, 1));
  const opponentWin: MatchObservation = {
    status: 'completed', outcome: { kind: 'winner', seat: 1 }, survivors: [1],
    disconnects: 0, degraded: false, attacks: {}, runId: 'r',
  };
  assert.equal(scoreDuelMatch(plans[0]!.plan, opponentWin), 0);
  assert.equal(scoreDuelMatch(plans[0]!.plan, { ...opponentWin, outcome: { kind: 'draw' } }), 0.5);
  assert.equal(scoreDuelMatch(plans[1]!.plan, { ...opponentWin, outcome: { kind: 'winner', seat: 1 } }), 1);
  assert.equal(scoreDuelMatch(plans[0]!.plan, { status: 'failed', reason: 'paper_exited', runId: 'r' }), null);
});

test('duel scores paired seeds, keeps failures, and omits engagement fields the trace helpers do not retain', async () => {
  let live = 0;
  let peak = 0;
  const runner: MatchRunner = {
    async run(plan) {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 15));
      live -= 1;
      if (plan.worldSeed === 11 && plan.round === 1) throw new RunnerError('runtime_failure', 'duel match', { kind: 'paper_exited' });
      if (plan.worldSeed === 11 && plan.round === 0) {
        return {
          status: 'completed', outcome: { kind: 'draw' }, survivors: [0, 1],
          disconnects: 0, degraded: false, attacks: {}, quality: quality(0, 2), runId: `run-${plan.matchId}`,
        };
      }
      return winner(plan, plan.round === 0 ? 3 : 1);
    },
  };
  const oneRound = { ...request, rounds: 1 };
  const result = await runDuel({ request: oneRound, runner, concurrency: 2, signal: never });
  const report = result.report;
  assert.equal(peak, 2);
  assert.equal(report.timing_sensitive, true);
  assert.equal(report.concurrency, 2);
  assert.deepEqual(report.matches.map((row) => (row as { status: string }).status), ['completed', 'completed', 'completed', 'failed']);
  assert.deepEqual(report.by_seed.map((entry) => entry.cluster_mean), [1, 0.5]);
  const scored = [
    { worldSeed: 10, score: 1 as const }, { worldSeed: 10, score: 1 as const }, { worldSeed: 11, score: 0.5 as const },
  ];
  const estimate = estimateMean(scored, 'tInterval', 0, 0);
  assert.equal(report.score.mean, estimate.mean);
  assert.equal(report.score.lower, estimate.lower);
  assert.equal(report.score.upper, estimate.upper);
  assert.equal(report.score.clusters, 2);
  assert.equal(report.score.method, 'tInterval');
  assert.equal(report.score.mean_if_censored_lost, (1 + 1 + 0.5) / 4);
  assert.deepEqual(report.denominators.failure_reasons, { paper_exited: 1 });
  assert.equal(report.outcomes.wins, 2);
  assert.equal(report.outcomes.draws, 1);
  assert.equal(report.outcomes.losses, 0);
  const failed = report.matches[3] as { run_id: string; score: null; plan_digest: string; engagement: null };
  assert.equal(failed.score, null);
  assert.equal(failed.engagement, null);
  assert.equal(failed.run_id, 'dtag-s11-r0-a1');
  assert.equal(failed.plan_digest, duelPlanDigest(planDuelMatches(oneRound)[3]!.plan, 0));
  const first = report.matches[0] as { engagement: DuelEngagement; run_id: string };
  assert.equal(first.run_id, 'run-dtag-s10-r0-a0');
  assert.equal(first.engagement.pvp_hits, 3);
  assert.equal(first.engagement.seats.find((seat) => seat.side === 'candidate')!.damage_dealt, 4.5);
  assert.equal(Object.hasOwn(first.engagement, 'swings'), false);
  const round = report.round_log[0] as { engagement: { candidate_damage_dealt: number; pvp_hits: number; matches_with_evidence: number }; run_ids: { run_id: string }[] };
  assert.equal(round.engagement.candidate_damage_dealt, 9);
  assert.equal(round.engagement.pvp_hits, 4);
  assert.equal(round.engagement.matches_with_evidence, 2);
  assert.deepEqual(round.run_ids.map((entry) => entry.run_id), ['run-dtag-s10-r0-a0', 'run-dtag-s10-r0-a1']);
  const partial = report.round_log[1] as { engagement: { matches_with_evidence: number; pvp_hits: number } };
  assert.equal(partial.engagement.matches_with_evidence, 1);
  assert.equal(partial.engagement.pvp_hits, 2);
  assert.deepEqual(report.engagement_omitted.map((entry) => entry.field), DUEL_ENGAGEMENT_OMITTED.map((entry) => entry.field));
  assert.match(result.text, /run_id run-dtag-s10-r0-a0/);
  assert.match(result.text, /swings \(/);
  assert.match(result.text, /first_strike \(/);
  assert.match(result.text, /timing-sensitive/);
  assert.equal(report.analysis.grouping, 'world_seed');
  assert.equal(Object.hasOwn(report, 'pool_version'), false);
});

test('duel plans the opponent pool once per member across the swap matrix', async () => {
  const single = planDuelMatches(request);
  const pooled = { ...request, opponent: { kind: 'pool' as const } };
  const plans = planDuelMatches(pooled);
  const matrix = request.seeds.length * request.rounds * 2;
  assert.equal(plans.length, DUEL_POOL_IDS.length * matrix);
  assert.equal(plans.length, single.length * DUEL_POOL_IDS.length);
  for (const [index, id] of DUEL_POOL_IDS.entries()) {
    const rows = plans.slice(index * matrix, (index + 1) * matrix);
    assert.ok(rows.every((planned) => planned.plan.opponent.label === id));
    assert.deepEqual(rows[0]!.plan.candidateSeats, [0]);
    assert.deepEqual(rows[1]!.plan.candidateSeats, [1]);
    assert.equal(rows[0]!.plan.matchId, `dtag-m${index}-s10-r0-a0`);
  }
  assert.notEqual(duelPlanDigest(plans[0]!.plan, 0), duelPlanDigest(plans[matrix]!.plan, 0));
  const againstSelf = planDuelMatches({
    ...pooled,
    candidate: { id: 'baseline', params: {} },
  });
  assert.equal(againstSelf.length, plans.length);
  assert.ok(againstSelf.some((planned) => planned.plan.opponent.label === 'baseline'));
  const member = planDuelMatches({ ...request, opponent: { kind: 'member', id: 'strafer' } });
  assert.equal(member.length, matrix);
  assert.ok(member.every((planned) => planned.plan.opponent.label === 'strafer'));
  assert.deepEqual(seatOpponent(member[0]!.plan.opponent), { id: 'strafer', params: {} });
  assert.equal(plans[plans.length - 1]!.plan.opponent.poolPartner, undefined);
  assert.deepEqual(seatOpponent(plans[plans.length - 1]!.plan.opponent), { id: 'baseline', params: {} });

  const runner: MatchRunner = {
    async run(plan) {
      return winner(plan, 1);
    },
  };
  const result = await runDuel({
    request: { ...pooled, rounds: 1 },
    runner,
    concurrency: 1,
    signal: never,
  });
  const report = result.report;
  const planned = planDuelMatches({ ...pooled, rounds: 1 });
  assert.equal(report.schema, 1);
  assert.equal(report.opponent, 'pool');
  assert.equal(report.pool_version, 1);
  assert.equal(report.matches.length, planned.length);
  assert.deepEqual(report.matches.map((row) => (row as { opponent: string }).opponent), planned.map((row) => row.plan.opponent.label));
  const scored = planned.map((row) => ({ worldSeed: row.plan.worldSeed, score: 1 as const }));
  const estimate = estimateMean(scored, 'tInterval', 0, 0);
  assert.equal(report.score.mean, estimate.mean);
  assert.equal(report.score.lower, estimate.lower);
  assert.equal(report.score.upper, estimate.upper);
  assert.equal(report.score.clusters, estimate.clusters);
  assert.equal(report.score.method, 'tInterval');
  assert.equal(report.analysis.grouping, 'world_seed');

  const rejected = await runCli([
    'duel', '--scenario', 'scenarios/duel.toml', '--candidate', 'strafer', '--opponent', 'pool',
    '--seeds', '1', '--rounds', '1', '--accept-minecraft-eula',
  ]);
  assert.equal(rejected.kind, 'failure');
  if (rejected.kind === 'failure') assert.equal(JSON.parse(rejected.stderr).error.source.kind, 'duel_unknown_candidate');
  const accepted = await runCli([
    'duel', '--scenario', 'scenarios/duel.toml', '--candidate', 'improved', '--opponent', 'pool',
    '--seeds', '1', '--rounds', '1',
  ]);
  assert.equal(accepted.kind, 'failure');
  if (accepted.kind === 'failure') assert.equal(JSON.parse(accepted.stderr).error.source.kind, 'missing_eula');
});

test('duel command rejects a non-duel roster and implied eula acceptance', async () => {
  const rounds = await runCli([
    'duel', '--scenario', 'scenarios/duel.toml', '--candidate', 'improved', '--opponent', 'baseline',
    '--seeds', '1', '--rounds', '4', '--accept-minecraft-eula',
  ]);
  assert.equal(rounds.kind, 'failure');
  if (rounds.kind === 'failure') assert.equal(JSON.parse(rounds.stderr).error.source.kind, 'duel_invalid_rounds');

  const tooManySeeds = Array.from({ length: 25 }, (_, index) => String(index + 1)).join(',');
  const seeds = await runCli([
    'duel', '--scenario', 'scenarios/duel.toml', '--candidate', 'improved', '--opponent', 'baseline',
    '--seeds', tooManySeeds, '--rounds', '1', '--accept-minecraft-eula',
  ]);
  assert.equal(seeds.kind, 'failure');
  if (seeds.kind === 'failure') assert.equal(JSON.parse(seeds.stderr).error.source.kind, 'duel_invalid_seeds');

  const unaccepted = await runCli([
    'duel', '--scenario', 'scenarios/duel.toml', '--candidate', 'improved', '--opponent', 'baseline',
    '--seeds', '1', '--rounds', '1',
  ]);
  assert.equal(unaccepted.kind, 'failure');
  if (unaccepted.kind === 'failure') {
    assert.equal(unaccepted.exitCode, 3);
    assert.equal(JSON.parse(unaccepted.stderr).error.source.kind, 'missing_eula');
  }

  const help = await runCli(['help']);
  assert.equal(help.kind, 'success');
  if (help.kind === 'success') {
    const commands = JSON.parse(help.stdout).commands as Record<string, string>;
    assert.equal(Object.hasOwn(commands, 'duel --scenario <path> --candidate <id> --opponent <id|pool> --seeds <a,b,c> --rounds <1-3> --accept-minecraft-eula [--concurrency <1-4>]'), true);
  }

  const previous = {
    helper: process.env.ARENA_FS_HELPER,
    java: process.env.ARENA_JAVA_HOME,
    paper: process.env.ARENA_PAPER_JAR,
    plugin: process.env.ARENA_PLUGIN_JAR,
  };
  process.env.ARENA_FS_HELPER = resolve(process.cwd(), '.work/arena-fs/arena-fs');
  delete process.env.ARENA_JAVA_HOME;
  delete process.env.ARENA_PAPER_JAR;
  delete process.env.ARENA_PLUGIN_JAR;
  try {
    const wide = await runCli([
      'duel', '--scenario', 'scenarios/hunger-six.toml', '--candidate', 'melee-duelist', '--opponent', 'baseline',
      '--seeds', '481516', '--rounds', '1', '--accept-minecraft-eula',
    ]);
    assert.equal(wide.kind, 'failure');
    if (wide.kind === 'failure') assert.equal(JSON.parse(wide.stderr).error.source.kind, 'duel_requires_two_competitors');

    const otherMode = await runCli([
      'duel', '--scenario', 'scenarios/civilization-six.toml', '--candidate', 'improved', '--opponent', 'baseline',
      '--seeds', '1', '--rounds', '1', '--accept-minecraft-eula',
    ]);
    assert.equal(otherMode.kind, 'failure');
    if (otherMode.kind === 'failure') assert.equal(JSON.parse(otherMode.stderr).error.source.kind, 'duel_requires_hunger_games');

    const ready = await runCli([
      'duel', '--scenario', 'scenarios/duel.toml', '--candidate', 'improved', '--opponent', 'cautious-survivor',
      '--seeds', '1,2', '--rounds', '1', '--concurrency', '1', '--accept-minecraft-eula',
    ]);
    assert.equal(ready.kind, 'failure');
    if (ready.kind === 'failure') {
      assert.equal(JSON.parse(ready.stderr).error.source.kind, 'path_not_configured');
      assert.equal(JSON.parse(ready.stderr).error.resource, 'Java runtime');
    }
  } finally {
    if (previous.helper === undefined) delete process.env.ARENA_FS_HELPER;
    else process.env.ARENA_FS_HELPER = previous.helper;
    if (previous.java === undefined) delete process.env.ARENA_JAVA_HOME;
    else process.env.ARENA_JAVA_HOME = previous.java;
    if (previous.paper === undefined) delete process.env.ARENA_PAPER_JAR;
    else process.env.ARENA_PAPER_JAR = previous.paper;
    if (previous.plugin === undefined) delete process.env.ARENA_PLUGIN_JAR;
    else process.env.ARENA_PLUGIN_JAR = previous.plugin;
  }
});
