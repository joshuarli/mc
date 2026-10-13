import type {
  CivIntent,
  CivilizationObservation,
  CivilizationPolicyContextInput,
  SkillCancellation,
  SkillOutcome,
} from '@arena/core';
import type { Bot } from 'mineflayer';
import { bindEntityActionStringMapperFeature, bindPlayerCollisionDimensions } from './mineflayer-compat.js';
import {
  MineflayerCivilizationObserver,
  type CivilizationRosterMember,
} from './civilization-observer.js';
import { MineflayerObserver } from './observer.js';
import type { ArenaSkillIntent } from './skill-intent.js';
import { SkillOwner } from './skills.js';

export type { CivilizationRosterMember } from './civilization-observer.js';

export interface CivilizationTeamReportInput {
  readonly authenticatedSenderSeat: number;
  readonly decodedReport: unknown;
  readonly currentTick: number;
}

export interface MineflayerCivilizationClient {
  /** Uses the authoritative shared match tick delivered by the public clock. */
  observe(sharedMatchTick: number): CivilizationObservation;
  receiveTeamReport(input: CivilizationTeamReportInput): void;
  run(intent: ArenaSkillIntent): Promise<SkillOutcome>;
  runCivilization(intent: CivIntent): Promise<SkillOutcome>;
  cancel(reason: SkillCancellation): Promise<void>;
  close(): Promise<void>;
}

export interface MineflayerCivilizationClientOptions {
  readonly context: CivilizationPolicyContextInput;
  readonly publicRoster: readonly CivilizationRosterMember[];
}

/** Connects one Mineflayer client to civilization observation and skills from its received state. */
export function createMineflayerCivilizationClient(
  bot: Bot,
  options: MineflayerCivilizationClientOptions,
): MineflayerCivilizationClient {
  bindPlayerCollisionDimensions(bot);
  bindEntityActionStringMapperFeature(bot);

  const baseObserver = new MineflayerObserver(bot);
  let civilizationObserver: MineflayerCivilizationObserver | null = null;
  try {
    civilizationObserver = new MineflayerCivilizationObserver(bot, options.context, options.publicRoster);
    const skills = new SkillOwner(bot, baseObserver, civilizationObserver);
    return createClient(baseObserver, civilizationObserver, skills);
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    if (civilizationObserver !== null) {
      try {
        civilizationObserver.close();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    try {
      baseObserver.close();
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError([error, ...cleanupFailures], 'civilization client setup and cleanup both failed');
    }
    throw error;
  }
}

function createClient(
  baseObserver: MineflayerObserver,
  civilizationObserver: MineflayerCivilizationObserver,
  skills: SkillOwner,
): MineflayerCivilizationClient {
  let closePromise: Promise<void> | null = null;

  return {
    observe: (sharedMatchTick) => {
      const base = baseObserver.observe(sharedMatchTick);
      return civilizationObserver.observe(sharedMatchTick, base);
    },
    receiveTeamReport: ({ authenticatedSenderSeat, decodedReport, currentTick }) =>
      civilizationObserver.receiveTeamReport(authenticatedSenderSeat, decodedReport, currentTick),
    run: (intent) => skills.run(intent),
    runCivilization: (intent) => skills.runCivilization(intent),
    cancel: (reason) => skills.cancel(reason),
    close: () => {
      closePromise ??= closeOwnedClient(skills, civilizationObserver, baseObserver);
      return closePromise;
    },
  };
}

async function closeOwnedClient(
  skills: SkillOwner,
  civilizationObserver: MineflayerCivilizationObserver,
  baseObserver: MineflayerObserver,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await skills.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    civilizationObserver.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    baseObserver.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'civilization client shutdown cleanup failed');
  }
}
