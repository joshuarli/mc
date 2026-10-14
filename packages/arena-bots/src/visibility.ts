import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';

const MAX_ENTITY_RANGE_BLOCKS = 40;
const HALF_HORIZONTAL_FOV_RADIANS = Math.PI / 3;
const HALF_VERTICAL_FOV_RADIANS = Math.PI / 4;
const packageRequire = createRequire(import.meta.url);
const mineflayerRequire = createRequire(packageRequire.resolve('mineflayer'));
// The load check must use the same iterator as the collision raycast.
const { RaycastIterator } = mineflayerRequire('prismarine-world').iterators as {
  readonly RaycastIterator: new (
    position: Parameters<Bot['world']['raycast']>[0],
    direction: Parameters<Bot['world']['raycast']>[1],
    range: number,
  ) => { next(): { readonly x: number; readonly y: number; readonly z: number } | null };
};

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

interface LocalVoxelRayTarget {
  readonly blockPosition: Parameters<Bot['blockAt']>[0];
  readonly rayTarget: Parameters<Bot['blockAt']>[0];
}

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
  const targetPitch = Math.atan2(dy, horizontalDistance);
  return Math.abs(shortestAngle(targetYaw - viewer.yaw)) <= HALF_HORIZONTAL_FOV_RADIANS
    && Math.abs(shortestAngle(targetPitch - viewer.pitch)) <= HALF_VERTICAL_FOV_RADIANS;
}

export function hasLocalVoxelLineOfSight(
  bot: Pick<Bot, 'blockAt' | 'entity' | 'world'>,
  position: Parameters<Bot['blockAt']>[0],
): boolean {
  if (!isFinitePosition(position)) return false;
  const blockPosition = position.floored();
  if (!isSafePosition(blockPosition)) return false;
  return hasLocalVoxelRayToTarget(bot, {
    blockPosition,
    rayTarget: blockPosition.offset(0.5, 0.5, 0.5),
  });
}

export function hasLocalVoxelRayToTarget(
  bot: Pick<Bot, 'blockAt' | 'entity' | 'world'>,
  target: LocalVoxelRayTarget,
): boolean {
  if (!isFinitePosition(target.blockPosition) || !isFinitePosition(target.rayTarget)) return false;
  const targetBlockPosition = target.blockPosition.floored();
  const rayTarget = target.rayTarget;
  const rayTargetBlockPosition = rayTarget.floored();
  if (!isSafePosition(targetBlockPosition) || !isSafePosition(rayTargetBlockPosition)) return false;
  if (bot.blockAt(targetBlockPosition) === null || bot.blockAt(rayTargetBlockPosition) === null) return false;

  const entity = bot.entity as Bot['entity'] & { readonly eyeHeight?: number };
  if (typeof entity.eyeHeight !== 'number' || !Number.isFinite(entity.eyeHeight)) return false;
  if (!isFinitePosition(entity.position)) return false;
  const eyePosition = entity.position.offset(0, entity.eyeHeight, 0);
  if (!isFinitePosition(eyePosition)) return false;

  const rayLength = eyePosition.distanceTo(rayTarget);
  if (!Number.isFinite(rayLength) || rayLength === 0 || rayLength > MAX_ENTITY_RANGE_BLOCKS) return false;
  const rayDirection = rayTarget.minus(eyePosition).scaled(1 / rayLength);
  if (!hasLoadedVoxelRay(bot, eyePosition, rayDirection, rayLength)) return false;

  const collision = bot.world.raycast(eyePosition, rayDirection, rayLength);
  if (collision === null) return true;

  // WorldSync returns the intersected Block at runtime; its declaration exposes only ray coordinates.
  const hitPosition = (collision as unknown as { readonly position: Parameters<Bot['blockAt']>[0] }).position;
  return hitPosition.x === rayTargetBlockPosition.x
    && hitPosition.y === rayTargetBlockPosition.y
    && hitPosition.z === rayTargetBlockPosition.z;
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

function hasLoadedVoxelRay(
  bot: Pick<Bot, 'blockAt'>,
  from: Parameters<Bot['blockAt']>[0],
  direction: Parameters<Bot['world']['raycast']>[1],
  range: number,
): boolean {
  const iterator = new RaycastIterator(from, direction, range);
  let position: { readonly x: number; readonly y: number; readonly z: number } | null = from.floored();
  while (position !== null) {
    if (!isSafePosition(position) || !isLoadedVoxel(bot, from, position.x, position.y, position.z)) return false;
    position = iterator.next();
  }
  return true;
}

function isLoadedVoxel(
  bot: Pick<Bot, 'blockAt'>,
  origin: Parameters<Bot['blockAt']>[0],
  x: number,
  y: number,
  z: number,
): boolean {
  return bot.blockAt(origin.offset(x - origin.x, y - origin.y, z - origin.z)) !== null;
}
