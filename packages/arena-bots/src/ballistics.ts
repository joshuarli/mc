export const ARROW_SPEED_BLOCKS_PER_TICK = 3;
export const ARROW_GRAVITY_BLOCKS_PER_TICK_SQUARED = 0.05;
export const MAX_LEAD_TICKS = 30;
export const MAX_OBSERVED_SPEED_BLOCKS_PER_TICK = 1;

export interface Point3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function observedVelocity(samples: readonly Point3[]): Point3 {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined || samples.length < 2) return { x: 0, y: 0, z: 0 };
  const span = samples.length - 1;
  const x = (last.x - first.x) / span;
  const z = (last.z - first.z) / span;
  const speed = Math.hypot(x, z);
  const scale = speed > MAX_OBSERVED_SPEED_BLOCKS_PER_TICK ? MAX_OBSERVED_SPEED_BLOCKS_PER_TICK / speed : 1;
  return { x: x * scale, y: 0, z: z * scale };
}

export const MELEE_LEAD_TICKS = 1;

export function meleeAimPoint(eye: Point3, feet: Point3, width: number, height: number, velocity: Point3): Point3 {
  const predicted = {
    x: feet.x + velocity.x * MELEE_LEAD_TICKS,
    y: feet.y,
    z: feet.z + velocity.z * MELEE_LEAD_TICKS,
  };
  const half = width / 2;
  const lowX = predicted.x - half;
  const highX = predicted.x + half;
  const lowY = predicted.y;
  const highY = predicted.y + height;
  const lowZ = predicted.z - half;
  const highZ = predicted.z + half;
  const closest = {
    x: clampToSpan(eye.x, lowX, highX),
    y: clampToSpan(eye.y, lowY, highY),
    z: clampToSpan(eye.z, lowZ, highZ),
  };
  if (closest.x === eye.x && closest.y === eye.y && closest.z === eye.z) {
    return { x: predicted.x, y: predicted.y + height * 0.65, z: predicted.z };
  }
  return {
    x: insetFromFace(closest.x, lowX, highX, predicted.x),
    y: insetFromFace(closest.y, lowY, highY, predicted.y + height / 2),
    z: insetFromFace(closest.z, lowZ, highZ, predicted.z),
  };
}

function clampToSpan(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function insetFromFace(value: number, low: number, high: number, center: number): number {
  const span = high - low;
  if (span <= 0) return center;
  const inset = Math.min(1 / 1024, span / 2);
  if (value <= low) return low + inset;
  if (value >= high) return high - inset;
  return value;
}

export function leadAimPoint(eye: Point3, center: Point3, velocity: Point3): { readonly point: Point3; readonly flightTicks: number } {
  let flightTicks = 0;
  let predicted = center;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const distance = Math.hypot(predicted.x - eye.x, predicted.y - eye.y, predicted.z - eye.z);
    flightTicks = Math.min(MAX_LEAD_TICKS, distance / ARROW_SPEED_BLOCKS_PER_TICK);
    predicted = {
      x: center.x + velocity.x * flightTicks,
      y: center.y + velocity.y * flightTicks,
      z: center.z + velocity.z * flightTicks,
    };
  }
  const drop = 0.5 * ARROW_GRAVITY_BLOCKS_PER_TICK_SQUARED * flightTicks * flightTicks;
  return { point: { x: predicted.x, y: predicted.y + drop, z: predicted.z }, flightTicks };
}
