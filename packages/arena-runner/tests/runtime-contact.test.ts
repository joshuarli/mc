import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTION_FUNNEL_STAGES, type ActionFunnelMissReason, type ActionFunnelStage } from '@arena/core';
import type { Evidence } from '../src/evidence.js';
import { estimateMean } from '../src/league/analysis.js';
import {
  accountAttackFunnel, classifyContact,
  type ContactAssessmentInput, type ContactFunnelRecord,
} from '../src/league/contact.js';
import { runDuel, type DuelRunRequest } from '../src/league/duel.js';
import type { MatchObservation, MatchPlan, MatchRunner } from '../src/league/harness.js';
import { matchQuality, qualityGates, type MatchQuality, type SeatQuality } from '../src/seat-quality.js';
import type { TraceRecord } from '../src/trace.js';

const never = new AbortController().signal;
const ADMITTED = ACTION_FUNNEL_STAGES.indexOf('skillAdmission');
const ISSUED = ACTION_FUNNEL_STAGES.indexOf('issued');

function record(
  stage: ActionFunnelStage,
  options: Partial<ContactFunnelRecord> & { reason?: ActionFunnelMissReason | null } = {},
): ContactFunnelRecord {
  const reason = options.reason === undefined ? null : options.reason;
  const kind = options.kind ?? (reason === null ? 'reached' : 'stopped');
  return {
    action: options.action ?? 'attack',
    kind,
    stage,
    reason,
    seat: options.seat === undefined ? 0 : options.seat,
    tick: options.tick === undefined ? 1 : options.tick,
  };
}

function input(overrides: Partial<ContactAssessmentInput> & Pick<ContactAssessmentInput, 'funnel' | 'attacks_issued' | 'pvp_hits' | 'score'>): ContactAssessmentInput {
  return {
    completed: true,
    legal_outcome: true,
    seats: [0, 1],
    ...overrides,
  };
}

function oracle(records: readonly ContactFunnelRecord[]): { not_admitted: number; admitted_but_not_issued: number; issued: number; stopped: number } {
  const counts = { not_admitted: 0, admitted_but_not_issued: 0, issued: 0, stopped: 0 };
  for (const entry of records) {
    const index = ACTION_FUNNEL_STAGES.indexOf(entry.stage);
    if (entry.kind === 'stopped') counts.stopped += 1;
    if (index >= ISSUED) counts.issued += 1;
    else if (index >= ADMITTED) counts.admitted_but_not_issued += 1;
    else counts.not_admitted += 1;
  }
  return counts;
}

test('attack funnel counts conserve and campaign rejected counts stops', () => {
  const records = [
    record('tacticalChoice', { kind: 'stopped', reason: 'cooldownNotReady', seat: 0, tick: 1 }),
    record('skillAdmission', { kind: 'stopped', reason: 'ownershipDeferred', seat: 0, tick: 2 }),
    record('issued', { kind: 'stopped', reason: 'aimNotReady', seat: 1, tick: 3 }),
    record('confirmedEffect', { kind: 'reached', reason: null, seat: 1, tick: 4 }),
    record('opportunity', { kind: 'reached', reason: null, seat: 0, tick: 5 }),
  ];
  const report = accountAttackFunnel(records);
  const expected = oracle(records);
  assert.equal(report.attempted, report.stages.opportunity);
  assert.equal(report.admitted, report.stages.skillAdmission);
  assert.equal(report.issued, report.stages.issued);
  assert.equal(report.confirmed, report.stages.confirmedEffect);
  assert.equal(report.rejected, expected.stopped);
  assert.deepEqual(report.conservation, {
    not_admitted: expected.not_admitted,
    admitted_but_not_issued: expected.admitted_but_not_issued,
    issued: expected.issued,
  });
  assert.equal(report.conservation.not_admitted + report.conservation.admitted_but_not_issued + report.conservation.issued, records.length);
  assert.notEqual(report.rejected, report.conservation.not_admitted);
  assert.equal(report.deferred_count, 1);
  assert.equal(report.issued_illegal_count, 1);
  assert.equal(report.attempted, records.length);
});

test('zero contact is a perception failure and does not qualify combat skill', () => {
  for (const score of [0, 0.5, 1] as const) {
    const assessment = classifyContact(input({ score, attacks_issued: 0, pvp_hits: 0, funnel: null }));
    assert.equal(assessment.contact_class, 'perception_failure');
    assert.notEqual(assessment.contact_class, 'valid_win');
    assert.notEqual(assessment.contact_class, 'valid_loss');
    assert.notEqual(assessment.contact_class, 'valid_draw');
    assert.equal(assessment.contact_validity, 'no_combat_demonstrated');
    assert.equal(assessment.combat_skill_qualified, false);
    assert.deepEqual(assessment.combat_opportunities, { count: null, reason: 'evidence_absent' });
  }
  const empty = classifyContact(input({ score: 0.5, attacks_issued: 0, pvp_hits: 0, funnel: [] }));
  assert.equal(empty.contact_class, 'perception_failure');
  assert.equal(empty.contact_validity, 'no_combat_demonstrated');
  assert.deepEqual(empty.combat_opportunities, { count: null, reason: 'evidence_absent' });
});

test('blocked line of sight is a perception failure', () => {
  const assessment = classifyContact(input({
    score: 1,
    attacks_issued: 0,
    pvp_hits: 0,
    funnel: [
      record('tacticalChoice', { kind: 'stopped', reason: 'blockedLineOfSight', seat: 0, tick: 4 }),
      record('tacticalChoice', { kind: 'stopped', reason: 'blockedLineOfSight', seat: 1, tick: 4 }),
    ],
  }));
  assert.equal(assessment.contact_class, 'perception_failure');
  assert.equal(assessment.contact_validity, 'no_combat_demonstrated');
  assert.equal(assessment.combat_skill_qualified, false);
  assert.deepEqual(assessment.combat_opportunities, { count: 0 });
});

test('unreachable terrain is fixture invalid', () => {
  const assessment = classifyContact(input({
    score: 1,
    attacks_issued: 0,
    pvp_hits: 0,
    funnel: [
      record('opportunity', { kind: 'stopped', reason: 'outOfGeometricReach', seat: 0, tick: 8 }),
      record('opportunity', { kind: 'stopped', reason: 'outOfGeometricReach', seat: 1, tick: 8 }),
    ],
  }));
  assert.equal(assessment.contact_class, 'fixture_invalid');
  assert.equal(assessment.contact_validity, 'no_combat_demonstrated');
  assert.deepEqual(assessment.combat_opportunities, { count: 0 });
});

test('an illegal issued attack is a skill failure and stays out of the old self-inflicted numerator', () => {
  const funnel = [
    record('issued', { kind: 'stopped', reason: 'cooldownNotReady', seat: 0, tick: 3 }),
    record('clientResponse', { kind: 'stopped', reason: 'aimNotReady', seat: 1, tick: 3 }),
  ];
  const assessment = classifyContact(input({ score: 0, attacks_issued: 2, pvp_hits: 0, funnel }));
  assert.equal(assessment.contact_class, 'skill_failure');
  assert.equal(assessment.contact_validity, 'combat_demonstrated');
  assert.equal(assessment.combat_skill_qualified, true);
  assert.equal(assessment.attack_funnel!.issued_illegal_count, 2);
  assert.equal(assessment.attack_funnel!.deferred_count, 0);
  assert.equal(assessment.attack_funnel!.issued_illegal_fraction, 1);
  const quality = qualityFromFunnel(funnel, 0);
  assert.equal(quality.seats.reduce((total, seat) => total + seat.attacks.self_inflicted_rejected, 0), 0);
  assert.equal(quality.seats.reduce((total, seat) => total + seat.attacks.issued, 0), 2);
  const old = qualityGates([{ label: 'm', terminated: true, quality }]).find((gate) => gate.id === 'self_inflicted_rejections')!;
  const issuedIllegal = qualityGates([{ label: 'm', terminated: true, quality }]).find((gate) => gate.id === 'issued_illegal_fraction')!;
  assert.equal(old.value, 0);
  assert.equal(old.passed, true);
  assert.equal(issuedIllegal.value, 1);
  assert.equal(issuedIllegal.passed, false);
});

test('ownershipDeferred is a scheduling deferral and stays inside the old self-inflicted fraction', () => {
  const funnel = [
    record('skillAdmission', { kind: 'stopped', reason: 'ownershipDeferred', seat: 0, tick: 5 }),
    record('tacticalChoice', { kind: 'stopped', reason: 'ownershipDeferred', seat: 1, tick: 5 }),
  ];
  const assessment = classifyContact(input({ score: 1, attacks_issued: 0, pvp_hits: 0, funnel }));
  assert.equal(assessment.contact_class, 'perception_failure');
  assert.equal(assessment.contact_validity, 'no_combat_demonstrated');
  assert.equal(assessment.combat_skill_qualified, false);
  assert.equal(assessment.attack_funnel!.deferred_count, 2);
  assert.equal(assessment.attack_funnel!.issued_illegal_count, 0);
  assert.deepEqual(assessment.combat_opportunities, { count: 1 });
  const issued = Array.from({ length: 20 }, (_, index) => record('confirmedEffect', {
    kind: 'reached', reason: null, seat: index % 2, tick: 10 + index,
  }));
  const deferred = [
    record('skillAdmission', { kind: 'stopped', reason: 'ownershipDeferred', seat: 0, tick: 1 }),
    record('skillAdmission', { kind: 'stopped', reason: 'ownershipDeferred', seat: 1, tick: 2 }),
  ];
  const quality = qualityFromFunnel([...issued, ...deferred], 0);
  const gates = Object.fromEntries(qualityGates([{ label: 'm', terminated: true, quality }]).map((gate) => [gate.id, gate]));
  assert.equal(gates.self_inflicted_rejections!.value, 0.1);
  assert.equal(gates.self_inflicted_rejections!.passed, false);
  assert.equal(gates.issued_illegal_fraction!.value, 0);
  assert.equal(gates.issued_illegal_fraction!.passed, true);
  assert.equal(quality.seats.reduce((total, seat) => total + seat.attacks.funnel.deferred_count, 0), 2);
  assert.equal(quality.seats.reduce((total, seat) => total + seat.attacks.self_inflicted_rejected, 0), 2);
});

test('contact with no swing is a policy failure', () => {
  const assessment = classifyContact(input({
    score: 0,
    attacks_issued: 0,
    pvp_hits: 0,
    funnel: [
      record('skillAdmission', { kind: 'reached', reason: null, seat: 0, tick: null }),
      record('localValidation', { kind: 'reached', reason: null, seat: 1, tick: null }),
    ],
  }));
  assert.equal(assessment.contact_class, 'policy_failure');
  assert.equal(assessment.contact_validity, 'no_combat_demonstrated');
  assert.equal(assessment.combat_skill_qualified, false);
  assert.equal(assessment.attack_funnel!.conservation.admitted_but_not_issued, 2);
  assert.deepEqual(assessment.combat_opportunities, { count: null, reason: 'evidence_absent' });
});

test('contact with confirmed damage is a valid win and counts a mutual opportunity', () => {
  const funnel = [
    record('confirmedEffect', { kind: 'reached', reason: null, seat: 0, tick: 10 }),
    record('issued', { kind: 'reached', reason: null, seat: 1, tick: 10 }),
  ];
  const assessment = classifyContact(input({ score: 1, attacks_issued: 2, pvp_hits: 1, funnel }));
  assert.equal(assessment.contact_class, 'valid_win');
  assert.equal(assessment.contact_validity, 'combat_demonstrated');
  assert.equal(assessment.combat_skill_qualified, true);
  assert.deepEqual(assessment.combat_opportunities, { count: 1 });
  assert.equal(assessment.attack_funnel!.confirmed, 1);
  const quality = qualityFromFunnel(funnel, 1);
  const fromStored = classifyContact(input({
    score: 1,
    attacks_issued: quality.seats.reduce((total, seat) => total + seat.attacks.issued, 0),
    pvp_hits: quality.pvp_hits,
    funnel: quality.attack_funnel_records,
    seats: quality.seats.map((seat) => seat.seat),
  }));
  assert.equal(fromStored.contact_class, 'valid_win');
  assert.deepEqual(fromStored.combat_opportunities, { count: 1 });
  const draw = classifyContact(input({ score: 0.5, attacks_issued: 2, pvp_hits: 1, funnel }));
  assert.equal(draw.contact_class, 'valid_draw');
  assert.equal(draw.contact_validity, 'combat_demonstrated');
});

test('a completed match without combat counts is fixture invalid', () => {
  const assessment = classifyContact({
    completed: true, legal_outcome: true, score: 1, attacks_issued: null, pvp_hits: null, funnel: null, seats: null,
  });
  assert.equal(assessment.contact_class, 'fixture_invalid');
  assert.equal(assessment.contact_validity, null);
  assert.equal(assessment.combat_skill_qualified, null);
  assert.deepEqual(assessment.combat_opportunities, { count: null, reason: 'evidence_absent' });
});

test('duel schema 2 keeps a zero-contact score mean and does not qualify it', async () => {
  const request: DuelRunRequest = {
    scenario: 'scenarios/duel.toml',
    seeds: [260114],
    rounds: 1,
    candidate: { id: 'improved', params: {} },
    opponent: { kind: 'candidate', spec: { id: 'baseline', params: {} } },
    runTag: 'fixture',
  };
  const runner: MatchRunner = {
    async run(plan) {
      const draw = plan.candidateSeats[0] !== 0;
      const observation: MatchObservation = {
        status: 'completed',
        outcome: draw ? { kind: 'draw' } : { kind: 'winner', seat: 0 },
        survivors: draw ? [0, 1] : [0],
        disconnects: 0,
        degraded: false,
        attacks: {},
        quality: idleQuality(),
        runId: `run-${plan.matchId}`,
      };
      return observation;
    },
  };
  const result = await runDuel({ request, runner, concurrency: 1, signal: never });
  assert.equal(result.report.schema, 2);
  assert.equal(result.report.score.mean, 0.75);
  assert.equal(result.report.score.mean, estimateMean([
    { worldSeed: 260114, score: 1 }, { worldSeed: 260114, score: 0.5 },
  ], 'tInterval', 0, 0).mean);
  const matches = result.report.matches as {
    score: number; contact_class: string; contact_validity: string; combat_skill_qualified: boolean;
    combat_opportunities: { count: number | null; reason?: string };
  }[];
  assert.deepEqual(matches.map((match) => match.score), [1, 0.5]);
  assert.deepEqual(matches.map((match) => match.contact_class), ['perception_failure', 'perception_failure']);
  assert.ok(matches.every((match) => match.contact_validity === 'no_combat_demonstrated'));
  assert.ok(matches.every((match) => match.combat_skill_qualified === false));
  assert.ok(matches.every((match) => match.combat_opportunities.count === null && match.combat_opportunities.reason === 'evidence_absent'));
  assert.match(result.text, /no_combat_demonstrated/);
  assert.match(result.text, /score 0.5/);
});

test('a perception failure stays in the duel score mean', async () => {
  const request: DuelRunRequest = {
    scenario: 'scenarios/duel.toml',
    seeds: [7],
    rounds: 1,
    candidate: { id: 'improved', params: {} },
    opponent: { kind: 'candidate', spec: { id: 'baseline', params: {} } },
    runTag: 'los',
  };
  const runner: MatchRunner = {
    async run(plan: MatchPlan) {
      return {
        status: 'completed',
        outcome: { kind: 'winner', seat: 0 },
        survivors: [0],
        disconnects: 0,
        degraded: false,
        attacks: {},
        quality: blockedQuality(),
        runId: plan.matchId,
      } satisfies MatchObservation;
    },
  };
  const result = await runDuel({ request, runner, concurrency: 1, signal: never });
  const matches = result.report.matches as { score: number; contact_class: string }[];
  assert.deepEqual(matches.map((match) => match.score), [1, 0]);
  assert.ok(matches.every((match) => match.contact_class === 'perception_failure'));
  assert.equal(result.report.score.mean, 0.5);
});

function idleSeat(seatNumber: number, candidate: string): SeatQuality {
  return {
    seat: seatNumber,
    candidate,
    decisions: 0,
    loot: { actions_started: 0, containers_opened: 0, drops_collected: 0, failed: 0, looted: false },
    distance_blocks: 0,
    idle: { ticks: 0, unexplained_ticks: 0, max_unexplained_span_ticks: 0, trapped_ticks: 0, max_trapped_span_ticks: 0, by_reason: {} },
    attacks: {
      engaged: 0, issued: 0, rejected: 0, rejected_by_cause: {}, self_inflicted_rejected: 0, funnel: accountAttackFunnel([]),
    },
    damage: { dealt: 0, taken: 0, taken_from_competitors: 0 },
    time_alive_ticks: 0,
    death: null,
    pvp_share: null,
    reasons: {},
  };
}

function idleQuality(): MatchQuality {
  return {
    schema: 1,
    end_tick: 7200,
    seats: [idleSeat(0, 'improved'), idleSeat(1, 'baseline')],
    pvp_engagements: 0,
    pvp_hits: 0,
    reasons: {},
    eliminations: { total: 0, pvp: 0, by_cause: {} },
    attack_funnel_records: [],
  };
}

function blockedQuality(): MatchQuality {
  const funnel = [
    record('tacticalChoice', { kind: 'stopped', reason: 'blockedLineOfSight', seat: 0, tick: 4 }),
    record('tacticalChoice', { kind: 'stopped', reason: 'blockedLineOfSight', seat: 1, tick: 4 }),
  ];
  const quality = idleQuality();
  return {
    ...quality,
    seats: quality.seats.map((seat) => ({
      ...seat,
      attacks: {
        ...seat.attacks,
        engaged: 1,
        rejected: 1,
        rejected_by_cause: { blockedLineOfSight: 1 },
        self_inflicted_rejected: 1,
        funnel: accountAttackFunnel(funnel.filter((entry) => entry.seat === seat.seat)),
      },
    })),
    attack_funnel_records: funnel,
  };
}

function qualityFromFunnel(funnel: readonly ContactFunnelRecord[], pvpHits: number): MatchQuality {
  let sequence = 1;
  const records: TraceRecord[] = funnel.map((entry) => {
    const actionSequence = String(sequence);
    sequence += 1;
    const outcome = entry.kind === 'reached'
      ? { kind: 'reached', action: entry.action, stage: entry.stage }
      : { kind: 'stopped', action: entry.action, last_passed: entry.stage, reason: entry.reason, eye_to_body_units: null };
    return {
      schema: 'action-funnel-v1',
      seat: entry.seat,
      action_sequence: actionSequence,
      tick: entry.tick,
      intent: 'attack',
      target_entity: 9,
      target_seat: entry.seat === 0 ? 1 : 0,
      border: 'current',
      skill: entry.kind === 'reached' ? 'succeeded' : 'failed',
      funnel: outcome,
    } as unknown as TraceRecord;
  });
  if (pvpHits > 0) {
    records.push({
      direction: 'plugin', type: 'damage', payload: { at: { domain: 'match', value: '10' }, entries: [
        { victim: 1, attacker: 0, cause: 'melee', amount: 1 },
      ] },
    } as unknown as TraceRecord);
  }
  const quality = matchQuality({ run_id: 'r', first_sequence: '1', last_sequence: String(records.length), segments: [], records } satisfies Evidence);
  assert.equal(quality.pvp_hits, pvpHits);
  return quality;
}
