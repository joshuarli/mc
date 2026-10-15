import type { FrontierTask } from '@arena/core';
import { RunnerError } from '../errors.js';
import type { SeatPolicyState } from '../runtime/live-policy-loop.js';

export function restoredPolicyState(botState: unknown): ReadonlyMap<number, SeatPolicyState> {
  const states = new Map<number, SeatPolicyState>();
  const value = object(botState);
  if (value === undefined || !hasExactObjectFields(value, ['schema', 'seats'])
      || (value.schema !== 1 && value.schema !== 2) || !Array.isArray(value.seats)) invalidState();
  const seen = new Set<number>();
  for (const item of value.seats) {
    const entry = object(item);
    const fields = value.schema === 1 ? ['seat', 'memory', 'rng_state', 'opening_state']
      : ['seat', 'memory', 'rng_state', 'opening_state', 'frontier_task'];
    if (entry === undefined || !hasExactObjectFields(entry, fields)
        || !Number.isSafeInteger(entry.seat) || (entry.seat as number) < 0 || (entry.seat as number) > 255
        || seen.has(entry.seat as number) || typeof entry.rng_state !== 'string'
        || !/^[0-9]{1,20}$/.test(entry.rng_state)
        || (entry.opening_state !== null && object(entry.opening_state) === undefined)) invalidState();
    const seat = entry.seat as number;
    seen.add(seat);
    states.set(seat, Object.freeze({
      memory: entry.memory,
      rng_state: entry.rng_state,
      opening_state: entry.opening_state as SeatPolicyState['opening_state'],
      ...(value.schema === 2 ? { frontier_task: frontierTask(entry.frontier_task) } : {}),
    }));
  }
  return states;
}

function frontierTask(value: unknown): FrontierTask | null {
  if (value === null) return null;
  const task = object(value);
  const taskFields = ['goal', 'mode', 'startedAtTick', 'commitUntilTick', 'attempt', 'fingerprint', 'cooldowns'];
  if (task === undefined || !hasExactObjectFields(task, taskFields)
      || !['escapeBorder', 'heal', 'loot', 'engage', 'explore'].includes(String(task.goal))
      || !Number.isSafeInteger(task.startedAtTick) || !Number.isSafeInteger(task.commitUntilTick)
      || !Number.isSafeInteger(task.attempt) || typeof task.fingerprint !== 'string' || !Array.isArray(task.cooldowns)) {
    invalidState();
  }
  const mode = object(task.mode);
  if (mode === undefined || typeof mode.kind !== 'string') invalidState();
  const modeFields: Readonly<Record<string, readonly string[]>> = {
    escaping: ['kind'],
    healing: ['kind', 'inventorySlot'],
    looting: ['kind', 'target'],
    engaging: ['kind', 'target', 'side'],
    exploring: ['kind', 'target'],
  };
  const goals: Readonly<Record<string, string>> = {
    escaping: 'escapeBorder', healing: 'heal', looting: 'loot', engaging: 'engage', exploring: 'explore',
  };
  if (modeFields[mode.kind] === undefined || !hasExactObjectFields(mode, modeFields[mode.kind]!)
      || task.goal !== goals[mode.kind]) invalidState();
  if (mode.kind === 'healing' && (!Number.isSafeInteger(mode.inventorySlot) || (mode.inventorySlot as number) < 0)) invalidState();
  if (mode.kind === 'engaging' && (!Number.isSafeInteger(mode.target) || (mode.target as number) <= 0
      || (mode.side !== 'press' && mode.side !== 'evade'))) invalidState();
  if (mode.kind === 'looting' && !validLootTarget(mode.target)) invalidState();
  if (mode.kind === 'exploring' && !validPosition(mode.target)) invalidState();
  if (task.cooldowns.some((entry: unknown) => {
    const cooldown = object(entry);
    return cooldown === undefined || !hasExactObjectFields(cooldown, ['goal', 'key', 'untilTick'])
      || !['escapeBorder', 'heal', 'loot', 'engage', 'explore'].includes(String(cooldown.goal))
      || typeof cooldown.key !== 'string' || !Number.isSafeInteger(cooldown.untilTick);
  })) invalidState();
  return value as FrontierTask;
}

function validLootTarget(value: unknown): boolean {
  const target = object(value);
  if (target === undefined || typeof target.kind !== 'string') return false;
  if (target.kind === 'drop') {
    return hasExactObjectFields(target, ['kind', 'entityId'])
      && Number.isSafeInteger(target.entityId) && (target.entityId as number) > 0;
  }
  if (target.kind === 'container') {
    return hasExactObjectFields(target, ['kind', 'position']) && validPosition(target.position);
  }
  return false;
}

function validPosition(value: unknown): boolean {
  const position = object(value);
  return position !== undefined && hasExactObjectFields(position, ['x', 'y', 'z'])
    && Number.isSafeInteger(position.x) && Number.isSafeInteger(position.y) && Number.isSafeInteger(position.z);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function hasExactObjectFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function invalidState(): never {
  throw new RunnerError('corrupt_evidence', 'checkpoint', { kind: 'invalid_bot_state' });
}
