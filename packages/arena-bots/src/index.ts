import type {
  AgentObservation,
  SkillCancellation,
  SkillOutcome,
} from '@arena/core';
import type { Bot } from 'mineflayer';
import { bindEntityActionStringMapperFeature } from './mineflayer-compat.js';
import { MineflayerObserver } from './observer.js';
import type { ArenaSkillIntent } from './skill-intent.js';
import { SkillOwner } from './skills.js';

export type { ArenaSkillIntent } from './skill-intent.js';

export interface MineflayerArenaClient {
  observe(tick: number): AgentObservation;
  /** Runs a core policy intent or awaits exact arrival for the bot-only block navigation intent. */
  run(intent: ArenaSkillIntent): Promise<SkillOutcome>;
  cancel(reason: SkillCancellation): Promise<void>;
  close(): Promise<void>;
}

/** Connects one Mineflayer client's received state to the arena observation and skill contracts. */
export function createMineflayerArenaClient(bot: Bot): MineflayerArenaClient {
  bindEntityActionStringMapperFeature(bot);
  const observer = new MineflayerObserver(bot);
  let skills: SkillOwner;
  try {
    skills = new SkillOwner(bot, observer);
  } catch (error) {
    observer.close();
    throw error;
  }
  let closePromise: Promise<void> | null = null;

  return {
    observe: (tick) => observer.observe(tick),
    run: (intent) => skills.run(intent),
    cancel: (reason) => skills.cancel(reason),
    close: () => {
      closePromise ??= skills.close().finally(() => observer.close());
      return closePromise;
    },
  };
}
