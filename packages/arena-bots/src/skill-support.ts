import { performance } from 'node:perf_hooks';
import type { ActionFunnelMissReason, SkillCancellation, SkillFailure, SkillOutcome } from '@arena/core';
import type { Bot, BotEvents } from 'mineflayer';

export const ACTION_TIMEOUT_MS = 5_000;

export type MineflayerItem = NonNullable<Bot['inventory']['slots'][number]>;
export type MineflayerWindow = NonNullable<Bot['currentWindow']>;
export type MineflayerChest = Awaited<ReturnType<Bot['openContainer']>>;
export type MineflayerBlock = NonNullable<ReturnType<Bot['blockAt']>>;
export type MineflayerEntity = Bot['entity'];

export interface SkillResources {
  navigationActive: boolean;
  digging: { readonly settlement: Promise<void>; stopRequested: boolean } | null;
  itemUse: 'none' | 'food' | 'bow' | 'shield';
  inventoryTouched: boolean;
  window: MineflayerChest | null;
  quickBarSlotToRestore: number | null;
}

export interface ActiveSkill {
  readonly controller: AbortController;
  readonly resources: SkillResources;
  cancellation: SkillCancellation | null;
  promise: Promise<SkillOutcome>;
}

export class SkillFault extends Error {
  readonly failure: SkillFailure;
  readonly miss: ActionFunnelMissReason | null;

  constructor(cause: SkillFailure, message: string, miss: ActionFunnelMissReason | null = null) {
    super(message);
    this.name = 'SkillFault';
    this.failure = cause;
    this.miss = miss;
  }
}

export class SkillInterrupted extends Error {
  constructor() {
    super('skill was cancelled');
    this.name = 'SkillInterrupted';
  }
}

export function throwIfInterrupted(signal: AbortSignal): void {
  if (signal.aborted) throw new SkillInterrupted();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function distance(first: { readonly x: number; readonly y: number; readonly z: number }, second: { readonly x: number; readonly y: number; readonly z: number }): number {
  return Math.hypot(first.x - second.x, first.y - second.y, first.z - second.z);
}

function isChestWindow(window: MineflayerWindow): window is MineflayerChest {
  return (window.inventoryStart === 27 || window.inventoryStart === 54)
    && typeof (window as MineflayerChest).withdraw === 'function';
}

export function waitForChestWindow(bot: Bot, timeoutMs: number): Promise<MineflayerChest> {
  let finish!: (error?: Error, window?: MineflayerChest) => void;
  return new Promise<MineflayerChest>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new SkillFault('timedOut', 'server did not open the requested chest')), timeoutMs);
    const onOpen: BotEvents['windowOpen'] = (window) => {
      if (!isChestWindow(window)) return;
      finish(undefined, window);
    };
    finish = (error?: Error, window?: MineflayerChest) => {
      clearTimeout(timeout);
      bot.removeListener('windowOpen', onOpen);
      if (error !== undefined) reject(error);
      else if (window !== undefined) resolve(window);
      else reject(new Error('chest window event did not include a window'));
    };
    bot.on('windowOpen', onOpen);
  });
}

export async function waitForCondition(
  bot: Bot,
  condition: () => boolean,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    throwIfInterrupted(signal);
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new SkillFault('timedOut', 'expected client state did not arrive');
    await waitForPhysicsTick(bot, signal, remaining);
  }
}

async function waitForPhysicsTick(bot: Bot, signal: AbortSignal, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new SkillFault('timedOut', 'client did not advance to the next physics tick')), timeoutMs);
    const onAbort = () => finish(new SkillInterrupted());
    const onTick = () => finish();
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      bot.removeListener('physicsTick', onTick);
      signal.removeEventListener('abort', onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    bot.on('physicsTick', onTick);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
