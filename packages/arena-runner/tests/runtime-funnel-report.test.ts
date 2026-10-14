import assert from 'node:assert/strict';
import test from 'node:test';
import type { Evidence } from '../src/evidence.js';
import { actionFunnelReport, explainSeatJson, ATTRIBUTION_WINDOW_TICKS } from '../src/funnel-report.js';
import { readActionFunnelTraceRecord } from '../src/funnel-record.js';
import { parseSegment, TraceError, type TraceRecord } from '../src/trace.js';
import { canonicalJson, sha256Json } from '../src/canonical.js';

function decision(sequence: string, seat: number, tick: number, disposition: object, intent = 'attack'): TraceRecord {
  return {
    schema: 'policy-replay-v2', sequence, seat, rng_state_after: '1',
    input: { observation: { tick, border: { kind: 'current', value: {} }, opponents: { kind: 'current', value: [{}, {}] },
      agent: { kind: 'current', value: {} }, loot: { kind: 'unknown' } } },
    decision: { goal: { kind: 'engageVisibleOpponent' }, intent: { kind: intent } },
    disposition,
  } as TraceRecord;
}

function funnel(sequence: string, seat: number, tick: number, targetSeat: number | null, outcome: object): TraceRecord {
  return {
    schema: 'action-funnel-v1', seat, action_sequence: sequence, tick, intent: 'attack', target_entity: 9,
    target_seat: targetSeat, border: 'current', skill: 'succeeded', funnel: outcome,
  } as TraceRecord;
}

function elimination(tick: number, seat: number, cause: string): TraceRecord {
  return { direction: 'plugin', type: 'elimination', payload: { at: { domain: 'match', value: String(tick) },
    eliminations: [{ seat, cause }] } } as TraceRecord;
}

function evidence(records: TraceRecord[]): Evidence {
  return { run_id: 'funnel-run', first_sequence: '1', last_sequence: String(records.length), segments: [], records };
}

const records = [
  decision('1', 0, 10, { kind: 'start', action_sequence: '1' }),
  decision('2', 0, 14, { kind: 'continue', action_sequence: '1' }),
  decision('3', 0, 18, { kind: 'defer', action_sequence: '1', reason: 'hysteresis' }),
  decision('4', 1, 12, { kind: 'start', action_sequence: '4' }),
  funnel('1', 0, 10, 1, { kind: 'reached', action: 'attack', stage: 'clientResponse' }),
  funnel('4', 1, 12, 0, { kind: 'stopped', action: 'attack', last_passed: 'tacticalChoice', reason: 'cooldownNotReady', eye_to_body_units: null }),
  elimination(40, 1, 'death'),
];

test('action funnel report counts decisions, stages, misses and authoritative confirmations per seat', () => {
  const report = actionFunnelReport(evidence(records)) as {
    effect_source: string;
    seats: { seat: number; decisions: any; actions: any; funnel: any }[];
  };
  assert.equal(report.effect_source, 'authoritative_elimination_events');
  const seat0 = report.seats[0]!;
  assert.deepEqual([seat0.seat, seat0.decisions.proposed, seat0.decisions.accepted, seat0.decisions.continued], [0, 3, 1, 1]);
  assert.deepEqual(seat0.decisions.deferred, { 'defer:hysteresis': 1 });
  assert.deepEqual(seat0.decisions.border, { current: 3 });
  assert.equal(seat0.funnel.attack.engaged, 1);
  assert.equal(seat0.funnel.attack.passed.clientResponse, 1);
  assert.equal(seat0.funnel.attack.confirmed_effects, 1);
  const seat1 = report.seats[1]!;
  assert.deepEqual(seat1.funnel.attack.stopped, { cooldownNotReady: 1 });
  assert.equal(seat1.funnel.attack.passed.skillAdmission, undefined);
  assert.equal(seat1.funnel.attack.passed.tacticalChoice, 1);
  assert.equal(seat1.funnel.attack.confirmed_effects, 0);
});

test('action funnel report is absent without funnel records and confirmation respects the attribution window', () => {
  assert.equal(actionFunnelReport(evidence(records.filter((record) => record.schema !== 'action-funnel-v1'))), undefined);
  const late = [records[0]!, funnel('1', 0, 10, 1, { kind: 'reached', action: 'attack', stage: 'issued' }),
    elimination(10 + ATTRIBUTION_WINDOW_TICKS + 1, 1, 'death')];
  const report = actionFunnelReport(evidence(late)) as { seats: { funnel: any }[] };
  assert.equal(report.seats[0]!.funnel.attack.confirmed_effects, 0);
});

test('explain ties a seat decisions to permitted evidence and confirmed effects without inventing causes', () => {
  const explained = explainSeatJson(evidence([
    ...records,
    { schema: 'policy-effect-v1', decision_sequence: '1', skill: { kind: 'succeeded' }, path_updates: [] } as TraceRecord,
  ]), 0) as { decisions: any[]; actions: any[]; own_eliminations: unknown[]; basis: string };
  assert.equal(explained.decisions.length, 3);
  assert.deepEqual(explained.decisions[0].permitted_evidence.opponents, { kind: 'current', count: 2 });
  assert.deepEqual(explained.decisions[0].permitted_evidence.loot, { kind: 'unknown' });
  assert.equal(explained.actions.length, 1);
  assert.deepEqual(explained.actions[0].skill_outcome, { kind: 'succeeded' });
  assert.deepEqual(explained.actions[0].confirmed_effect, { kind: 'target_eliminated', seat: 1, tick: 40 });
  assert.deepEqual(explained.own_eliminations, []);
});

test('funnel trace records are strict and older trace schemas reject them', () => {
  assert.throws(() => readActionFunnelTraceRecord({ ...funnel('1', 0, 1, null, { kind: 'reached', action: 'attack', stage: 'issued' }), extra: 1 } as TraceRecord, 3),
    (error: unknown) => error instanceof TraceError && error.source.kind === 'invalid_action_funnel_record');
  assert.throws(() => readActionFunnelTraceRecord(funnel('1', 0, 1, null, { kind: 'reached', action: 'attack', stage: 'nonsense' }), 3),
    (error: unknown) => error instanceof TraceError);
  const body = [funnel('1', 0, 1, null, { kind: 'reached', action: 'attack', stage: 'issued' })];
  const text = (schema: number) => canonicalJson({ schema, run_id: 'r', first_sequence: '1', last_sequence: '1',
    records: body, sha256: sha256Json(body), trailer: { complete: true } });
  assert.equal(parseSegment(text(4)).schema, 4);
  for (const schema of [2, 3]) {
    assert.throws(() => parseSegment(text(schema)), (error: unknown) =>
      error instanceof TraceError && error.source.kind === 'unsupported_funnel_schema');
  }
});

test('damage events confirm attack and shoot effects when the match opted in', () => {
  const prepare = { direction: 'runner', type: 'prepare', payload: { damage_events: true } } as unknown as TraceRecord;
  const damage = (tick: number, victim: number, attacker: number | null, cause: string) => ({
    direction: 'plugin', type: 'damage',
    payload: { at: { domain: 'match', value: String(tick) }, entries: [{ victim, attacker, cause, amount: 4, attacker_is_competitor: attacker !== null }] },
  }) as unknown as TraceRecord;
  const body = [
    prepare,
    funnel('1', 0, 10, 1, { kind: 'reached', action: 'attack', stage: 'clientResponse' }),
    funnel('2', 0, 20, 2, { kind: 'reached', action: 'shoot', stage: 'clientResponse' }),
    funnel('3', 0, 30, 3, { kind: 'reached', action: 'attack', stage: 'clientResponse' }),
    damage(12, 1, 0, 'melee'),
    damage(25, 2, 0, 'melee'),
    damage(31, 3, null, 'melee'),
    elimination(32, 3, 'death'),
  ];
  const report = actionFunnelReport(evidence(body)) as { effect_source: string; seats: { funnel: any }[] };
  assert.equal(report.effect_source, 'damage_events');
  assert.equal(report.seats[0]!.funnel.attack.attributable, 2);
  assert.equal(report.seats[0]!.funnel.attack.confirmed_effects, 1);
  assert.equal(report.seats[0]!.funnel.shoot.confirmed_effects, 0);
});

test('report counts client border-unknown diagnostics per seat', () => {
  const notes = [
    { schema: 'client-diagnostic-v1', seat: 2, tick: 100, diagnostic: 'borderUnknown', reason: 'noPacketReceived', consecutive_observations: 100 },
    { schema: 'client-diagnostic-v1', seat: 2, tick: 400, diagnostic: 'borderUnknown', reason: 'fractionalCenter', consecutive_observations: 100 },
  ] as unknown as TraceRecord[];
  const report = actionFunnelReport(evidence(notes)) as { seats: { seat: number; border_unknown: any }[] };
  assert.deepEqual(report.seats.map((entry) => entry.seat), [2]);
  assert.deepEqual(report.seats[0]!.border_unknown, {
    events: 2, max_consecutive_observations: 100, reasons: { fractionalCenter: 1, noPacketReceived: 1 },
  });
});
