import {
  ACTION_FUNNEL_STAGES,
  type ActionFunnelMissReason,
  type ActionFunnelStage,
} from '@arena/core';

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

export const CONTACT_CLASSES = [
  'fixture_invalid',
  'perception_failure',
  'policy_failure',
  'skill_failure',
  'valid_loss',
  'valid_draw',
  'valid_win',
] as const;

export type ContactClass = typeof CONTACT_CLASSES[number];

export type ContactValidity = 'no_combat_demonstrated' | 'combat_demonstrated';

const PERCEPTION_MISS_REASONS: ReadonlySet<ActionFunnelMissReason> = new Set([
  'blockedLineOfSight',
  'targetNoLongerVisible',
]);

const ISSUED_INDEX = ACTION_FUNNEL_STAGES.indexOf('issued');
const ADMITTED_INDEX = ACTION_FUNNEL_STAGES.indexOf('skillAdmission');

export interface ContactFunnelRecord {
  readonly action: 'attack' | 'shoot';
  readonly kind: 'reached' | 'stopped';
  readonly stage: ActionFunnelStage;
  readonly reason: ActionFunnelMissReason | null;
  readonly seat: number | null;
  readonly tick: number | null;
}

export interface AttackFunnelConservation {
  readonly not_admitted: number;
  readonly admitted_but_not_issued: number;
  readonly issued: number;
}

export interface AttackFunnelReport {
  readonly schema: 1;
  readonly records: number;
  readonly stages: Readonly<Record<ActionFunnelStage, number>>;
  readonly attempted: number;
  readonly admitted: number;
  readonly issued: number;
  readonly confirmed: number;
  readonly rejected: number;
  readonly conservation: AttackFunnelConservation;
  readonly deferred_count: number;
  readonly issued_illegal_count: number;
  readonly issued_illegal_fraction: number | null;
}

export interface ContactAssessmentInput {
  readonly completed: boolean;
  readonly legal_outcome: boolean;
  readonly score: 0 | 0.5 | 1 | null;
  readonly attacks_issued: number | null;
  readonly pvp_hits: number | null;
  readonly funnel: readonly ContactFunnelRecord[] | null;
  readonly seats: readonly number[] | null;
}

export type CombatOpportunities =
  | Readonly<{ count: number }>
  | Readonly<{ count: null; reason: 'evidence_absent' }>;

export interface ContactAssessment {
  readonly contact_validity: ContactValidity | null;
  readonly combat_skill_qualified: boolean | null;
  readonly combat_opportunities: CombatOpportunities;
  readonly contact_class: ContactClass | null;
  readonly attack_funnel: AttackFunnelReport | null;
}

function stageIndex(stage: ActionFunnelStage): number {
  const index = ACTION_FUNNEL_STAGES.indexOf(stage);
  if (index < 0) throw new TypeError(`unknown action funnel stage: ${stage}`);
  return index;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function validGameClass(score: 0 | 0.5 | 1): 'valid_loss' | 'valid_draw' | 'valid_win' {
  if (score === 1) return 'valid_win';
  if (score === 0) return 'valid_loss';
  return 'valid_draw';
}

export function accountAttackFunnel(records: readonly ContactFunnelRecord[]): AttackFunnelReport {
  const stages: Record<ActionFunnelStage, number> = {
    opportunity: 0,
    tacticalChoice: 0,
    skillAdmission: 0,
    localValidation: 0,
    issued: 0,
    clientResponse: 0,
    confirmedEffect: 0,
  };
  let rejected = 0;
  let admittedButNotIssued = 0;
  let issuedRecords = 0;
  let unadmitted = 0;
  let deferred = 0;
  let issuedIllegal = 0;
  for (const record of records) {
    if (record.action !== 'attack' && record.action !== 'shoot') {
      throw new TypeError(`attack funnel record has action ${String(record.action)}`);
    }
    if (record.kind === 'stopped' && record.reason === null) throw new TypeError('a stopped attack funnel record has no miss reason');
    if (record.kind === 'reached' && record.reason !== null) throw new TypeError('a reached attack funnel record has a miss reason');
    const index = stageIndex(record.stage);
    for (let cursor = 0; cursor <= index; cursor += 1) stages[ACTION_FUNNEL_STAGES[cursor]!] += 1;
    if (record.kind === 'stopped') rejected += 1;
    if (index >= ISSUED_INDEX) issuedRecords += 1;
    else if (index >= ADMITTED_INDEX) admittedButNotIssued += 1;
    else unadmitted += 1;
    if (record.kind === 'stopped' && record.reason === 'ownershipDeferred') deferred += 1;
    if (record.kind === 'stopped' && record.reason !== null && record.reason !== 'ownershipDeferred'
        && SELF_INFLICTED_REJECTIONS.has(record.reason) && index >= ISSUED_INDEX) issuedIllegal += 1;
  }
  if (stages.issued !== issuedRecords) throw new TypeError('issued stage count drifted from issued records');
  const conservation = Object.freeze({
    not_admitted: unadmitted,
    admitted_but_not_issued: admittedButNotIssued,
    issued: issuedRecords,
  });
  if (conservation.not_admitted + conservation.admitted_but_not_issued + conservation.issued !== records.length) {
    throw new TypeError('attack funnel conservation drifted');
  }
  return Object.freeze({
    schema: 1 as const,
    records: records.length,
    stages: Object.freeze(stages),
    attempted: stages.opportunity,
    admitted: stages.skillAdmission,
    issued: stages.issued,
    confirmed: stages.confirmedEffect,
    rejected,
    conservation,
    deferred_count: deferred,
    issued_illegal_count: issuedIllegal,
    issued_illegal_fraction: stages.issued === 0 ? null : round3(issuedIllegal / stages.issued),
  });
}

function perceptionMiss(record: ContactFunnelRecord): boolean {
  return record.kind === 'stopped' && record.reason !== null && PERCEPTION_MISS_REASONS.has(record.reason);
}

function unreachable(record: ContactFunnelRecord): boolean {
  return record.kind === 'stopped' && record.reason === 'outOfGeometricReach';
}

function issuedIllegal(record: ContactFunnelRecord): boolean {
  return record.kind === 'stopped' && record.reason !== null && record.reason !== 'ownershipDeferred'
    && SELF_INFLICTED_REJECTIONS.has(record.reason) && stageIndex(record.stage) >= ISSUED_INDEX;
}

function policyContactWithoutSwing(record: ContactFunnelRecord): boolean {
  if (stageIndex(record.stage) >= ISSUED_INDEX) return false;
  if (record.kind === 'stopped' && record.reason !== null) {
    if (PERCEPTION_MISS_REASONS.has(record.reason)) return false;
    if (record.reason === 'outOfGeometricReach') return false;
    if (record.reason === 'ownershipDeferred') return false;
  }
  return true;
}

function confirmedDamage(records: readonly ContactFunnelRecord[], pvpHits: number): boolean {
  return pvpHits > 0 || records.some((record) => record.kind === 'reached' && record.stage === 'confirmedEffect');
}

function supportsMutualOpportunity(record: ContactFunnelRecord): boolean {
  if (perceptionMiss(record) || unreachable(record)) return false;
  return true;
}

export function combatOpportunities(input: ContactAssessmentInput): CombatOpportunities {
  const absent: CombatOpportunities = Object.freeze({ count: null, reason: 'evidence_absent' });
  if (input.funnel === null || input.seats === null || input.seats.length < 2) return absent;
  if (input.funnel.length === 0) return absent;
  if (input.funnel.some((record) => record.seat === null || record.tick === null)) return absent;
  const seatSet = new Set(input.seats);
  const recorded = new Set<number>();
  const byTick = new Map<number, Set<number>>();
  for (const record of input.funnel) {
    if (record.seat === null || !seatSet.has(record.seat)) continue;
    recorded.add(record.seat);
    if (!supportsMutualOpportunity(record) || record.tick === null) continue;
    const seen = byTick.get(record.tick) ?? new Set<number>();
    seen.add(record.seat);
    byTick.set(record.tick, seen);
  }
  if (recorded.size < 2) return absent;
  let count = 0;
  for (const seen of byTick.values()) if (seen.size >= 2) count += 1;
  return Object.freeze({ count });
}

export function classifyContact(input: ContactAssessmentInput): ContactAssessment {
  const funnel = input.funnel === null ? null : accountAttackFunnel(input.funnel);
  if (funnel !== null && input.attacks_issued !== null && funnel.issued !== input.attacks_issued) {
    throw new TypeError(`issued attacks ${input.attacks_issued} do not match funnel ${funnel.issued}`);
  }
  const knownCounts = input.completed && input.attacks_issued !== null && input.pvp_hits !== null;
  const contactValidity: ContactValidity | null = !knownCounts ? null
    : input.attacks_issued === 0 && input.pvp_hits === 0 ? 'no_combat_demonstrated' : 'combat_demonstrated';
  const records = input.funnel ?? [];
  let contactClass: ContactClass | null = null;
  if (input.completed) {
    if (!input.legal_outcome || input.score === null || !knownCounts) contactClass = 'fixture_invalid';
    else if (input.funnel !== null && records.some(perceptionMiss) && !confirmedDamage(records, input.pvp_hits!)) {
      contactClass = 'perception_failure';
    } else if (input.funnel !== null && records.some(unreachable) && !confirmedDamage(records, input.pvp_hits!)) {
      contactClass = 'fixture_invalid';
    } else if (records.some(issuedIllegal) && input.pvp_hits === 0) contactClass = 'skill_failure';
    else if (input.attacks_issued === 0 && input.pvp_hits === 0 && input.funnel !== null && records.some(policyContactWithoutSwing)) {
      contactClass = 'policy_failure';
    } else if (input.attacks_issued === 0 && input.pvp_hits === 0) {
      contactClass = 'perception_failure';
    } else contactClass = validGameClass(input.score!);
  }
  return Object.freeze({
    contact_validity: contactValidity,
    combat_skill_qualified: contactValidity === null ? null : contactValidity === 'combat_demonstrated',
    combat_opportunities: combatOpportunities(input),
    contact_class: contactClass,
    attack_funnel: funnel,
  });
}
