import { ACTION_FUNNEL_STAGES, type ActionFunnelMissReason } from '@arena/core';
import type { Evidence } from './evidence.js';
import { readActionFunnelTraceRecord } from './funnel-record.js';
import { policyDecision } from './funnel-report.js';
import type { TraceRecord } from './trace.js';

export const SELF_INFLICTED_REJECTIONS: ReadonlySet<ActionFunnelMissReason> = new Set<ActionFunnelMissReason>([
  'outOfGeometricReach',
  'cooldownNotReady',
  'aimNotReady',
  'blockedLineOfSight',
  'ownershipDeferred',
  'clientOperationFailed',
  'friendlyFireRisk',
  'noAmmunition',
]);

export const QUALITY_GATES = Object.freeze({
  minLootingSeatFraction: 0.75,
  minPvpEliminationFraction: 0.4,
  maxSelfInflictedRejectionFraction: 0.05,
  maxUnexplainedIdleTicks: 600,
});

const STATIONARY_BLOCKS = 1;
const TELEPORT_BLOCKS = 100;
const ISSUED_INDEX = ACTION_FUNNEL_STAGES.indexOf('issued');
const IN_PLACE_INTENTS = new Set(['attack', 'eat', 'equip', 'containerOpen']);

export interface SeatQuality {
  readonly seat: number;
  readonly candidate: string | null;
  readonly decisions: number;
  readonly loot: Readonly<{
    actions_started: number;
    containers_opened: number;
    drops_collected: number;
    failed: number;
    looted: boolean;
  }>;
  readonly distance_blocks: number;
  readonly idle: Readonly<{
    ticks: number;
    unexplained_ticks: number;
    max_unexplained_span_ticks: number;
    by_reason: Readonly<Record<string, number>>;
  }>;
  readonly attacks: Readonly<{
    engaged: number;
    issued: number;
    rejected: number;
    rejected_by_cause: Readonly<Record<string, number>>;
    self_inflicted_rejected: number;
  }>;
  readonly damage: Readonly<{ dealt: number; taken: number; taken_from_competitors: number }>;
  readonly time_alive_ticks: number;
  readonly death: Readonly<{ tick: number; cause: string; by_seat: number | null; pvp: boolean }> | null;
  readonly pvp_share: number | null;
}

export interface MatchQuality {
  readonly schema: 1;
  readonly end_tick: number | null;
  readonly seats: readonly SeatQuality[];
  readonly pvp_engagements: number;
  readonly pvp_hits: number;
  readonly eliminations: Readonly<{ total: number; pvp: number; by_cause: Readonly<Record<string, number>> }>;
}

interface Point { readonly x: number; readonly z: number }

interface SeatDecision {
  readonly tick: number;
  readonly position: Point | null;
  readonly intent: string;
  readonly waitReason: string | null;
  readonly disposition: string;
  readonly actionSequence: string | null;
  readonly containerPosition: string | null;
}

interface DamageEntry {
  readonly tick: number;
  readonly victim: number;
  readonly attacker: number | null;
  readonly cause: string;
  readonly amount: number;
}

export function matchQuality(evidence: Evidence): MatchQuality {
  const decisionsBySeat = new Map<number, SeatDecision[]>();
  const effects = new Map<string, string>();
  const candidates = new Map<number, string>();
  const funnelBySeat = new Map<number, FunnelOutcome[]>();
  const damage: DamageEntry[] = [];
  const eliminations: { tick: number; seat: number; cause: string }[] = [];
  let endTick: number | null = null;
  let maxTick = 0;

  for (const [index, record] of evidence.records.entries()) {
    if (record.schema === 'seat-policy-v1' && typeof record.seat === 'number' && typeof record.candidate === 'string') {
      candidates.set(record.seat, record.candidate);
      continue;
    }
    if (record.schema === 'policy-effect-v1' && typeof record.decision_sequence === 'string') {
      const kind = (record.skill as { kind?: string } | undefined)?.kind;
      if (typeof kind === 'string') effects.set(record.decision_sequence, kind);
      continue;
    }
    if (record.schema === 'action-funnel-v1') {
      const funnel = readActionFunnelTraceRecord(record, index + 1);
      if (funnel.funnel === null || (funnel.funnel.action !== 'attack' && funnel.funnel.action !== 'shoot')) continue;
      const list = funnelBySeat.get(funnel.seat) ?? [];
      list.push(funnel.funnel);
      funnelBySeat.set(funnel.seat, list);
      continue;
    }
    const summary = policyDecision(record);
    if (summary !== undefined && record.schema !== 'civilization-policy-replay-v1') {
      const decision = readDecision(record, summary.tick);
      if (decision !== undefined) {
        const list = decisionsBySeat.get(summary.seat) ?? [];
        list.push(decision);
        decisionsBySeat.set(summary.seat, list);
        maxTick = Math.max(maxTick, decision.tick);
      }
      continue;
    }
    if (record.direction !== 'plugin') continue;
    const at = matchTick(record.payload);
    if (record.type === 'damage' && at !== null) {
      for (const entry of (record.payload as { entries?: DamageEntry[] }).entries ?? []) {
        damage.push({ tick: at, victim: entry.victim, attacker: entry.attacker, cause: entry.cause, amount: entry.amount });
      }
    } else if (record.type === 'elimination' && at !== null) {
      for (const entry of (record.payload as { eliminations?: { seat: number; cause: string }[] }).eliminations ?? []) {
        eliminations.push({ tick: at, seat: entry.seat, cause: entry.cause });
      }
    } else if (record.type === 'outcome' && at !== null) {
      endTick = at;
    }
  }
  if (endTick === null && maxTick > 0) endTick = maxTick;

  const seatIds = new Set<number>([...decisionsBySeat.keys(), ...funnelBySeat.keys(), ...candidates.keys(),
    ...eliminations.map((entry) => entry.seat)]);
  const seats = [...seatIds].sort((left, right) => left - right).map((seat): SeatQuality => {
    const decisions = decisionsBySeat.get(seat) ?? [];
    const death = deathOf(seat, eliminations, damage);
    const dealt = damage.filter((entry) => entry.attacker === seat && entry.victim !== seat);
    const taken = damage.filter((entry) => entry.victim === seat);
    const takenFromCompetitors = sum(taken.filter((entry) => entry.attacker !== null).map((entry) => entry.amount));
    const takenTotal = sum(taken.map((entry) => entry.amount));
    const alive = death !== null ? death.tick : endTick ?? 0;
    return {
      seat,
      candidate: candidates.get(seat) ?? null,
      decisions: decisions.length,
      loot: lootOf(decisions, effects),
      distance_blocks: round1(distanceOf(decisions)),
      idle: idleOf(decisions),
      attacks: attacksOf(funnelBySeat.get(seat) ?? []),
      damage: { dealt: round1(sum(dealt.map((entry) => entry.amount))), taken: round1(takenTotal),
        taken_from_competitors: round1(takenFromCompetitors) },
      time_alive_ticks: alive,
      death,
      pvp_share: takenTotal === 0 ? null : round3(takenFromCompetitors / takenTotal),
    };
  });

  const pairs = new Set<string>();
  let hits = 0;
  for (const entry of damage) {
    if (entry.attacker === null) continue;
    hits += 1;
    pairs.add(`${Math.min(entry.attacker, entry.victim)}-${Math.max(entry.attacker, entry.victim)}`);
  }
  const byCause: Record<string, number> = {};
  let pvp = 0;
  for (const seat of seats) {
    if (seat.death === null) continue;
    byCause[seat.death.cause] = (byCause[seat.death.cause] ?? 0) + 1;
    if (seat.death.pvp) pvp += 1;
  }
  const disconnects = eliminations.filter((entry) => entry.cause !== 'death').length;
  if (disconnects > 0) byCause.disconnect = disconnects;
  return {
    schema: 1,
    end_tick: endTick,
    seats,
    pvp_engagements: pairs.size,
    pvp_hits: hits,
    eliminations: { total: eliminations.length, pvp, by_cause: byCause },
  };
}

function readDecision(record: TraceRecord, tick: number | null): SeatDecision | undefined {
  if (tick === null) return undefined;
  const input = record.input as { observation?: { agent?: { kind?: string; value?: { position?: { x: number; z: number } } } } };
  const position = input.observation?.agent?.kind === 'current' ? input.observation.agent.value?.position ?? null : null;
  const decision = record.decision as { intent?: { kind?: string; reason?: string; position?: { x: number; y: number; z: number } } };
  const disposition = record.disposition as { kind: string; action_sequence?: string; reason?: string };
  const intentKind = decision.intent?.kind ?? 'unknown';
  const containerPosition = intentKind === 'containerOpen' && decision.intent?.position !== undefined
    ? `${decision.intent.position.x},${decision.intent.position.y},${decision.intent.position.z}` : null;
  return {
    tick,
    position: position === null ? null : { x: position.x, z: position.z },
    intent: intentKind,
    waitReason: intentKind === 'hold' ? decision.intent?.reason ?? 'unspecified' : null,
    disposition: disposition.kind === 'defer' ? `defer:${disposition.reason}` : disposition.kind,
    actionSequence: disposition.kind === 'start' || disposition.kind === 'replace' ? disposition.action_sequence ?? null : null,
    containerPosition,
  };
}

function lootOf(decisions: readonly SeatDecision[], effects: ReadonlyMap<string, string>): SeatQuality['loot'] {
  let started = 0;
  let failed = 0;
  let drops = 0;
  const opened = new Set<string>();
  for (const decision of decisions) {
    if (decision.actionSequence === null) continue;
    if (decision.intent !== 'containerOpen' && decision.intent !== 'dropCollect') continue;
    started += 1;
    const outcome = effects.get(decision.actionSequence);
    if (outcome === 'succeeded') {
      if (decision.intent === 'containerOpen') opened.add(decision.containerPosition ?? decision.actionSequence);
      else drops += 1;
    } else if (outcome === 'failed') failed += 1;
  }
  return { actions_started: started, containers_opened: opened.size, drops_collected: drops, failed,
    looted: opened.size > 0 || drops > 0 };
}

function distanceOf(decisions: readonly SeatDecision[]): number {
  let total = 0;
  for (let index = 1; index < decisions.length; index += 1) {
    const moved = displacement(decisions[index - 1]!, decisions[index]!);
    if (moved !== null && moved < TELEPORT_BLOCKS) total += moved;
  }
  return total;
}

function displacement(from: SeatDecision, to: SeatDecision): number | null {
  if (from.position === null || to.position === null) return null;
  return Math.hypot(to.position.x - from.position.x, to.position.z - from.position.z);
}

function idleOf(decisions: readonly SeatDecision[]): SeatQuality['idle'] {
  const byReason: Record<string, number> = {};
  let ticks = 0;
  let unexplained = 0;
  let span = 0;
  let maxSpan = 0;
  for (let index = 1; index < decisions.length; index += 1) {
    const previous = decisions[index - 1]!;
    const current = decisions[index]!;
    const gap = current.tick - previous.tick;
    const moved = displacement(previous, current);
    if (gap <= 0 || moved === null || moved >= STATIONARY_BLOCKS || IN_PLACE_INTENTS.has(previous.intent)) {
      span = 0;
      continue;
    }
    ticks += gap;
    let reason: string | null = null;
    if (previous.waitReason !== null) reason = `wait:${previous.waitReason}`;
    else if (previous.disposition === 'hold' || previous.disposition.startsWith('defer:')) reason = previous.disposition;
    if (reason === null) {
      reason = `no_progress:${previous.intent}`;
      unexplained += gap;
      span += gap;
      maxSpan = Math.max(maxSpan, span);
    } else span = 0;
    byReason[reason] = (byReason[reason] ?? 0) + gap;
  }
  return { ticks, unexplained_ticks: unexplained, max_unexplained_span_ticks: maxSpan, by_reason: byReason };
}

type FunnelOutcome = NonNullable<ReturnType<typeof readActionFunnelTraceRecord>['funnel']>;

function attacksOf(outcomes: readonly FunnelOutcome[]): SeatQuality['attacks'] {
  let issued = 0;
  let rejected = 0;
  let selfInflicted = 0;
  const byCause: Record<string, number> = {};
  for (const outcome of outcomes) {
    const last = outcome.kind === 'reached' ? outcome.stage : outcome.last_passed;
    if (ACTION_FUNNEL_STAGES.indexOf(last) >= ISSUED_INDEX) {
      issued += 1;
      continue;
    }
    if (outcome.kind !== 'stopped') continue;
    rejected += 1;
    byCause[outcome.reason] = (byCause[outcome.reason] ?? 0) + 1;
    if (SELF_INFLICTED_REJECTIONS.has(outcome.reason)) selfInflicted += 1;
  }
  return { engaged: outcomes.length, issued, rejected, rejected_by_cause: byCause, self_inflicted_rejected: selfInflicted };
}

function deathOf(
  seat: number,
  eliminations: readonly { tick: number; seat: number; cause: string }[],
  damage: readonly DamageEntry[],
): SeatQuality['death'] {
  const elimination = eliminations.find((entry) => entry.seat === seat);
  if (elimination === undefined) return null;
  if (elimination.cause !== 'death') return { tick: elimination.tick, cause: elimination.cause, by_seat: null, pvp: false };
  const last = damage.filter((entry) => entry.victim === seat && entry.tick <= elimination.tick).at(-1);
  if (last === undefined) return { tick: elimination.tick, cause: 'unknown', by_seat: null, pvp: false };
  return { tick: elimination.tick, cause: last.cause, by_seat: last.attacker, pvp: last.attacker !== null };
}

function matchTick(payload: unknown): number | null {
  const at = (payload as { at?: { domain?: string; value?: string } }).at;
  return at?.domain === 'match' && typeof at.value === 'string' ? Number(at.value) : null;
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const round1 = (value: number): number => Math.round(value * 10) / 10;
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

export interface QualityGateResult {
  readonly id: string;
  readonly description: string;
  readonly value: number | null;
  readonly threshold: number;
  readonly passed: boolean;
  readonly reason: 'ok' | 'below_threshold' | 'above_threshold' | 'no_data';
}

export interface QualityMatchInput {
  readonly label: string;
  readonly terminated: boolean;
  readonly quality: MatchQuality | null;
}

export function qualityGates(matches: readonly QualityMatchInput[]): readonly QualityGateResult[] {
  const withQuality = matches.filter((match): match is QualityMatchInput & { quality: MatchQuality } => match.quality !== null);
  const seats = withQuality.flatMap((match) => match.quality.seats);
  const gate = (
    id: string, description: string, value: number | null, threshold: number, direction: 'min' | 'max',
  ): QualityGateResult => {
    if (value === null) return { id, description, value, threshold, passed: false, reason: 'no_data' };
    const passed = direction === 'min' ? value >= threshold : value <= threshold;
    return { id, description, value: round3(value), threshold, passed,
      reason: passed ? 'ok' : direction === 'min' ? 'below_threshold' : 'above_threshold' };
  };
  const terminated = matches.length === 0 ? null : matches.filter((match) => match.terminated).length / matches.length;
  const looters = seats.length === 0 ? null : seats.filter((seat) => seat.loot.looted).length / seats.length;
  const deaths = sum(withQuality.map((match) => match.quality.eliminations.total));
  const pvpDeaths = sum(withQuality.map((match) => match.quality.eliminations.pvp));
  const issued = sum(seats.map((seat) => seat.attacks.issued));
  const selfInflicted = sum(seats.map((seat) => seat.attacks.self_inflicted_rejected));
  const worstIdle = seats.length === 0 ? null : Math.max(...seats.map((seat) => seat.idle.max_unexplained_span_ticks));
  return [
    gate('all_terminate', 'matches that terminate', terminated, 1, 'min'),
    gate('seats_loot', 'seats that opened a chest or collected a drop', looters, QUALITY_GATES.minLootingSeatFraction, 'min'),
    gate('pvp_eliminations', 'eliminations caused by another competitor', deaths === 0 ? null : pvpDeaths / deaths,
      QUALITY_GATES.minPvpEliminationFraction, 'min'),
    gate('self_inflicted_rejections', 'self-inflicted attack rejections per issued attack',
      issued === 0 ? null : selfInflicted / issued, QUALITY_GATES.maxSelfInflictedRejectionFraction, 'max'),
    gate('no_unexplained_idle', 'longest unexplained idle span in ticks', worstIdle, QUALITY_GATES.maxUnexplainedIdleTicks, 'max'),
  ];
}

export function renderQualityTable(matches: readonly Readonly<{ label: string; quality: MatchQuality | null; note?: string }>[]): string {
  const header = ['seat', 'policy', 'loot', 'chests', 'dist', 'idle', 'unexpl', 'atk iss/rej', 'self', 'dmg out/in', 'alive', 'death', 'pvp%'];
  const lines: string[] = [];
  for (const match of matches) {
    lines.push(`${match.label}${match.note === undefined ? '' : ` (${match.note})`}`);
    if (match.quality === null) {
      lines.push('  no quality evidence');
      continue;
    }
    const rows = match.quality.seats.map((seat) => [
      String(seat.seat),
      seat.candidate ?? 'default',
      String(seat.loot.actions_started),
      String(seat.loot.containers_opened),
      String(Math.round(seat.distance_blocks)),
      String(seat.idle.ticks),
      String(seat.idle.unexplained_ticks),
      `${seat.attacks.issued}/${seat.attacks.rejected}`,
      String(seat.attacks.self_inflicted_rejected),
      `${seat.damage.dealt}/${seat.damage.taken}`,
      String(seat.time_alive_ticks),
      seat.death === null ? '-' : `${seat.death.cause}@${seat.death.tick}${seat.death.pvp ? `<-${seat.death.by_seat}` : ''}`,
      seat.pvp_share === null ? '-' : String(Math.round(seat.pvp_share * 100)),
    ]);
    const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]!.length)));
    const format = (cells: readonly string[]): string => `  ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join('  ')}`;
    lines.push(format(header), ...rows.map(format));
    const e = match.quality.eliminations;
    lines.push(`  pvp engagements ${match.quality.pvp_engagements}, hits ${match.quality.pvp_hits}, `
      + `eliminations ${e.total} (pvp ${e.pvp}), end tick ${match.quality.end_tick ?? '-'}`);
  }
  return lines.join('\n');
}

export function renderGates(gates: readonly QualityGateResult[]): string {
  return gates.map((entry) => `  [${entry.passed ? 'pass' : 'FAIL'}] ${entry.id}: ${entry.value ?? 'n/a'} `
    + `(${entry.reason}, threshold ${entry.threshold}) ${entry.description}`).join('\n');
}
