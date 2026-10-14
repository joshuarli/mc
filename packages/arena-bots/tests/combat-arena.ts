import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import {
  decide,
  DeterministicRandom,
  emptyPolicyMemory,
  PolicyParams,
  RandomStream,
  seatId,
  type ActionFunnelRecord,
  type ClientDiagnosticRecord,
  type AgentObservation,
  type Decision,
  type PolicyFeedbackBatch,
  type PolicyMemory,
  type SkillOutcome,
} from '@arena/core';
import type { Bot } from 'mineflayer';
import { createMineflayerArenaClient, type MineflayerArenaClient } from '../src/index.js';

const require = createRequire(import.meta.url);
const pinned = createRequire(require.resolve('mineflayer'));
const registry = pinned('prismarine-registry')('26.1.2') as Bot['registry'];
const Chunk = pinned('prismarine-chunk')(registry) as new (options: { minY: number; worldHeight: number }) => NonNullable<ReturnType<Bot['world']['getColumn']>>;
const World = pinned('prismarine-world')(registry) as new (generator: null) => { sync: Bot['world'] };
export const Vec3 = pinned('vec3').Vec3 as new (x: number, y: number, z: number) => Bot['entity']['position'];
const injectBlocks = pinned('mineflayer/lib/plugins/blocks') as (bot: Bot, options: { version: string; hideErrors: boolean }) => void;

const SERVER_REACH_BLOCKS = 3;
const SERVER_ATTACK_COOLDOWN_TICKS = 12;
const PLAYER_WIDTH = 0.6;
const PLAYER_HEIGHT = 1.8;
const PLAYER_EYE_HEIGHT = 1.62;
const MAX_PUMPED_TICKS = 600;

export interface ArenaPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ArenaOpponent extends ArenaPoint {
  readonly id: number;
  readonly yaw?: number;
}

export interface CombatArenaOptions {
  readonly self: ArenaPoint & { readonly yaw?: number };
  readonly opponents: readonly ArenaOpponent[];
  readonly health?: number;
  readonly border?: { readonly x: number; readonly z: number; readonly diameter: number };
}

export interface AttackRecord {
  readonly tick: number;
  readonly targetId: number;
  readonly withinServerReach: boolean;
  readonly damaged: boolean;
}

export interface SettledRun {
  readonly outcome: SkillOutcome;
  readonly ticks: number;
}

export interface CombatArena {
  readonly bot: Bot;
  readonly client: MineflayerArenaClient;
  readonly attacks: AttackRecord[];
  readonly goals: ArenaPoint[];
  readonly funnel: ActionFunnelRecord[];
  readonly diagnostics: ClientDiagnosticRecord[];
  readonly self: { x: number; y: number; z: number; yaw: number; pitch: number };
  readonly opponents: Map<number, { x: number; y: number; z: number; health: number; entity: Bot['entity'] }>;
  tickCount(): number;
  tick(): void;
  observe(): AgentObservation;
  decide(memory?: PolicyMemory, feedback?: PolicyFeedbackBatch): Decision;
  runIntent(intent: Parameters<MineflayerArenaClient['run']>[0], onTick?: (tick: number) => void): Promise<SettledRun>;
  placeSolid(x: number, y: number, z: number): void;
  removeOpponent(id: number): void;
  setOpponent(id: number, point: ArenaPoint): void;
  close(): Promise<void>;
}

export function createCombatArena(options: CombatArenaOptions): CombatArena {
  const world = new World(null).sync;
  const self = {
    x: options.self.x,
    y: options.self.y,
    z: options.self.z,
    yaw: options.self.yaw ?? 0,
    pitch: 0,
  };
  const entities: Record<string, Bot['entity']> = {};
  const players: Record<string, { entity: Bot['entity']; gamemode: number }> = {};
  const opponents = new Map<number, { x: number; y: number; z: number; health: number; entity: Bot['entity'] }>();
  const attacks: AttackRecord[] = [];
  const goals: ArenaPoint[] = [];
  const funnel: ActionFunnelRecord[] = [];
  const diagnostics: ClientDiagnosticRecord[] = [];
  let ticks = 0;
  let lastDamageTick = -1_000;
  let moving = false;

  const entity = {
    id: 1,
    type: 'player',
    position: new Vec3(self.x, self.y, self.z),
    velocity: new Vec3(0, 0, 0),
    eyeHeight: PLAYER_EYE_HEIGHT,
    height: PLAYER_HEIGHT,
    width: PLAYER_WIDTH,
    yaw: self.yaw,
    pitch: 0,
    getDroppedItem: () => null,
  } as unknown as Bot['entity'];

  const pathfinder = {
    goal: null as unknown,
    thinkTimeout: 0,
    tickTimeout: 0,
    searchRadius: -1,
    setMovements: (_movements: unknown) => undefined,
    setGoal: (goal: unknown) => {
      pathfinder.goal = goal;
      if (goal === null) return;
      const target = goal as { x: number; y: number; z: number; rangeSq?: number };
      goals.push({ x: target.x, y: target.y, z: target.z });
      moving = true;
      queueMicrotask(() => {
        if (pathfinder.goal !== goal) return;
        const range = Math.sqrt(target.rangeSq ?? 0);
        const dx = self.x - (target.x + 0.5);
        const dz = self.z - (target.z + 0.5);
        const length = Math.hypot(dx, dz);
        const standoff = Math.max(0, range - 0.75);
        if (length > standoff) {
          self.x = target.x + 0.5 + (dx / length) * standoff;
          self.z = target.z + 0.5 + (dz / length) * standoff;
          self.y = target.y;
          syncSelf();
        }
        moving = false;
        bot.emit('goal_reached', goal);
      });
    },
    isMoving: () => moving,
    stop: () => {
      moving = false;
      pathfinder.goal = null;
      bot.emit('path_stop');
    },
  };

  const slots = new Array(46).fill(null);
  const bot = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(),
    registry,
    version: '26.1.2',
    supportFeature: registry.supportFeature.bind(registry),
    game: { minY: 0, height: 16 },
    world,
    entity,
    entities,
    players,
    health: options.health ?? 20,
    food: 20,
    heldItem: null,
    quickBarSlot: 0,
    currentWindow: null,
    usingHeldItem: false,
    controlState: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false },
    pathfinder,
    inventory: {
      slots,
      selectedItem: null,
      inventoryStart: 9,
      inventoryEnd: 45,
      items: () => [],
      firstEmptySlotRange: () => null,
    },
    getEquipmentDestSlot: () => 5,
    hasPlugin: () => true,
    loadPlugin: () => undefined,
    clearControlStates: () => undefined,
    setControlState: () => undefined,
    setQuickBarSlot: () => undefined,
    deactivateItem: () => undefined,
    look: async () => undefined,
    lookAt: async (point: ArenaPoint) => {
      const dx = point.x - self.x;
      const dy = point.y - (self.y + PLAYER_EYE_HEIGHT);
      const dz = point.z - self.z;
      self.yaw = Math.atan2(-dx, -dz);
      self.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      syncSelf();
    },
    attack: (target: Bot['entity']) => {
      const record = opponents.get(target.id);
      if (record === undefined) {
        attacks.push({ tick: ticks, targetId: target.id, withinServerReach: false, damaged: false });
        return;
      }
      const withinServerReach = serverEyeToBoxDistance(self, record) <= SERVER_REACH_BLOCKS;
      const ready = ticks - lastDamageTick >= SERVER_ATTACK_COOLDOWN_TICKS;
      const damaged = withinServerReach && ready;
      attacks.push({ tick: ticks, targetId: target.id, withinServerReach, damaged });
      if (damaged) {
        lastDamageTick = ticks;
        record.health -= 1;
        bot.emit('entityHurt', target, entity);
      }
    },
  }) as unknown as Bot;
  injectBlocks(bot, { version: bot.version, hideErrors: false });
  for (let x = -4; x <= 3; x += 1) {
    for (let z = -4; z <= 3; z += 1) {
      world.setColumn(x, z, new Chunk({ minY: 0, worldHeight: 16 }));
    }
  }

  function syncSelf(): void {
    entity.position.set(self.x, self.y, self.z);
    entity.yaw = self.yaw;
    entity.pitch = self.pitch;
  }

  function addOpponent(spec: ArenaOpponent): void {
    const opponent = Object.assign(new EventEmitter(), {
      id: spec.id,
      type: 'player',
      position: new Vec3(spec.x, spec.y, spec.z),
      velocity: new Vec3(0, 0, 0),
      height: PLAYER_HEIGHT,
      width: PLAYER_WIDTH,
      yaw: spec.yaw ?? 0,
      pitch: 0,
      getDroppedItem: () => null,
    }) as unknown as Bot['entity'];
    entities[String(spec.id)] = opponent;
    players[`Rival${spec.id}`] = { entity: opponent, gamemode: 0 };
    opponents.set(spec.id, { x: spec.x, y: spec.y, z: spec.z, health: 20, entity: opponent });
  }
  for (const spec of options.opponents) addOpponent(spec);
  syncSelf();

  const client = createMineflayerArenaClient(bot, { funnel: (record) => funnel.push(record), diagnostic: (record) => diagnostics.push(record) });
  bot.emit('spawn');
  bot.emit('health');
  bot._client.emit('window_items', { windowId: 0 });
  const border = options.border ?? { x: 0, z: 0, diameter: 400 };
  bot._client.emit('initialize_world_border', {
    x: border.x,
    z: border.z,
    oldDiameter: border.diameter,
    newDiameter: border.diameter,
    speed: 0,
  });

  const random = DeterministicRandom.forStream(1n, RandomStream.search(seatId(0)));
  const params = PolicyParams.baseline();
  let observationTick = 0;

  const arena: CombatArena = {
    bot,
    client,
    attacks,
    goals,
    funnel,
    diagnostics,
    self,
    opponents,
    tickCount: () => ticks,
    tick: () => {
      ticks += 1;
      bot.emit('physicsTick');
    },
    observe: () => {
      observationTick += 1;
      return client.observe(observationTick);
    },
    decide: (memory = emptyPolicyMemory(), feedback = []) => decide(arena.observe(), memory, params, random, feedback),
    runIntent: async (intent, onTick) => {
      let settled = false;
      const running = client.run(intent).then((outcome) => {
        settled = true;
        return outcome;
      });
      const startedAt = ticks;
      while (!settled) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (settled) break;
        if (ticks - startedAt >= MAX_PUMPED_TICKS) throw new Error('skill did not settle within the pumped tick budget');
        onTick?.(ticks);
        arena.tick();
      }
      return { outcome: await running, ticks: ticks - startedAt };
    },
    placeSolid: (x, y, z) => {
      world.setBlockStateId(new Vec3(x, y, z), registry.blocksByName.stone!.minStateId);
    },
    removeOpponent: (id) => {
      const record = opponents.get(id);
      if (record === undefined) return;
      opponents.delete(id);
      delete entities[String(id)];
      delete players[`Rival${id}`];
      bot.emit('entityGone', record.entity);
    },
    setOpponent: (id, point) => {
      const record = opponents.get(id);
      if (record === undefined) throw new Error(`opponent ${id} is not present`);
      record.x = point.x;
      record.y = point.y;
      record.z = point.z;
      record.entity.position.set(point.x, point.y, point.z);
    },
    close: () => client.close(),
  };
  return arena;
}

function serverEyeToBoxDistance(
  self: { readonly x: number; readonly y: number; readonly z: number },
  target: { readonly x: number; readonly y: number; readonly z: number },
): number {
  const gap = (point: number, low: number, high: number): number => (point < low ? low - point : point > high ? point - high : 0);
  const dx = gap(self.x, target.x - PLAYER_WIDTH / 2, target.x + PLAYER_WIDTH / 2);
  const dz = gap(self.z, target.z - PLAYER_WIDTH / 2, target.z + PLAYER_WIDTH / 2);
  const dy = gap(self.y + PLAYER_EYE_HEIGHT, target.y, target.y + PLAYER_HEIGHT);
  return Math.hypot(dx, dy, dz);
}
