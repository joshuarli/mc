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
