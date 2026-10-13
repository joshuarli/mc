import type { BlockPosition, Intent } from '@arena/core';

/** Adds exact bot-owned block arrival without changing core policy or replay intents. */
export type ArenaSkillIntent = Intent | {
  readonly kind: 'navigateToBlock';
  readonly target: BlockPosition;
};
