import { blockPosition, type BlockPosition } from '@arena/core';
import type { Bot } from 'mineflayer';
import {
  hasLocalVoxelLineOfSight,
  hasLocalVoxelRayToTarget,
  isInsidePerceptionCone,
  type ViewDirection,
} from './visibility.js';

type MineflayerEntity = Bot['entity'];

/** Uses this connection's current aim and loaded voxel raycast for entity visibility. */
export function isVisibleEntity(bot: Bot, entity: Pick<MineflayerEntity, 'position' | 'height'>): boolean {
  return isVisiblePosition(bot, entity.position, entity.height);
}

export function isVisiblePosition(
  bot: Bot,
  position: Pick<MineflayerEntity, 'position'>['position'],
  height: number,
): boolean {
  const viewer = viewDirection(bot);
  return isInsidePerceptionCone(viewer, { position, height })
    && hasLocalVoxelRayToTarget(bot, {
      blockPosition: position,
      rayTarget: position.offset(0, height / 2, 0),
    });
}

export function isTargetablePlayer(bot: Bot, entity: MineflayerEntity): boolean {
  if (entity.type !== 'player') return false;
  const player = Object.values(bot.players).find((candidate) => candidate.entity === entity);
  return player !== undefined && (player.gamemode === 0 || player.gamemode === 2);
}

export function toBlockPosition(position: { floored(): { readonly x: number; readonly y: number; readonly z: number } }): BlockPosition {
  const floored = position.floored();
  return blockPosition(floored.x, floored.y, floored.z);
}

function viewDirection(bot: Bot): ViewDirection {
  const entity = bot.entity as Bot['entity'] & { readonly eyeHeight?: number };
  if (typeof entity.eyeHeight !== 'number' || !Number.isFinite(entity.eyeHeight)) {
    throw new Error('Mineflayer player entity has no finite eye height');
  }
  return {
    position: entity.position,
    eyeHeight: entity.eyeHeight,
    yaw: entity.yaw,
    pitch: entity.pitch,
  };
}
