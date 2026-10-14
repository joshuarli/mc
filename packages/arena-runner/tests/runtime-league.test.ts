import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  agentObservation, agentState, blockPosition, compileCandidate, currentKnowledge, DeterministicRandom,
  emptyEquipment, emptyPolicyMemory, entityId, observationSequence, PolicyParams, tick, unopenedContainer,
  visibleOpponent, worldBorder,
} from '@arena/core';
import { compileCandidateProfile } from '@arena/spec';
import { canonicalJson } from '../src/canonical.js';
import { RunnerError } from '../src/errors.js';
import { estimateMean, tCritical975 } from '../src/league/analysis.js';
import {
  candidateSetDigest, planMatches, resolveSeedSet, runLeague,
  type HeldoutLedgerEntry, type LeagueStore, type MatchObservation, type MatchPlan, type MatchRunner, type StoredMatch,
} from '../src/league/harness.js';
import {
  parseLeagueManifest, parseSeedManifest, profileSpec, resolveLeagueManifest, seedsOf, type CandidateSpec,
} from '../src/league/manifest.js';
import { seededScenarioSource } from '../src/league/live-runner.js';
import { parseTomlSubset } from '../src/league/toml-subset.js';
import { makePolicyReplayRecordV4, replayPolicyJson } from '../src/policy-replay.js';
import { decideRuntimeCandidatePolicy, decideRuntimePolicy } from '../src/runtime/policy-decision.js';
import type { Evidence } from '../src/evidence.js';
import type { TraceRecord } from '../src/trace.js';

const repositoryRoot = process.cwd();
const read = (path: string) => readFileSync(join(repositoryRoot, path), 'utf8');

function shippedManifest() {
  const draft = parseLeagueManifest(read('evaluation/league-v1.toml'));
  const profiles = new Map<string, CandidateSpec>();
  for (const entry of draft.candidateEntries) {
    if (entry.kind !== 'profile') continue;
    const profile = compileCandidateProfile(read(join('policies/candidates', entry.path.split('/').at(-1)!)));
    profiles.set(entry.path, profileSpec({ id: profile.id, params: profile.params }));
  }
  return resolveLeagueManifest(draft, profiles);
}

class MemoryStore implements LeagueStore {
  matches = new Map<string, StoredMatch>();
  ledger = new Map<number, HeldoutLedgerEntry>();
  reports: object[] = [];
  async readMatch(id: string) { return this.matches.get(id); }
  async writeMatch(match: StoredMatch) {
    if (this.matches.has(match.match_id)) throw new Error('exclusive publication violated');
    this.matches.set(match.match_id, match);
  }
  async readLedger(seeds: readonly number[]) { return seeds.flatMap((seed) => this.ledger.get(seed) ?? []); }
  async appendLedger(entries: readonly HeldoutLedgerEntry[]) { for (const entry of entries) this.ledger.set(entry.seed, entry); }
  async writeReport(report: object) { this.reports.push(report); return `report-${this.reports.length}`; }
}

function runnerFrom(decide: (plan: MatchPlan) => MatchObservation | 'throw'): MatchRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(plan) {
      calls.push(plan.matchId);
      const result = decide(plan);
      if (result === 'throw') throw new RunnerError('runtime_failure', 'match', { kind: 'server_exited_before_shutdown' });
      return result;
    },
  };
}

function winner(side: 'candidate' | 'opponent' | 'draw', plan: MatchPlan, extra: Partial<Extract<MatchObservation, { status: 'completed' }>> = {}): MatchObservation {
  const seats = side === 'candidate' ? plan.candidateSeats : plan.opponentSeats;
  return {
    status: 'completed',
    outcome: side === 'draw' ? { kind: 'draw' } : { kind: 'winner', seat: seats[0]! },
    survivors: side === 'draw' ? [...plan.candidateSeats, ...plan.opponentSeats] : [seats[0]!],
    disconnects: 0, degraded: false, attacks: {}, runId: plan.matchId, ...extra,
  };
}

function smallManifest(seedSet = 'development') {
  const manifest = shippedManifest();
  return { ...manifest, seedSet, candidates: manifest.candidates.slice(0, 1) };
}

const smallSeeds = parseSeedManifest(`schema = 1
[[set]]
name = "development"
role = "development"
first = 500001
last = 500004
[[set]]
name = "heldout-v1"
role = "heldout"
first = 600001
last = 600003
`);

test('shipped league and seed manifests parse strictly and resolve candidate profiles', () => {
  const manifest = shippedManifest();
  assert.deepEqual(manifest.candidates.map((entry) => entry.id), ['cautious-survivor', 'melee-duelist']);
  assert.deepEqual(manifest.opponents.map((entry) => entry.label), ['baseline']);
  const seeds = parseSeedManifest(read('evaluation/seeds-v1.toml'));
  assert.deepEqual(seeds.sets.map((set) => [set.name, set.role, seedsOf(set).length]), [
    ['mechanics', 'regression', 6], ['development', 'development', 12], ['heldout-v1', 'heldout', 24],
  ]);
  assert.equal(seedsOf(seeds.sets[0]!)[0], 481516);
  assert.throws(() => parseLeagueManifest(read('evaluation/league-v1.toml').replace('schema = 1', 'schema = 2')));
  assert.throws(() => parseLeagueManifest(`${read('evaluation/league-v1.toml')}\nextra = 1\n`));
  assert.throws(() => parseTomlSubset('a = 1\na = 2\n', 'test'));
  assert.throws(() => parseTomlSubset('a = 1 2\n', 'test'));
});

test('the league manifest requires the frozen baseline and rejects frozen-candidate overrides', () => {
  const draft = parseLeagueManifest(read('evaluation/league-v1.toml').replace('id = "baseline"', 'id = "melee-duelist"'));
  assert.throws(() => resolveLeagueManifest(draft, shippedProfiles()),
    (error: unknown) => error instanceof RunnerError && error.source.kind === 'frozen_baseline_missing');
  assert.throws(() => parseLeagueManifest(read('evaluation/league-v1.toml').replace('id = "baseline"',
    'id = "baseline"\nparams = { fightRangeBlocks = 6 }')), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'frozen-candidate');
});

function shippedProfiles() {
  const draft = parseLeagueManifest(read('evaluation/league-v1.toml'));
  const profiles = new Map<string, CandidateSpec>();
  for (const entry of draft.candidateEntries) {
    if (entry.kind !== 'profile') continue;
    const profile = compileCandidateProfile(read(join('policies/candidates', entry.path.split('/').at(-1)!)));
    profiles.set(entry.path, profileSpec({ id: profile.id, params: profile.params }));
  }
  return profiles;
}

test('league plan rotates three candidate seats against three opponent seats over two swaps per world seed', () => {
  const manifest = shippedManifest();
  const plans = planMatches(manifest, resolveSeedSet(manifest, smallSeeds));
  assert.equal(plans.length, 2 * 1 * 4 * 2);
  const first = plans.slice(0, 2);
  assert.deepEqual(first.map((plan) => plan.candidateSeats), [[0, 2, 4], [1, 3, 5]]);
  assert.deepEqual(first.map((plan) => plan.opponentSeats), [[1, 3, 5], [0, 2, 4]]);
  assert.equal(new Set(plans.map((plan) => plan.matchId)).size, plans.length);
});

test('league scoring gives 1, 0.5 and 0 by last survivor side and keeps failures as denominators', async () => {
  const manifest = smallManifest();
  const outcomes = ['candidate', 'draw', 'opponent', 'candidate', 'throw', 'candidate', 'candidate', 'candidate'] as const;
  let index = 0;
  const runner = runnerFrom((plan) => {
    const pick = outcomes[index++]!;
    return pick === 'throw' ? 'throw' : winner(pick, plan);
  });
  const report = await runLeague({
    manifest, seeds: smallSeeds, store: new MemoryStore(), runner, signal: new AbortController().signal,
  }) as { pairs: { denominators: any; outcomes: any; score: any; verdict: string; verdict_reasons: string[] }[] };
  const pair = report.pairs[0]!;
  assert.deepEqual([pair.denominators.planned, pair.denominators.completed, pair.denominators.censored_or_failed], [8, 7, 1]);
  assert.deepEqual(pair.denominators.failure_reasons, { server_exited_before_shutdown: 1 });
  assert.deepEqual(pair.outcomes, { candidate_wins: 5, opponent_wins: 1, draws: 1 });
  assert.ok(pair.verdict_reasons.includes('incomplete_matches'));
  assert.equal(pair.verdict, 'keep_baseline');
  assert.equal(pair.score.mean_if_censored_lost, (5 + 0.5) / 8);
});

test('league promotes only when the mean, interval, survival and integrity gates all hold', async () => {
  const manifest = smallManifest();
  const winning = await runLeague({
    manifest, seeds: smallSeeds, store: new MemoryStore(),
    runner: runnerFrom((plan) => winner('candidate', plan)), signal: new AbortController().signal,
  }) as { candidates: { verdict: string }[]; pairs: { score: any }[] };
  assert.equal(winning.pairs[0]!.score.mean, 1);
  assert.equal(winning.candidates[0]!.verdict, 'promote');

  const even = await runLeague({
    manifest, seeds: smallSeeds, store: new MemoryStore(),
    runner: runnerFrom((plan) => winner('draw', plan)), signal: new AbortController().signal,
  }) as { candidates: { verdict: string }[]; pairs: { verdict_reasons: string[] }[] };
  assert.equal(even.candidates[0]!.verdict, 'keep_baseline');
  assert.ok(even.pairs[0]!.verdict_reasons.includes('mean_below_threshold'));

  const manyManifest = { ...manifest, seedSet: 'development' };
  const wide = parseSeedManifest(`schema = 1
[[set]]
name = "development"
role = "development"
first = 500001
last = 500012
`);
  const promoted = await runLeague({
    manifest: manyManifest, seeds: wide, store: new MemoryStore(),
    runner: runnerFrom((plan) => winner('candidate', plan)), signal: new AbortController().signal,
  }) as { candidates: { verdict: string }[]; pairs: { verdict_reasons: string[] }[] };
  assert.deepEqual(promoted.pairs[0]!.verdict_reasons, []);
  assert.equal(promoted.candidates[0]!.verdict, 'promote');

  const disconnected = await runLeague({
    manifest: manyManifest, seeds: wide, store: new MemoryStore(),
    runner: runnerFrom((plan) => winner('candidate', plan, plan.worldSeed === 500003 ? { disconnects: 1 } : {})),
    signal: new AbortController().signal,
  }) as { pairs: { verdict_reasons: string[] }[] };
  assert.deepEqual(disconnected.pairs[0]!.verdict_reasons, ['disconnects']);

  const regressed = await runLeague({
    manifest: manyManifest, seeds: wide, store: new MemoryStore(),
    runner: runnerFrom((plan) => winner('candidate', plan, {
      survivors: plan.opponentSeats.slice(0, 3).concat(plan.candidateSeats.slice(0, 1)),
      outcome: { kind: 'winner', seat: plan.candidateSeats[0]! },
    })),
    signal: new AbortController().signal,
  }) as { pairs: { verdict_reasons: string[] }[] };
  assert.deepEqual(regressed.pairs[0]!.verdict_reasons, ['survival_regression']);
});

test('league resumes by match record, never reruns published matches, and refuses a changed plan', async () => {
  const manifest = smallManifest();
  const store = new MemoryStore();
  const interrupted = new AbortController();
  let completed = 0;
  const first = runnerFrom((plan) => {
    completed += 1;
    if (completed === 4) interrupted.abort(new RunnerError('cancelled', 'arena run', { kind: 'cancelled' }));
    return winner('candidate', plan);
  });
  await assert.rejects(runLeague({ manifest, seeds: smallSeeds, store, runner: first, signal: interrupted.signal }));
  assert.equal(store.matches.size, 4);

  const second = runnerFrom((plan) => winner('candidate', plan));
  await runLeague({ manifest, seeds: smallSeeds, store, runner: second, signal: new AbortController().signal });
  assert.equal(second.calls.length, 4);
  assert.equal(store.matches.size, 8);

  const changed = { ...manifest, candidates: [{ id: 'melee-duelist' as const, params: shippedManifest().candidates[1]!.params }] };
  await assert.rejects(runLeague({
    manifest: changed, seeds: smallSeeds, store, runner: runnerFrom((plan) => winner('candidate', plan)),
    signal: new AbortController().signal,
  }), (error: unknown) => error instanceof RunnerError && error.source.kind === 'league_results_plan_mismatch');
});

test('held-out seeds are consumed once per candidate set and a retired set returns to development', async () => {
  const manifest = smallManifest('heldout-v1');
  const store = new MemoryStore();
  const signal = new AbortController().signal;
  await runLeague({ manifest, seeds: smallSeeds, store, runner: runnerFrom((plan) => winner('candidate', plan)), signal });
  const digest = candidateSetDigest(manifest);
  assert.deepEqual([...store.ledger.values()].map((entry) => [entry.seed, entry.candidate_set_digest]),
    [600001, 600002, 600003].map((seed) => [seed, digest]));

  const other = { ...manifest, candidates: [shippedManifest().candidates[1]!] };
  const second = runnerFrom((plan) => winner('candidate', plan));
  await assert.rejects(runLeague({ manifest: other, seeds: smallSeeds, store, runner: second, signal }),
    (error: unknown) => error instanceof RunnerError && error.source.kind === 'heldout_seed_already_consumed');
  assert.deepEqual(second.calls, []);

  const resumed = runnerFrom((plan) => winner('candidate', plan));
  await runLeague({ manifest, seeds: smallSeeds, store, runner: resumed, signal });
  assert.deepEqual(resumed.calls, [], 'the same frozen set resumes without rerunning');

  const retired = parseSeedManifest(`schema = 1
[[set]]
name = "heldout-v1"
role = "development"
first = 600001
last = 600003
[[set]]
name = "heldout-v2"
role = "heldout"
first = 700001
last = 700003
`);
  const afterRetirement = runnerFrom((plan) => winner('candidate', plan));
  await runLeague({ manifest: { ...other, seedSet: 'heldout-v1' }, seeds: retired, store: new MemoryStore(), runner: afterRetirement, signal });
  assert.equal(afterRetirement.calls.length, 3 * 2);
});

test('paired analysis groups swaps by world seed with the declared interval method', () => {
  assert.equal(tCritical975(3), 3.182);
  const scored = [
    ...[1, 1].map((score) => ({ worldSeed: 1, score: score as 1 })),
    ...[1, 0.5].map((score) => ({ worldSeed: 2, score: score as 1 | 0.5 })),
    ...[0.5, 0.5].map((score) => ({ worldSeed: 3, score: score as 0.5 })),
    ...[1, 1].map((score) => ({ worldSeed: 4, score: score as 1 })),
  ];
  const t = estimateMean(scored, 'tInterval', 200, 1);
  assert.equal(t.clusters, 4);
  assert.ok(Math.abs(t.mean! - 0.8125) < 1e-12);
  const sd = Math.sqrt(([1, 0.75, 0.5, 1].reduce((sum, v) => sum + (v - 0.8125) ** 2, 0)) / 3);
  assert.ok(Math.abs(t.standardDeviation! - sd) < 1e-12);
  assert.ok(Math.abs(t.lower! - (0.8125 - 3.182 * sd / 2)) < 1e-12);
  const first = estimateMean(scored, 'bootstrap', 1000, 7);
  const second = estimateMean(scored, 'bootstrap', 1000, 7);
  assert.deepEqual(first, second);
  assert.ok(first.lower! >= 0.5 && first.upper! <= 1);
  assert.equal(estimateMean([], 'tInterval', 200, 1).mean, null);
  assert.equal(estimateMean([{ worldSeed: 1, score: 1 }], 'bootstrap', 200, 1).lower, null);
});

test('seeded scenario text changes only the world seed and the resource references', () => {
  const source = read('scenarios/hunger-six.toml');
  const text = seededScenarioSource(source, 500001, '../../../../../maps/hunger-six.toml', '../../../../../policies/baseline.toml');
  assert.match(text, /^seed = 500001$/m);
  assert.match(text, /^map = "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/maps\/hunger-six\.toml"$/m);
  assert.equal(text.split('\n').length, source.split('\n').length);
  assert.throws(() => seededScenarioSource(`${source}\nseed = 3\n`, 1, 'a', 'b'));
});

function observationFor() {
  return agentObservation({
    tick: tick(10), sequence: observationSequence(1),
    agent: currentKnowledge(agentState({
      position: blockPosition(0, 64, 0), healthHalfHearts: 40, hungerPoints: 20, foodStacks: [],
      equipped: emptyEquipment(), upgrades: [],
    })),
    border: currentKnowledge(worldBorder(0, 0, 100)),
    opponents: currentKnowledge([visibleOpponent(entityId(4), blockPosition(6, 64, 0), false)]),
    loot: currentKnowledge([unopenedContainer(blockPosition(0, 64, 3))]),
  });
}

test('the baseline candidate decides byte-identically to the frozen baseline policy path', () => {
  const observation = observationFor();
  const baseline = compileCandidate('baseline');
  const viaCandidate = decideRuntimeCandidatePolicy(baseline, observation, emptyPolicyMemory(), DeterministicRandom.fromState(9n), []);
  const direct = decideRuntimePolicy(observation, emptyPolicyMemory(), PolicyParams.baseline(), DeterministicRandom.fromState(9n), []);
  assert.equal(canonicalJson(viaCandidate.decision), canonicalJson(direct.decision));
  assert.equal(canonicalJson(viaCandidate.input), canonicalJson(direct.input));
  assert.equal(viaCandidate.rngStateAfter, direct.rngStateAfter);
});

test('candidate decisions replay only with their seat-policy note', () => {
  const observation = observationFor();
  const candidate = compileCandidate('equipment-skirmisher');
  const step = decideRuntimeCandidatePolicy(candidate, observation, emptyPolicyMemory(), DeterministicRandom.fromState(9n), []);
  const plain = decideRuntimePolicy(observation, emptyPolicyMemory(), PolicyParams.baseline(), DeterministicRandom.fromState(9n), []);
  const record = makePolicyReplayRecordV4({
    sequence: 1n, seat: 0, input: step.input, decision: step.decision, openingStateAfter: null,
    rngStateAfter: step.rngStateAfter,
    disposition: step.decision.intent.kind === 'hold' ? { kind: 'hold' } : { kind: 'start', action_sequence: '1' },
  });
  const note = {
    schema: 'seat-policy-v1', seat: 0, candidate: candidate.id, version: candidate.version,
    implementation: candidate.implementation, semantic_id: candidate.semanticId, params: { ...candidate.params },
  } as unknown as TraceRecord;
  const evidence = (records: TraceRecord[]): Evidence => ({
    run_id: 'league-replay', first_sequence: '1', last_sequence: String(records.length), segments: [], records,
  });
  assert.equal(replayPolicyJson(evidence([note, record as unknown as TraceRecord])).verified, true);
  if (canonicalJson(step.decision) !== canonicalJson(plain.decision)) {
    assert.throws(() => replayPolicyJson(evidence([record as unknown as TraceRecord])));
  }
  assert.throws(() => replayPolicyJson(evidence([{ ...note, semantic_id: 'forged' } as TraceRecord, record as unknown as TraceRecord])));
});
