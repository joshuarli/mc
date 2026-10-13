export interface BlockPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export class InvalidBlockPositionError extends RangeError {
  constructor(readonly axis: 'x' | 'y' | 'z', readonly value: number) {
    super(`block position ${axis} must be a safe integer, received ${value}`);
    this.name = 'InvalidBlockPositionError';
  }
}

export class InvalidBlockOffsetError extends RangeError {
  constructor(readonly axis: 'x' | 'y' | 'z', readonly value: number) {
    super(`block offset ${axis} must be a safe integer, received ${value}`);
    this.name = 'InvalidBlockOffsetError';
  }
}

export function blockPosition(x: number, y: number, z: number): BlockPosition {
  assertCoordinate('x', x);
  assertCoordinate('y', y);
  assertCoordinate('z', z);
  return Object.freeze({ x, y, z });
}

export type CheckedPositionOffset =
  | { readonly ok: true; readonly value: BlockPosition }
  | { readonly ok: false; readonly error: 'coordinate-overflow' };

export function offsetBlockPosition(
  position: BlockPosition,
  dx: number,
  dy: number,
  dz: number,
): CheckedPositionOffset {
  assertPosition(position);
  assertOffset('x', dx);
  assertOffset('y', dy);
  assertOffset('z', dz);

  const x = position.x + dx;
  const y = position.y + dy;
  const z = position.z + dz;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !Number.isSafeInteger(z)) {
    return { ok: false, error: 'coordinate-overflow' };
  }

  return { ok: true, value: blockPosition(x, y, z) };
}

export function squaredDistance(first: BlockPosition, second: BlockPosition): bigint {
  assertPosition(first);
  assertPosition(second);
  const dx = BigInt(first.x) - BigInt(second.x);
  const dy = BigInt(first.y) - BigInt(second.y);
  const dz = BigInt(first.z) - BigInt(second.z);
  return dx * dx + dy * dy + dz * dz;
}

export function manhattanDistance(first: BlockPosition, second: BlockPosition): bigint {
  assertPosition(first);
  assertPosition(second);
  return absoluteDifference(first.x, second.x)
    + absoluteDifference(first.y, second.y)
    + absoluteDifference(first.z, second.z);
}

export interface WorldBorder {
  readonly centerX: number;
  readonly centerZ: number;
  readonly radiusBlocks: number;
}

export class InvalidWorldBorderError extends RangeError {
  constructor(readonly field: 'centerX' | 'centerZ' | 'radiusBlocks', readonly value: number) {
    super(`world border ${field} is invalid: ${value}`);
    this.name = 'InvalidWorldBorderError';
  }
}

export function worldBorder(centerX: number, centerZ: number, radiusBlocks: number): WorldBorder {
  if (!Number.isSafeInteger(centerX)) {
    throw new InvalidWorldBorderError('centerX', centerX);
  }
  if (!Number.isSafeInteger(centerZ)) {
    throw new InvalidWorldBorderError('centerZ', centerZ);
  }
  if (!Number.isSafeInteger(radiusBlocks) || radiusBlocks <= 0) {
    throw new InvalidWorldBorderError('radiusBlocks', radiusBlocks);
  }
  return Object.freeze({ centerX, centerZ, radiusBlocks });
}

export function borderCenter(border: WorldBorder, y: number): BlockPosition {
  assertWorldBorder(border);
  return blockPosition(border.centerX, y, border.centerZ);
}

export function isOutsideBorder(border: WorldBorder, position: BlockPosition): boolean {
  assertWorldBorder(border);
  assertPosition(position);
  const dx = BigInt(position.x) - BigInt(border.centerX);
  const dz = BigInt(position.z) - BigInt(border.centerZ);
  const radius = BigInt(border.radiusBlocks);
  return dx * dx + dz * dz > radius * radius;
}

export function isNearOrOutsideBorder(
  border: WorldBorder,
  position: BlockPosition,
  marginBlocks: number,
): boolean {
  assertWorldBorder(border);
  assertPosition(position);
  if (!Number.isSafeInteger(marginBlocks) || marginBlocks < 0) {
    throw new RangeError(`border margin must be a nonnegative safe integer, received ${marginBlocks}`);
  }
  if (isOutsideBorder(border, position)) {
    return true;
  }

  const safeRadius = Math.max(0, border.radiusBlocks - Math.min(marginBlocks, border.radiusBlocks));
  const dx = BigInt(position.x) - BigInt(border.centerX);
  const dz = BigInt(position.z) - BigInt(border.centerZ);
  const radius = BigInt(safeRadius);
  return dx * dx + dz * dz >= radius * radius;
}

export function compareBlockPositions(first: BlockPosition, second: BlockPosition): number {
  assertPosition(first);
  assertPosition(second);
  return first.x - second.x || first.y - second.y || first.z - second.z;
}

function assertCoordinate(axis: 'x' | 'y' | 'z', value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new InvalidBlockPositionError(axis, value);
  }
}

function assertPosition(position: BlockPosition): void {
  assertCoordinate('x', position.x);
  assertCoordinate('y', position.y);
  assertCoordinate('z', position.z);
}

function assertOffset(axis: 'x' | 'y' | 'z', value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new InvalidBlockOffsetError(axis, value);
  }
}

function assertWorldBorder(border: WorldBorder): void {
  if (!Number.isSafeInteger(border.centerX)) {
    throw new InvalidWorldBorderError('centerX', border.centerX);
  }
  if (!Number.isSafeInteger(border.centerZ)) {
    throw new InvalidWorldBorderError('centerZ', border.centerZ);
  }
  if (!Number.isSafeInteger(border.radiusBlocks) || border.radiusBlocks <= 0) {
    throw new InvalidWorldBorderError('radiusBlocks', border.radiusBlocks);
  }
}

function absoluteDifference(first: number, second: number): bigint {
  const difference = BigInt(first) - BigInt(second);
  return difference < 0n ? -difference : difference;
}
