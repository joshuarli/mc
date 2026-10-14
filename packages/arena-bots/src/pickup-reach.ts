import { createRequire } from 'node:module';

const { goals } = createRequire(import.meta.url)('mineflayer-pathfinder') as typeof import('mineflayer-pathfinder');

export const PICKUP_REACH_HORIZONTAL_BLOCKS = 1.2;
export const PICKUP_REACH_VERTICAL_BLOCKS = 1;

type Point = Readonly<{ x: number; y: number; z: number }>;

export function withinPickupReach(player: Point, drop: Point): boolean {
  return Math.abs(player.x - drop.x) <= PICKUP_REACH_HORIZONTAL_BLOCKS
    && Math.abs(player.z - drop.z) <= PICKUP_REACH_HORIZONTAL_BLOCKS
    && Math.abs(player.y - drop.y) <= PICKUP_REACH_VERTICAL_BLOCKS;
}

export class PickupReachGoal extends goals.Goal {
  readonly x: number;
  readonly y: number;
  readonly z: number;

  constructor(drop: Point) {
    super();
    this.x = drop.x;
    this.y = drop.y;
    this.z = drop.z;
  }

  heuristic(node: Point): number {
    const dx = Math.max(0, Math.abs(this.x - (node.x + 0.5)) - PICKUP_REACH_HORIZONTAL_BLOCKS);
    const dz = Math.max(0, Math.abs(this.z - (node.z + 0.5)) - PICKUP_REACH_HORIZONTAL_BLOCKS);
    const dy = Math.max(0, Math.abs(this.y - node.y) - PICKUP_REACH_VERTICAL_BLOCKS);
    return Math.hypot(dx, dz) + dy;
  }

  isEnd(node: Point): boolean {
    return withinPickupReach({ x: node.x + 0.5, y: node.y, z: node.z + 0.5 }, this);
  }
}
