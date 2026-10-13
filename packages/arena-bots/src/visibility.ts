import type { Bot } from 'mineflayer';

const MAX_ENTITY_RANGE_BLOCKS = 40;
const HALF_HORIZONTAL_FOV_RADIANS = Math.PI / 3;
const HALF_VERTICAL_FOV_RADIANS = Math.PI / 4;

export interface ViewDirection {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly eyeHeight: number;
  readonly yaw: number;
  readonly pitch: number;
}

export interface ViewTarget {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly height: number;
}

/** Applies the arena's fixed range and view-cone limits to client-received positions. */
export function isInsidePerceptionCone(viewer: ViewDirection, target: ViewTarget): boolean {
  if (!isFinitePosition(viewer.position) || !isFinitePosition(target.position)) return false;
  if (!Number.isFinite(viewer.eyeHeight) || !Number.isFinite(viewer.yaw) || !Number.isFinite(viewer.pitch)) return false;
  if (!Number.isFinite(target.height) || target.height <= 0) return false;

  const eyeX = viewer.position.x;
  const eyeY = viewer.position.y + viewer.eyeHeight;
  const eyeZ = viewer.position.z;
  const targetX = target.position.x;
  const targetY = target.position.y + target.height / 2;
  const targetZ = target.position.z;
  const dx = targetX - eyeX;
  const dy = targetY - eyeY;
  const dz = targetZ - eyeZ;
  const horizontalDistance = Math.hypot(dx, dz);
  const distance = Math.hypot(horizontalDistance, dy);
  if (distance > MAX_ENTITY_RANGE_BLOCKS || distance === 0) return false;

  const targetYaw = Math.atan2(-dx, -dz);
  const targetPitch = Math.atan2(-dy, horizontalDistance);
  return Math.abs(shortestAngle(targetYaw - viewer.yaw)) <= HALF_HORIZONTAL_FOV_RADIANS
    && Math.abs(shortestAngle(targetPitch - viewer.pitch)) <= HALF_VERTICAL_FOV_RADIANS;
}

/** Uses Mineflayer's raycast against this bot's loaded voxel world; unloaded blocks fail closed. */
export function hasLocalVoxelLineOfSight(
  bot: Pick<Bot, 'blockAt' | 'canSeeBlock'>,
  position: Parameters<Bot['blockAt']>[0],
): boolean {
  if (!isFinitePosition(position)) return false;
  const blockPosition = position.floored();
  if (!isSafePosition(blockPosition)) return false;
  const block = bot.blockAt(blockPosition);
  return block !== null && Boolean(bot.canSeeBlock(block));
}

function shortestAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function isFinitePosition(position: { readonly x: number; readonly y: number; readonly z: number }): boolean {
  return Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z);
}

function isSafePosition(position: { readonly x: number; readonly y: number; readonly z: number }): boolean {
  return Number.isSafeInteger(position.x) && Number.isSafeInteger(position.y) && Number.isSafeInteger(position.z);
}
