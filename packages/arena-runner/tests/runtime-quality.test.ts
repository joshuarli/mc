import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { compileCandidateProfile } from '@arena/spec';
import { mapBounded, parseConcurrency } from '../src/bounded.js';
import type { Evidence } from '../src/evidence.js';
import { runLeague, type LeagueStore, type MatchObservation, type MatchPlan, type MatchRunner, type StoredMatch, type HeldoutLedgerEntry } from '../src/league/harness.js';
import {
  parseLeagueManifest, parseSeedManifest, profileSpec, resolveLeagueManifest, type CandidateSpec,
} from '../src/league/manifest.js';
import { planQualityMatches, runQuality } from '../src/league/quality.js';
import { reserveEphemeralGamePort } from '../src/runtime/game-port.js';
import { matchQuality, qualityGates, renderQualityTable } from '../src/seat-quality.js';
import type { TraceRecord } from '../src/trace.js';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const never = new AbortController().signal;

function manifest() {
  const draft = parseLeagueManifest(read('evaluation/league-v1.toml'));
  const profiles = new Map<string, CandidateSpec>();
  for (const entry of draft.candidateEntries) {
    if (entry.kind !== 'profile') continue;
    const profile = compileCandidateProfile(read(join('policies/candidates', entry.path.split('/').at(-1)!)));
    profiles.set(entry.path, profileSpec({ id: profile.id, params: profile.params }));
  }
  const resolved = resolveLeagueManifest(draft, profiles);
  return { ...resolved, candidates: resolved.candidates.slice(0, 1) };
}

const seeds = parseSeedManifest(`schema = 1
[[set]]
name = "development"
role = "development"
first = 500001
last = 500003
`);

class MemoryStore implements LeagueStore {
  matches = new Map<string, StoredMatch>();
  async readMatch(id: string) { return this.matches.get(id); }
  async writeMatch(match: StoredMatch) { this.matches.set(match.match_id, match); }
  async readLedger(): Promise<readonly HeldoutLedgerEntry[]> { return []; }
  async appendLedger() {}
  async writeReport() { return 'report'; }
}

function trackingRunner(options: { failing?: string; hold?: number } = {}) {
  let inFlight = 0;
  const state = { peak: 0, started: [] as string[] };
  const runner: MatchRunner = {
    async run(plan: MatchPlan): Promise<MatchObservation> {
      state.started.push(plan.matchId);
      inFlight += 1;
      state.peak = Math.max(state.peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, options.hold ?? 5 + (plan.worldSeed % 3) * 5));
      inFlight -= 1;
      if (plan.matchId === options.failing) return { status: 'failed', reason: 'paper_port_bind_failed', runId: plan.matchId };
      return {
        status: 'completed', outcome: { kind: 'winner', seat: plan.candidateSeats[0]! }, survivors: [plan.candidateSeats[0]!],
        disconnects: 0, degraded: false, attacks: {}, runId: plan.matchId,
      };
    },
  };
  return { runner, state };
}

test('quality concurrency is bounded, keeps result order, and rejects out-of-range levels', async () => {
  assert.equal(parseConcurrency('1'), 1);
  assert.equal(parseConcurrency('4'), 4);
  assert.equal(parseConcurrency('5'), undefined);
  assert.equal(parseConcurrency('0'), undefined);
  assert.equal(parseConcurrency('two'), undefined);
  let live = 0;
  let peak = 0;
  const results = await mapBounded([30, 5, 20, 1, 10, 15], 3, async (delay, index) => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((resolve) => setTimeout(resolve, delay));
    live -= 1;
    return index;
  });
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
  assert.equal(peak, 3);
});

test('quality league runs matches concurrently with identical stored results as serial order', async () => {
  const serialStore = new MemoryStore();
  const serial = trackingRunner();
  const serialReport = await runLeague({ manifest: manifest(), seeds, store: serialStore, runner: serial.runner, signal: never }) as { matches: { match_id: string; concurrency: number | null }[]; quality: { max_concurrency: number; timing_sensitive: boolean } };
  assert.equal(serial.state.peak, 1);
  assert.equal(serialReport.quality.timing_sensitive, false);

  const parallelStore = new MemoryStore();
  const parallel = trackingRunner();
  const parallelReport = await runLeague({ manifest: manifest(), seeds, store: parallelStore, runner: parallel.runner, signal: never, concurrency: 3 }) as typeof serialReport;
  assert.equal(parallel.state.peak, 3);
  assert.deepEqual(parallelReport.matches.map((row) => row.match_id), serialReport.matches.map((row) => row.match_id));
  assert.ok(parallelReport.matches.every((row) => row.concurrency === 3));
  assert.equal(parallelReport.quality.timing_sensitive, true);
});

test('quality league isolates a failed match, keeps it in the denominators, and resumes only the missing matches', async () => {
  const store = new MemoryStore();
  const { runner, state } = trackingRunner({ failing: 'c0-o0-s500002-r1' });
  const report = await runLeague({ manifest: manifest(), seeds, store, runner, signal: never, concurrency: 4 }) as {
    matches: { status: string; reason?: string }[]; pairs: { denominators: { planned: number; completed: number; censored_or_failed: number } }[];
  };
  assert.equal(state.started.length, 6);
  assert.equal(report.matches.filter((row) => row.status === 'failed').length, 1);
  assert.deepEqual(report.pairs[0]!.denominators, { ...report.pairs[0]!.denominators, planned: 6, completed: 5, censored_or_failed: 1 });

  store.matches.delete('c0-o0-s500002-r1');
  const again = trackingRunner();
  await runLeague({ manifest: manifest(), seeds, store, runner: again.runner, signal: never, concurrency: 4 });
  assert.deepEqual(again.state.started, ['c0-o0-s500002-r1']);
});

test('quality command plans one match per seed with candidate and baseline on alternating seats and reports failures', async () => {
  const request = {
    scenario: 'scenarios/hunger-six.toml', seeds: [481516, 481517, 481518], competitors: 6,
    candidate: { id: 'melee-duelist' as const, params: {} }, baseline: { id: 'baseline' as const, params: {} }, runTag: 'abc',
  };
  const plans = planQualityMatches(request);
  assert.deepEqual(plans.map((plan) => plan.matchId), ['qabc-s481516', 'qabc-s481517', 'qabc-s481518']);
  assert.deepEqual(plans[0]!.candidateSeats, [0, 2, 4]);
  assert.deepEqual(plans[0]!.opponentSeats, [1, 3, 5]);
  const { runner } = trackingRunner({ failing: 'qabc-s481517' });
  const result = await runQuality({ request, runner, concurrency: 2, signal: never });
  const report = result.report as { concurrency: number; matches: { status: string }[]; quality: { gates: { id: string; passed: boolean; reason: string }[] } };
  assert.equal(report.concurrency, 2);
  assert.deepEqual(report.matches.map((row) => row.status), ['completed', 'failed', 'completed']);
  assert.equal(report.quality.gates.find((gate) => gate.id === 'all_terminate')!.passed, false);
  assert.ok(result.text.includes('timing-sensitive'));
});

test('quality ephemeral game ports are loopback-bindable and never repeat within a process', async () => {
  const ports = await Promise.all(Array.from({ length: 8 }, () => reserveEphemeralGamePort()));
  assert.equal(new Set(ports).size, 8);
  assert.ok(ports.every((port) => port > 1024 && port !== 25565));
});

function replay(seat: number, sequence: number, tick: number, x: number, intent: object, disposition: object): TraceRecord {
  return {
    schema: 'policy-replay-v4', sequence: String(sequence), seat,
    input: { observation: { tick, sequence, agent: { kind: 'current', value: { position: { x, y: 65, z: 0 } } }, border: { kind: 'current' } } },
    decision: { goal: { kind: 'explore' }, intent }, disposition,
  } as unknown as TraceRecord;
}

function evidenceOf(records: TraceRecord[]): Evidence {
  return { run_id: 'r', first_sequence: '1', last_sequence: String(records.length), segments: [], records };
}

test('quality seat table counts loot, distance, idle reasons, attacks, damage and deaths from recorded evidence', () => {
  const containerOpen = { kind: 'containerOpen', position: { x: 1, y: 65, z: 1 } };
  const funnel = (seat: number, sequence: string, outcome: object): TraceRecord => ({
    schema: 'action-funnel-v1', seat, action_sequence: sequence, tick: 100, intent: 'attack', target_entity: 9, target_seat: 1,
    border: 'current', skill: 'failed', funnel: outcome,
  } as unknown as TraceRecord);
  const records: TraceRecord[] = [
    { schema: 'seat-policy-v1', seat: 0, candidate: 'melee-duelist' } as unknown as TraceRecord,
    replay(0, 1, 0, 0, containerOpen, { kind: 'start', action_sequence: '1' }),
    { schema: 'policy-effect-v1', decision_sequence: '1', skill: { kind: 'succeeded' } } as unknown as TraceRecord,
    replay(0, 2, 20, 10, { kind: 'navigate', target: { x: 50, y: 65, z: 0 } }, { kind: 'start', action_sequence: '2' }),
    replay(0, 3, 40, 10, { kind: 'hold', reason: 'awaitingLoot' }, { kind: 'hold' }),
    replay(0, 4, 60, 10, { kind: 'navigate', target: { x: 50, y: 65, z: 0 } }, { kind: 'continue', action_sequence: '2' }),
    replay(0, 5, 80, 10, { kind: 'navigate', target: { x: 50, y: 65, z: 0 } }, { kind: 'continue', action_sequence: '2' }),
    replay(0, 6, 100, 10, { kind: 'attack', target: 9 }, { kind: 'start', action_sequence: '6' }),
    funnel(0, '6', { kind: 'reached', action: 'attack', stage: 'confirmedEffect' }),
    funnel(0, '7', { kind: 'stopped', action: 'attack', last_passed: 'tacticalChoice', reason: 'cooldownNotReady', eye_to_body_units: null }),
    funnel(0, '8', { kind: 'stopped', action: 'attack', last_passed: 'tacticalChoice', reason: 'targetNoLongerVisible', eye_to_body_units: null }),
    { direction: 'plugin', type: 'damage', payload: { at: { domain: 'match', value: '100' }, entries: [
      { victim: 1, attacker: 0, cause: 'melee', amount: 6 }, { victim: 0, attacker: 1, cause: 'melee', amount: 4 },
      { victim: 0, attacker: null, cause: 'fall', amount: 4 }] } } as unknown as TraceRecord,
    { direction: 'plugin', type: 'damage', payload: { at: { domain: 'match', value: '110' }, entries: [
      { victim: 1, attacker: 0, cause: 'melee', amount: 6 }] } } as unknown as TraceRecord,
    { direction: 'plugin', type: 'elimination', payload: { at: { domain: 'match', value: '110' }, eliminations: [{ seat: 1, cause: 'death' }] } } as unknown as TraceRecord,
    { direction: 'plugin', type: 'outcome', payload: { at: { domain: 'match', value: '400' }, kind: 'winner', survivors: [0] } } as unknown as TraceRecord,
  ];
  const quality = matchQuality(evidenceOf(records));
  const seat0 = quality.seats.find((seat) => seat.seat === 0)!;
  assert.equal(seat0.candidate, 'melee-duelist');
  assert.deepEqual(seat0.loot, { actions_started: 1, containers_opened: 1, drops_collected: 0, failed: 0, looted: true });
  assert.equal(seat0.distance_blocks, 10);
  assert.deepEqual(seat0.idle.by_reason, { 'wait:awaitingLoot': 20, 'no_progress:navigate': 60 });
  assert.equal(seat0.idle.unexplained_ticks, 60);
  assert.equal(seat0.idle.max_unexplained_span_ticks, 40);
  assert.deepEqual(seat0.attacks, {
    engaged: 3, issued: 1, rejected: 2,
    rejected_by_cause: { cooldownNotReady: 1, targetNoLongerVisible: 1 }, self_inflicted_rejected: 1,
  });
  assert.deepEqual(seat0.damage, { dealt: 12, taken: 8, taken_from_competitors: 4 });
  assert.equal(seat0.pvp_share, 0.5);
  assert.equal(seat0.time_alive_ticks, 400);
  const victim = quality.seats.find((seat) => seat.seat === 1)!;
  assert.deepEqual(victim.death, { tick: 110, cause: 'melee', by_seat: 0, pvp: true });
  assert.equal(victim.time_alive_ticks, 110);
  assert.equal(quality.pvp_engagements, 1);
  assert.equal(quality.pvp_hits, 3);
  assert.deepEqual(quality.eliminations, { total: 1, pvp: 1, by_cause: { melee: 1 } });

  const gates = qualityGates([{ label: 'm', terminated: true, quality }]);
  const byId = Object.fromEntries(gates.map((gate) => [gate.id, gate]));
  assert.equal(byId.pvp_eliminations!.passed, true);
  assert.equal(byId.seats_loot!.value, 0.5);
  assert.equal(byId.seats_loot!.passed, false);
  assert.equal(byId.self_inflicted_rejections!.value, 1);
  assert.equal(byId.no_unexplained_idle!.passed, true);
  assert.match(renderQualityTable([{ label: 'm', quality }]), /melee@110<-0/);
});
