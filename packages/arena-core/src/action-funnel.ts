import type { EntityId } from './observation.js';

export const ACTION_FUNNEL_STAGES = [
  'opportunity',
  'tacticalChoice',
  'skillAdmission',
  'localValidation',
  'issued',
  'clientResponse',
  'confirmedEffect',
] as const;

export type ActionFunnelStage = typeof ACTION_FUNNEL_STAGES[number];

export const ACTION_FUNNEL_MISS_REASONS = [
  'outOfGeometricReach',
  'targetNoLongerVisible',
  'targetDespawnedOrEliminated',
  'cooldownNotReady',
  'aimNotReady',
  'blockedLineOfSight',
  'ownershipDeferred',
  'clientOperationFailed',
  'serverRejection',
  'ambiguousConfirmation',
  'timeout',
  'agentEliminated',
  'runShutdown',
] as const;

export type ActionFunnelMissReason = typeof ACTION_FUNNEL_MISS_REASONS[number];

export type ActionFunnelAction = 'approach' | 'attack';

export type ActionFunnelRecord =
  | {
    readonly kind: 'reached';
    readonly action: ActionFunnelAction;
    readonly target: EntityId;
    readonly stage: ActionFunnelStage;
  }
  | {
    readonly kind: 'stopped';
    readonly action: ActionFunnelAction;
    readonly target: EntityId;
    readonly lastPassed: ActionFunnelStage;
    readonly reason: ActionFunnelMissReason;
    readonly eyeToBodyUnits: number | null;
  };

export type ActionFunnelSink = (record: ActionFunnelRecord) => void;

export function nextActionFunnelStage(stage: ActionFunnelStage): ActionFunnelStage | null {
  const index = ACTION_FUNNEL_STAGES.indexOf(stage);
  if (index < 0) throw new TypeError(`unknown action funnel stage: ${String(stage)}`);
  return ACTION_FUNNEL_STAGES[index + 1] ?? null;
}

export function reachedActionFunnelRecord(
  action: ActionFunnelAction,
  target: EntityId,
  stage: ActionFunnelStage,
): ActionFunnelRecord {
  if (!ACTION_FUNNEL_STAGES.includes(stage)) throw new TypeError(`unknown action funnel stage: ${String(stage)}`);
  return Object.freeze({ kind: 'reached', action, target, stage });
}

export function stoppedActionFunnelRecord(input: {
  readonly action: ActionFunnelAction;
  readonly target: EntityId;
  readonly lastPassed: ActionFunnelStage;
  readonly reason: ActionFunnelMissReason;
  readonly eyeToBodyUnits?: number | null;
}): ActionFunnelRecord {
  if (nextActionFunnelStage(input.lastPassed) === null) {
    throw new RangeError('a confirmed effect has no missing transition');
  }
  if (!ACTION_FUNNEL_MISS_REASONS.includes(input.reason)) {
    throw new TypeError(`unknown action funnel miss reason: ${String(input.reason)}`);
  }
  const eyeToBodyUnits = input.eyeToBodyUnits ?? null;
  if (eyeToBodyUnits !== null && (!Number.isSafeInteger(eyeToBodyUnits) || eyeToBodyUnits < 0)) {
    throw new RangeError('eye-to-body evidence must be a nonnegative fixed-point integer');
  }
  return Object.freeze({
    kind: 'stopped',
    action: input.action,
    target: input.target,
    lastPassed: input.lastPassed,
    reason: input.reason,
    eyeToBodyUnits,
  });
}
