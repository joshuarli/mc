import { ACTION_FUNNEL_STAGES, type ActionFunnelAction } from '@arena/core';
import type { Evidence } from './evidence.js';
import { FUNNEL_ACTIONS, readActionFunnelTraceRecord, type ActionFunnelTraceRecordV1 } from './funnel-record.js';
import type { TraceRecord } from './trace.js';

export const ATTRIBUTION_WINDOW_TICKS = 100;

export interface DeathElimination {
  readonly seat: number;
  readonly tick: number;
}

export function actionFunnelReport(evidence: Evidence): object | undefined {
  const funnelRecords: ActionFunnelTraceRecordV1[] = [];
  for (const [index, record] of evidence.records.entries()) {
    if (record.schema === 'action-funnel-v1') funnelRecords.push(readActionFunnelTraceRecord(record, index + 1));
  }
  if (funnelRecords.length === 0) return undefined;

  const deaths = deathEliminations(evidence.records);
  const seats = new Map<number, SeatTally>();
  const tally = (seat: number): SeatTally => {
    let existing = seats.get(seat);
    if (existing === undefined) {
      existing = newTally();
      seats.set(seat, existing);
    }
    return existing;
  };

  for (const record of evidence.records) {
    const decision = policyDecision(record);
    if (decision === undefined) continue;
    const entry = tally(decision.seat);
    entry.decisions.proposed += 1;
    bump(entry.decisions.border, decision.border);
    switch (decision.disposition) {
      case 'start': case 'replace': entry.decisions.accepted += 1; break;
      case 'continue': entry.decisions.continued += 1; break;
      case 'hold': entry.decisions.held += 1; break;
      default: bump(entry.decisions.deferred, decision.disposition);
    }
  }

  for (const record of funnelRecords) {
    const entry = tally(record.seat);
    entry.actions.total += 1;
    bump(entry.actions.by_intent, record.intent);
    bump(entry.actions.skill, record.skill);
    if (record.funnel === null) continue;
    const funnel = entry.funnel[record.funnel.action];
    funnel.engaged += 1;
    const last = record.funnel.kind === 'reached' ? record.funnel.stage : record.funnel.last_passed;
    for (const stage of ACTION_FUNNEL_STAGES) {
      funnel.passed[stage] = (funnel.passed[stage] ?? 0) + 1;
      if (stage === last) break;
    }
    if (record.funnel.kind === 'stopped') bump(funnel.stopped, record.funnel.reason);
    if ((record.funnel.action === 'attack' || record.funnel.action === 'shoot') && record.target_seat !== null && record.tick !== null) {
      funnel.attributable += 1;
      const tick = record.tick;
      if (deaths.some((death) => death.seat === record.target_seat
          && death.tick >= tick && death.tick <= tick + ATTRIBUTION_WINDOW_TICKS)) {
        funnel.target_eliminated_within_window += 1;
      }
    }
  }

  return {
    effect_source: 'authoritative_elimination_events',
    attribution_window_ticks: ATTRIBUTION_WINDOW_TICKS,
    seats: [...seats.entries()].sort(([left], [right]) => left - right).map(([seat, value]) => ({ seat, ...value })),
  };
}

export function deathEliminations(records: readonly TraceRecord[]): readonly DeathElimination[] {
  const deaths: DeathElimination[] = [];
  for (const record of records) {
    if (record.direction !== 'plugin' || record.type !== 'elimination') continue;
    const payload = record.payload as { at?: { domain?: string; value?: string }; eliminations?: { seat: number; cause: string }[] };
    if (payload.at?.domain !== 'match' || typeof payload.at.value !== 'string') continue;
    const tick = Number(payload.at.value);
    for (const elimination of payload.eliminations ?? []) {
      if (elimination.cause === 'death') deaths.push({ seat: elimination.seat, tick });
    }
  }
  return deaths;
}

export interface DecisionSummary {
  readonly seat: number;
  readonly sequence: string;
  readonly tick: number | null;
  readonly disposition: string;
  readonly border: 'current' | 'stale' | 'unknown';
  readonly goal: string;
  readonly intent: string;
  readonly actionSequence: string | null;
}

export function policyDecision(record: TraceRecord): DecisionSummary | undefined {
  const schema = record.schema;
  if (schema !== 'policy-replay-v2' && schema !== 'policy-replay-v3' && schema !== 'civilization-policy-replay-v1') return undefined;
  const input = record.input as { observation?: Record<string, unknown> };
  const observation = schema === 'civilization-policy-replay-v1'
    ? (input.observation?.base as Record<string, unknown> | undefined)
    : input.observation;
  const border = (observation?.border as { kind?: string } | undefined)?.kind;
  const disposition = record.disposition as { kind: string; action_sequence?: string; reason?: string };
  const decision = record.decision as { goal: { kind: string }; intent: { kind: string } };
  return {
    seat: record.seat as number,
    sequence: record.sequence as string,
    tick: typeof observation?.tick === 'number' ? observation.tick : null,
    disposition: disposition.kind === 'defer' ? `defer:${disposition.reason}` : disposition.kind,
    border: border === 'current' || border === 'stale' ? border : 'unknown',
    goal: decision.goal.kind,
    intent: decision.intent.kind,
    actionSequence: disposition.kind === 'start' || disposition.kind === 'replace' ? disposition.action_sequence ?? null : null,
  };
}

interface FunnelTally {
  engaged: number;
  passed: Record<string, number>;
  stopped: Record<string, number>;
  attributable: number;
  target_eliminated_within_window: number;
}

interface SeatTally {
  decisions: {
    proposed: number;
    accepted: number;
    continued: number;
    held: number;
    deferred: Record<string, number>;
    border: Record<string, number>;
  };
  actions: { total: number; by_intent: Record<string, number>; skill: Record<string, number> };
  funnel: Record<ActionFunnelAction, FunnelTally>;
}

function newTally(): SeatTally {
  const funnel = (): FunnelTally => ({
    engaged: 0, passed: {}, stopped: {}, attributable: 0, target_eliminated_within_window: 0,
  });
  return {
    decisions: { proposed: 0, accepted: 0, continued: 0, held: 0, deferred: {}, border: {} },
    actions: { total: 0, by_intent: {}, skill: {} },
    funnel: Object.fromEntries(FUNNEL_ACTIONS.map((action) => [action, funnel()])) as Record<ActionFunnelAction, FunnelTally>,
  };
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function explainSeatJson(evidence: Evidence, seat: number): object {
  const effects = new Map<string, unknown>();
  const funnels = new Map<string, ActionFunnelTraceRecordV1>();
  for (const [index, record] of evidence.records.entries()) {
    if ((record.schema === 'policy-effect-v1' || record.schema === 'civilization-policy-effect-v1')
        && typeof record.decision_sequence === 'string') {
      effects.set(record.decision_sequence, record.skill);
    }
    if (record.schema === 'action-funnel-v1') {
      const funnel = readActionFunnelTraceRecord(record, index + 1);
      if (funnel.seat === seat) funnels.set(funnel.action_sequence, funnel);
    }
  }
  const deaths = deathEliminations(evidence.records);
  const decisions: object[] = [];
  const actions: object[] = [];
  for (const record of evidence.records) {
    const summary = policyDecision(record);
    if (summary === undefined || summary.seat !== seat) continue;
    decisions.push({
      tick: summary.tick,
      sequence: summary.sequence,
      disposition: summary.disposition,
      goal: summary.goal,
      intent: summary.intent,
      permitted_evidence: permittedEvidence(record),
      ...(summary.actionSequence === null ? {} : { action_sequence: summary.actionSequence }),
    });
    if (summary.actionSequence === null) continue;
    const funnel = funnels.get(summary.actionSequence);
    const skill = effects.get(summary.actionSequence);
    const confirmed = funnel === undefined || (funnel.funnel?.action !== 'attack' && funnel.funnel?.action !== 'shoot') || funnel.target_seat === null || funnel.tick === null
      ? null
      : deaths.find((death) => death.seat === funnel.target_seat
        && death.tick >= funnel.tick! && death.tick <= funnel.tick! + ATTRIBUTION_WINDOW_TICKS) ?? null;
    actions.push({
      action_sequence: summary.actionSequence,
      decision_tick: summary.tick,
      started_tick: funnel?.tick ?? null,
      intent: summary.intent,
      skill_outcome: skill ?? null,
      funnel: funnel?.funnel ?? null,
      target_seat: funnel?.target_seat ?? null,
      confirmed_effect: confirmed === null ? null : { kind: 'target_eliminated', seat: confirmed.seat, tick: confirmed.tick },
    });
  }
  return {
    schema: 1,
    run_id: evidence.run_id,
    seat,
    basis: 'recorded_policy_inputs_skill_outcomes_and_authoritative_events',
    decisions,
    actions,
    failures: actions.filter((action) => {
      const skill = (action as { skill_outcome: { kind?: string } | null }).skill_outcome;
      return skill !== null && skill.kind === 'failed';
    }),
    own_eliminations: deaths.filter((death) => death.seat === seat),
  };
}

function permittedEvidence(record: TraceRecord): object {
  const input = record.input as { observation?: Record<string, unknown> };
  const base = record.schema === 'civilization-policy-replay-v1'
    ? (input.observation?.base as Record<string, unknown> | undefined)
    : input.observation;
  const knowledge = (field: string): { kind: string; count?: number } => {
    const value = base?.[field] as { kind?: string; value?: unknown } | undefined;
    if (value === undefined || typeof value.kind !== 'string') return { kind: 'unknown' };
    return Array.isArray(value.value) ? { kind: value.kind, count: value.value.length } : { kind: value.kind };
  };
  return {
    agent: knowledge('agent'),
    border: knowledge('border'),
    opponents: knowledge('opponents'),
    loot: knowledge('loot'),
  };
}
