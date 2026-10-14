declare const fixedBlocksBrand: unique symbol;
declare const fixedAngleBrand: unique symbol;

export const FIXED_UNITS_PER_BLOCK = 1024;
export const MELEE_REACH_BLOCKS = 3;

const MAX_COORDINATE_BLOCKS = 30_000_000;
const MAX_EXTENT_BLOCKS = 64;
const MAX_VELOCITY_BLOCKS_PER_TICK = 128;
const MAX_ANGLE_RADIANS = 1024;

export type FixedBlocks = number & { readonly [fixedBlocksBrand]: 'FixedBlocks' };
export type FixedAngle = number & { readonly [fixedAngleBrand]: 'FixedAngle' };

export interface FixedVector {
  readonly x: FixedBlocks;
  readonly y: FixedBlocks;
  readonly z: FixedBlocks;
}

export interface CombatBody {
  readonly position: FixedVector;
  readonly velocity: FixedVector;
  readonly yaw: FixedAngle;
  readonly pitch: FixedAngle;
  readonly width: FixedBlocks;
  readonly height: FixedBlocks;
}

export interface CombatSelfBody extends CombatBody {
  readonly eyeHeight: FixedBlocks;
}

export interface VectorMeasurement {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface CombatBodyMeasurement {
  readonly position: VectorMeasurement;
  readonly velocity: VectorMeasurement;
  readonly yaw: number;
  readonly pitch: number;
  readonly width: number;
  readonly height: number;
}

export interface CombatSelfBodyMeasurement extends CombatBodyMeasurement {
  readonly eyeHeight: number;
}

function fixedBlocksFromMeasurement(
  value: number,
  limitBlocks: number,
  label: string,
  rounding: (scaled: number) => number = Math.round,
): FixedBlocks {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite, received ${value}`);
  }
  if (Math.abs(value) > limitBlocks) {
    throw new RangeError(`${label} must be within ${limitBlocks} blocks, received ${value}`);
  }
  return (rounding(value * FIXED_UNITS_PER_BLOCK) + 0) as FixedBlocks;
}

function fixedBlocksFromUnits(units: number, limitBlocks: number, label: string): FixedBlocks {
  if (!Number.isSafeInteger(units) || Math.abs(units) > limitBlocks * FIXED_UNITS_PER_BLOCK) {
    throw new RangeError(`${label} must be a fixed-point integer within ${limitBlocks} blocks, received ${units}`);
  }
  return units as FixedBlocks;
}

function fixedAngleFromMeasurement(value: number, label: string): FixedAngle {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_ANGLE_RADIANS) {
    throw new RangeError(`${label} must be a finite angle, received ${value}`);
  }
  return (Math.round(value * FIXED_UNITS_PER_BLOCK) + 0) as FixedAngle;
}

function fixedAngleFromUnits(units: number, label: string): FixedAngle {
  if (!Number.isSafeInteger(units) || Math.abs(units) > MAX_ANGLE_RADIANS * FIXED_UNITS_PER_BLOCK) {
    throw new RangeError(`${label} must be a fixed-point angle, received ${units}`);
  }
  return units as FixedAngle;
}

function vectorFromMeasurement(
  value: VectorMeasurement,
  limitBlocks: number,
  label: string,
  rounding: (scaled: number) => number = Math.round,
): FixedVector {
  return Object.freeze({
    x: fixedBlocksFromMeasurement(value.x, limitBlocks, `${label}.x`, rounding),
    y: fixedBlocksFromMeasurement(value.y, limitBlocks, `${label}.y`, rounding),
    z: fixedBlocksFromMeasurement(value.z, limitBlocks, `${label}.z`, rounding),
  });
}

function vectorFromUnits(value: FixedVector, limitBlocks: number, label: string): FixedVector {
  return Object.freeze({
    x: fixedBlocksFromUnits(value.x, limitBlocks, `${label}.x`),
    y: fixedBlocksFromUnits(value.y, limitBlocks, `${label}.y`),
    z: fixedBlocksFromUnits(value.z, limitBlocks, `${label}.z`),
  });
}

function positiveExtent(units: FixedBlocks, label: string): FixedBlocks {
  if (units <= 0) throw new RangeError(`${label} must be positive`);
  return units;
}

export function combatBody(measurement: CombatBodyMeasurement): CombatBody {
  return Object.freeze({
    position: vectorFromMeasurement(measurement.position, MAX_COORDINATE_BLOCKS, 'position', Math.floor),
    velocity: vectorFromMeasurement(measurement.velocity, MAX_VELOCITY_BLOCKS_PER_TICK, 'velocity'),
    yaw: fixedAngleFromMeasurement(measurement.yaw, 'yaw'),
    pitch: fixedAngleFromMeasurement(measurement.pitch, 'pitch'),
    width: positiveExtent(fixedBlocksFromMeasurement(measurement.width, MAX_EXTENT_BLOCKS, 'width'), 'width'),
    height: positiveExtent(fixedBlocksFromMeasurement(measurement.height, MAX_EXTENT_BLOCKS, 'height'), 'height'),
  });
}

export function combatSelfBody(measurement: CombatSelfBodyMeasurement): CombatSelfBody {
  const body = combatBody(measurement);
  return Object.freeze({
    ...body,
    eyeHeight: positiveExtent(fixedBlocksFromMeasurement(measurement.eyeHeight, MAX_EXTENT_BLOCKS, 'eyeHeight'), 'eyeHeight'),
  });
}

export function cloneCombatBody(value: CombatBody): CombatBody {
  assertExactFields(value, ['position', 'velocity', 'yaw', 'pitch', 'width', 'height'], 'combat body');
  return Object.freeze({
    position: vectorFromUnits(value.position, MAX_COORDINATE_BLOCKS, 'position'),
    velocity: vectorFromUnits(value.velocity, MAX_VELOCITY_BLOCKS_PER_TICK, 'velocity'),
    yaw: fixedAngleFromUnits(value.yaw, 'yaw'),
    pitch: fixedAngleFromUnits(value.pitch, 'pitch'),
    width: positiveExtent(fixedBlocksFromUnits(value.width, MAX_EXTENT_BLOCKS, 'width'), 'width'),
    height: positiveExtent(fixedBlocksFromUnits(value.height, MAX_EXTENT_BLOCKS, 'height'), 'height'),
  });
}

export function cloneCombatSelfBody(value: CombatSelfBody): CombatSelfBody {
  assertExactFields(value, ['position', 'velocity', 'yaw', 'pitch', 'width', 'height', 'eyeHeight'], 'combat self body');
  const { eyeHeight, ...body } = value;
  return Object.freeze({
    ...cloneCombatBody(body),
    eyeHeight: positiveExtent(fixedBlocksFromUnits(eyeHeight, MAX_EXTENT_BLOCKS, 'eyeHeight'), 'eyeHeight'),
  });
}

export function combatBodyBlock(body: CombatBody): { readonly x: number; readonly y: number; readonly z: number } {
  return Object.freeze({
    x: Math.floor(body.position.x / FIXED_UNITS_PER_BLOCK),
    y: Math.floor(body.position.y / FIXED_UNITS_PER_BLOCK),
    z: Math.floor(body.position.z / FIXED_UNITS_PER_BLOCK),
  });
}

const MELEE_REACH_DOUBLED_UNITS = BigInt(MELEE_REACH_BLOCKS * FIXED_UNITS_PER_BLOCK * 2);

function axisGapDoubled(point: number, boxCenter: number, boxExtent: number): bigint {
  const doubledPoint = BigInt(point) * 2n;
  const low = BigInt(boxCenter) * 2n - BigInt(boxExtent);
  const high = BigInt(boxCenter) * 2n + BigInt(boxExtent);
  if (doubledPoint < low) return low - doubledPoint;
  if (doubledPoint > high) return doubledPoint - high;
  return 0n;
}

export function eyeToBodySquaredDoubledUnits(attacker: CombatSelfBody, target: CombatBody): bigint {
  const eyeY = attacker.position.y + attacker.eyeHeight;
  const dx = axisGapDoubled(attacker.position.x, target.position.x, target.width);
  const dz = axisGapDoubled(attacker.position.z, target.position.z, target.width);
  const lowY = BigInt(target.position.y) * 2n;
  const highY = (BigInt(target.position.y) + BigInt(target.height)) * 2n;
  const doubledEyeY = BigInt(eyeY) * 2n;
  const dy = doubledEyeY < lowY ? lowY - doubledEyeY : doubledEyeY > highY ? doubledEyeY - highY : 0n;
  return dx * dx + dy * dy + dz * dz;
}

export function eyeToBodyDistance(attacker: CombatSelfBody, target: CombatBody): FixedBlocks {
  const squared = eyeToBodySquaredDoubledUnits(attacker, target);
  let root = BigInt(Math.floor(Math.sqrt(Number(squared))));
  while (root * root > squared) root -= 1n;
  while ((root + 1n) * (root + 1n) <= squared) root += 1n;
  return Math.ceil(Number(root) / 2) as FixedBlocks;
}

export function isWithinMeleeReach(attacker: CombatSelfBody, target: CombatBody): boolean {
  return eyeToBodySquaredDoubledUnits(attacker, target) <= MELEE_REACH_DOUBLED_UNITS * MELEE_REACH_DOUBLED_UNITS;
}

export function isCrosshairOnBody(attacker: CombatSelfBody, target: CombatBody): boolean {
  const scale = FIXED_UNITS_PER_BLOCK;
  const yaw = attacker.yaw / scale;
  const pitch = attacker.pitch / scale;
  const direction = [
    -Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
  ] as const;
  const origin = [
    attacker.position.x / scale,
    (attacker.position.y + attacker.eyeHeight) / scale,
    attacker.position.z / scale,
  ] as const;
  const halfWidth = target.width / scale / 2;
  const low = [
    target.position.x / scale - halfWidth,
    target.position.y / scale,
    target.position.z / scale - halfWidth,
  ] as const;
  const high = [
    target.position.x / scale + halfWidth,
    (target.position.y + target.height) / scale,
    target.position.z / scale + halfWidth,
  ] as const;
  let near = 0;
  let far = Number.POSITIVE_INFINITY;
  for (let axis = 0; axis < 3; axis += 1) {
    const delta = direction[axis]!;
    const start = origin[axis]!;
    if (Math.abs(delta) < 1e-12) {
      if (start < low[axis]! || start > high[axis]!) return false;
      continue;
    }
    const first = (low[axis]! - start) / delta;
    const second = (high[axis]! - start) / delta;
    near = Math.max(near, Math.min(first, second));
    far = Math.min(far, Math.max(first, second));
    if (near > far) return false;
  }
  return near <= MELEE_REACH_BLOCKS;
}

export function feetSquaredDistanceUnits(first: CombatBody, second: CombatBody): bigint {
  const dx = BigInt(first.position.x) - BigInt(second.position.x);
  const dy = BigInt(first.position.y) - BigInt(second.position.y);
  const dz = BigInt(first.position.z) - BigInt(second.position.z);
  return dx * dx + dy * dy + dz * dz;
}

function assertExactFields(value: object, fields: readonly string[], label: string): void {
  if (value === null || typeof value !== 'object') throw new TypeError(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw new TypeError(`${label} contains unknown field ${key}`);
  }
  for (const key of fields) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label} is missing required field ${key}`);
  }
}
