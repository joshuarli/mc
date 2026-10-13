import type { Bot, BotEvents } from 'mineflayer';
import type { PartiallyComputedPath } from 'mineflayer-pathfinder';

const PATH_DIAGNOSTIC_CAPACITY = 512;
const MAX_DIAGNOSTIC_BLOCKS_PER_TICK = 36;
const MAX_DIAGNOSTIC_PATH_NODES = 16;
const MAX_DIAGNOSTIC_SHAPES_PER_BLOCK = 8;

type PathfinderGoal = NonNullable<Bot['pathfinder']['goal']>;
type MineflayerBlock = NonNullable<ReturnType<Bot['blockAt']>>;

interface DiagnosticPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface DiagnosticShape {
  readonly values: readonly [number, number, number, number, number, number];
}

interface DiagnosticBlock {
  readonly position: DiagnosticPoint;
  readonly loaded: boolean;
  readonly name: string | null;
  readonly type: number | null;
  readonly stateId: number | null;
  readonly shapes: readonly DiagnosticShape[];
  readonly shapesTruncated: boolean;
}

interface DiagnosticPathNode extends DiagnosticPoint {
  readonly cost: number;
  readonly remainingBlocks: number;
  readonly toBreakCount: number;
  readonly toPlaceCount: number;
}

interface DiagnosticPath {
  readonly status: PartiallyComputedPath['status'];
  readonly cost: number;
  /** Cumulative pathfinder context time, not the duration of one compute call. */
  readonly contextTimeMs: number;
  readonly visitedNodes: number;
  readonly generatedNodes: number;
  readonly nodeCount: number;
  readonly nodes: readonly DiagnosticPathNode[];
  readonly nodesTruncated: boolean;
}

interface DiagnosticGoal {
  readonly type: string;
  readonly x: number | null;
  readonly y: number | null;
  readonly z: number | null;
  readonly rangeSq: number | null;
  readonly entityId: number | null;
}

interface DiagnosticRecordBase {
  readonly clientLabel: string;
  readonly clientMs: number;
  readonly authorityTick: number | null;
}

type PathDiagnosticPayload<T = PathDiagnosticRecord> = T extends PathDiagnosticRecord
  ? Omit<T, keyof DiagnosticRecordBase>
  : never;

type DiagnosticCorrection = Extract<PathDiagnosticRecord, { readonly kind: 'positionCorrection' }>['packet'];

export type PathDiagnosticExternalOwner = 'sprintCourse';

export type PathDiagnosticRecord = DiagnosticRecordBase & (
  | {
    readonly kind: 'physicsTick';
    readonly owner: string | null;
    readonly navigationActive: boolean;
    readonly position: DiagnosticPoint;
    readonly velocity: DiagnosticPoint;
    readonly onGround: boolean;
    readonly collidedHorizontally: boolean | null;
    readonly collidedVertically: boolean | null;
    readonly control: Readonly<Record<'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint' | 'sneak', boolean>>;
    readonly goal: DiagnosticGoal | null;
    readonly moving: boolean;
    readonly path: DiagnosticPath | null;
    readonly blocks: readonly DiagnosticBlock[];
  }
  | {
    readonly kind: 'goalUpdated';
    readonly goal: DiagnosticGoal | null;
    readonly dynamic: boolean;
  }
  | {
    readonly kind: 'goalReached';
    readonly goal: DiagnosticGoal;
  }
  | {
    readonly kind: 'pathUpdate';
    readonly path: DiagnosticPath;
  }
  | {
    readonly kind: 'pathReset';
    readonly reason: string;
  }
  | { readonly kind: 'pathStop' }
  | {
    readonly kind: 'blockUpdate';
    readonly previous: DiagnosticBlock | null;
    readonly current: DiagnosticBlock;
  }
  | {
    readonly kind: 'positionCorrection';
    readonly packet: Readonly<{
      readonly x: number;
      readonly y: number;
      readonly z: number;
      readonly yaw: number;
      readonly pitch: number;
      readonly flags: Readonly<{
        readonly x: boolean;
        readonly y: boolean;
        readonly z: boolean;
        readonly yaw: boolean;
        readonly pitch: boolean;
        readonly dx: boolean;
        readonly dy: boolean;
        readonly dz: boolean;
        readonly yawDelta: boolean;
      }>;
      readonly delta: DiagnosticPoint;
      readonly teleportId: number | null;
    }>;
    readonly resultingPosition: DiagnosticPoint;
    readonly resultingVelocity: DiagnosticPoint;
    readonly onGround: boolean;
  }
  | {
    readonly kind: 'skillOwner';
    readonly owner: string | null;
  }
  | {
    readonly kind: 'externalMovementOwner';
    readonly owner: PathDiagnosticExternalOwner | null;
  }
  | {
    readonly kind: 'navigation';
    readonly active: boolean;
  }
  | {
    readonly kind: 'pathSearch';
    readonly transition: 'queued' | 'acquired' | 'released' | 'cancelled' | 'timedOut';
    readonly activeSearches: number;
    readonly queuedSearches: number;
  }
);

export interface PathDiagnosticClock {
  readonly clientMs: number;
  readonly authorityTick: number | null;
}

export interface PathDiagnosticOptions {
  readonly clientLabel: string;
  readonly clock: () => PathDiagnosticClock;
  /** Synchronous test sink; aggregate records instead of retaining another raw trace.
   * Callback errors surface on snapshot(). */
  readonly onRecord?: (record: PathDiagnosticRecord) => void;
}

type InternalPathDiagnostic =
  | { readonly kind: 'skillOwner'; readonly owner: string | null }
  | { readonly kind: 'navigation'; readonly active: boolean }
  | {
    readonly kind: 'pathSearch';
    readonly transition: 'queued' | 'acquired' | 'released' | 'cancelled' | 'timedOut';
    readonly activeSearches: number;
    readonly queuedSearches: number;
  };

interface PacketEventSource {
  on(event: string, listener: (packet: unknown) => void): unknown;
  removeListener(event: string, listener: (packet: unknown) => void): unknown;
}

interface PacketPositionCorrection {
  readonly x?: unknown;
  readonly y?: unknown;
  readonly z?: unknown;
  readonly dx?: unknown;
  readonly dy?: unknown;
  readonly dz?: unknown;
  readonly yaw?: unknown;
  readonly pitch?: unknown;
  readonly flags?: unknown;
  readonly teleportId?: unknown;
}

type PhysicsEntity = Bot['entity'] & {
  readonly isCollidedHorizontally?: boolean;
  readonly isCollidedVertically?: boolean;
};

const ringsByBot = new WeakMap<Bot, PathDiagnosticRing>();
const internalWriters = new WeakMap<PathDiagnosticRing, (event: InternalPathDiagnostic) => void>();

/** Captures bounded, bot-local movement evidence for an explicitly instrumented test. */
export class PathDiagnosticRing {
  readonly #bot: Bot;
  readonly #client: PacketEventSource;
  readonly #clientLabel: string;
  readonly #clock: () => PathDiagnosticClock;
  readonly #onRecord: ((record: PathDiagnosticRecord) => void) | undefined;
  readonly #entries: Array<PathDiagnosticRecord | undefined> = new Array(PATH_DIAGNOSTIC_CAPACITY);
  readonly #detach: Array<() => void> = [];
  #next = 0;
  #count = 0;
  #skillOwner: string | null = null;
  #externalMovementOwner: PathDiagnosticExternalOwner | null = null;
  #navigationActive = false;
  #latestPath: DiagnosticPath | null = null;
  #closed = false;
  #failure: Error | null = null;

  readonly #onPhysicsTick = (): void => this.#capture(() => this.#recordPhysicsTick());
  readonly #onGoalUpdated = (goal: PathfinderGoal | null, dynamic: boolean): void => this.#capture(() => {
    this.#latestPath = null;
    this.#append({ kind: 'goalUpdated', goal: goal === null ? null : copyGoal(goal), dynamic });
  });
  readonly #onGoalReached = (goal: PathfinderGoal): void => this.#capture(() => {
    this.#append({ kind: 'goalReached', goal: copyGoal(goal) });
  });
  readonly #onPathUpdate = (path: PartiallyComputedPath): void => this.#capture(() => {
    this.#latestPath = copyPath(path);
    this.#append({ kind: 'pathUpdate', path: this.#latestPath });
  });
  readonly #onPathReset = (reason: string): void => this.#capture(() => {
    this.#latestPath = null;
    this.#append({ kind: 'pathReset', reason });
  });
  readonly #onPathStop = (): void => this.#capture(() => {
    this.#latestPath = null;
    this.#append({ kind: 'pathStop' });
  });
  readonly #onBlockUpdate = (previous: MineflayerBlock | null, current: MineflayerBlock): void => this.#capture(() => {
    if (!isNearPlayer(this.#bot, current.position.x, current.position.y, current.position.z)) return;
    this.#append({
      kind: 'blockUpdate',
      previous: previous === null ? null : copyBlock(previous),
      current: copyBlock(current),
    });
  });
  readonly #onPositionCorrection = (packet: unknown): void => this.#capture(() => {
    const correction = copyPositionCorrection(packet);
    const entity = this.#bot.entity as PhysicsEntity;
    this.#append({
      kind: 'positionCorrection',
      packet: correction,
      resultingPosition: copyPoint(entity.position, 'position correction result'),
      resultingVelocity: copyPoint(entity.velocity, 'position correction velocity'),
      onGround: entity.onGround,
    });
  });

  constructor(bot: Bot, options: PathDiagnosticOptions) {
    if (ringsByBot.has(bot)) throw new Error('a path diagnostic ring is already attached to this bot');
    if (options.clientLabel.trim().length === 0) throw new RangeError('path diagnostic client label must not be empty');
    if (typeof options.clock !== 'function') throw new TypeError('path diagnostic clock must be a function');
    if (options.onRecord !== undefined && typeof options.onRecord !== 'function') {
      throw new TypeError('path diagnostic record callback must be a function when supplied');
    }
    this.#bot = bot;
    this.#client = bot._client as unknown as PacketEventSource;
    this.#clientLabel = options.clientLabel;
    this.#clock = options.clock;
    this.#onRecord = options.onRecord;

    try {
      this.#listenBot('physicsTick', this.#onPhysicsTick);
      this.#listenBot('goal_updated', this.#onGoalUpdated);
      this.#listenBot('goal_reached', this.#onGoalReached);
      this.#listenBot('path_update', this.#onPathUpdate);
      this.#listenBot('path_reset', this.#onPathReset);
      this.#listenBot('path_stop', this.#onPathStop);
      this.#listenBot('blockUpdate', this.#onBlockUpdate);
      this.#client.on('position', this.#onPositionCorrection);
      this.#detach.push(() => this.#client.removeListener('position', this.#onPositionCorrection));
      ringsByBot.set(bot, this);
      internalWriters.set(this, (event) => this.#recordInternal(event));
    } catch (error) {
      for (const detach of this.#detach.splice(0)) detach();
      throw error;
    }
  }

  /** Returns the ring contents in oldest-first order. */
  snapshot(): readonly PathDiagnosticRecord[] {
    if (this.#failure !== null) throw new Error('path diagnostic capture failed', { cause: this.#failure });
    const start = (this.#next - this.#count + PATH_DIAGNOSTIC_CAPACITY) % PATH_DIAGNOSTIC_CAPACITY;
    const records: PathDiagnosticRecord[] = [];
    for (let index = 0; index < this.#count; index += 1) {
      const record = this.#entries[(start + index) % PATH_DIAGNOSTIC_CAPACITY];
      if (record === undefined) throw new Error('path diagnostic ring contains an empty slot');
      records.push(record);
    }
    return Object.freeze(records);
  }

  /** Marks movement controlled outside the arena skill owner, such as the sprint course. */
  setExternalMovementOwner(owner: PathDiagnosticExternalOwner | null): void {
    this.#capture(() => {
      this.#externalMovementOwner = owner;
      this.#append({ kind: 'externalMovementOwner', owner });
    });
  }

  /** Detaches all listeners and stops scheduler writes while preserving the captured snapshot. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const detach of this.#detach.splice(0)) detach();
    if (ringsByBot.get(this.#bot) === this) ringsByBot.delete(this.#bot);
    internalWriters.delete(this);
  }

  #listenBot<K extends keyof BotEvents>(event: K, listener: BotEvents[K]): void {
    this.#bot.on(event, listener as never);
    this.#detach.push(() => this.#bot.removeListener(event, listener as never));
  }

  #capture(action: () => void): void {
    if (this.#closed || this.#failure !== null) return;
    try {
      action();
    } catch (error) {
      this.#failure = error instanceof Error ? error : new Error(String(error));
    }
  }

  #recordInternal(event: InternalPathDiagnostic): void {
    this.#capture(() => {
      switch (event.kind) {
        case 'skillOwner':
          this.#skillOwner = event.owner;
          this.#append({ kind: 'skillOwner', owner: event.owner });
          return;
        case 'navigation':
          this.#navigationActive = event.active;
          this.#append({ kind: 'navigation', active: event.active });
          return;
        case 'pathSearch':
          assertCount(event.activeSearches, 'active path search count');
          assertCount(event.queuedSearches, 'queued path search count');
          this.#append({
            kind: 'pathSearch',
            transition: event.transition,
            activeSearches: event.activeSearches,
            queuedSearches: event.queuedSearches,
          });
          return;
        default:
          return assertNever(event);
      }
    });
  }

  #recordPhysicsTick(): void {
    const entity = this.#bot.entity as PhysicsEntity;
    const goal = this.#bot.pathfinder.goal;
    const position = copyPoint(entity.position, 'player position');
    const velocity = copyPoint(entity.velocity, 'player velocity');
    const control = this.#bot.controlState;
    const controls = Object.freeze({
      forward: control.forward,
      back: control.back,
      left: control.left,
      right: control.right,
      jump: control.jump,
      sprint: control.sprint,
      sneak: control.sneak,
    });
    const blocks = sampleNearbyBlocks(this.#bot, entity.position);
    this.#append({
      kind: 'physicsTick',
      owner: this.#skillOwner ?? this.#externalMovementOwner,
      navigationActive: this.#navigationActive,
      position,
      velocity,
      onGround: entity.onGround,
      collidedHorizontally: optionalBoolean(entity.isCollidedHorizontally, 'horizontal collision flag'),
      collidedVertically: optionalBoolean(entity.isCollidedVertically, 'vertical collision flag'),
      control: controls,
      goal: goal === null ? null : copyGoal(goal),
      moving: this.#bot.pathfinder.isMoving(),
      path: this.#latestPath,
      blocks,
    });
  }

  #append(record: PathDiagnosticPayload): void {
    const clock = this.#clock();
    const clientMs = finite(clock.clientMs, 'client diagnostic clock');
    if (clock.authorityTick !== null && (!Number.isSafeInteger(clock.authorityTick) || clock.authorityTick < 0)) {
      throw new RangeError(`authority diagnostic tick must be null or a non-negative safe integer: ${clock.authorityTick}`);
    }
    const stamped = Object.freeze({
      clientLabel: this.#clientLabel,
      clientMs,
      authorityTick: clock.authorityTick,
      ...record,
    }) as PathDiagnosticRecord;
    this.#entries[this.#next] = stamped;
    this.#next = (this.#next + 1) % PATH_DIAGNOSTIC_CAPACITY;
    this.#count = Math.min(PATH_DIAGNOSTIC_CAPACITY, this.#count + 1);
    this.#onRecord?.(stamped);
  }
}

/** Records skill-owner and search-admission transitions when a test has attached a ring. */
export function recordPathDiagnostic(bot: Bot, event: InternalPathDiagnostic): void {
  const ring = ringsByBot.get(bot);
  if (ring === undefined) return;
  internalWriters.get(ring)?.(event);
}

function sampleNearbyBlocks(bot: Bot, position: Bot['entity']['position']): readonly DiagnosticBlock[] {
  const baseX = Math.floor(position.x);
  const baseY = Math.floor(position.y);
  const baseZ = Math.floor(position.z);
  const blocks: DiagnosticBlock[] = [];
  for (let yOffset = -1; yOffset <= 2; yOffset += 1) {
    for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
      for (let zOffset = -1; zOffset <= 1; zOffset += 1) {
        const x = baseX + xOffset;
        const y = baseY + yOffset;
        const z = baseZ + zOffset;
        const localPosition = position.offset(x - position.x, y - position.y, z - position.z);
        const block = bot.blockAt(localPosition);
        blocks.push(block === null
          ? copyUnknownBlock(x, y, z)
          : copyBlock(block));
      }
    }
  }
  if (blocks.length !== MAX_DIAGNOSTIC_BLOCKS_PER_TICK) {
    throw new Error(`path diagnostic sampled ${blocks.length} local blocks, expected ${MAX_DIAGNOSTIC_BLOCKS_PER_TICK}`);
  }
  return Object.freeze(blocks);
}

function copyUnknownBlock(x: number, y: number, z: number): DiagnosticBlock {
  return Object.freeze({
    position: point(x, y, z),
    loaded: false,
    name: null,
    type: null,
    stateId: null,
    shapes: Object.freeze([]),
    shapesTruncated: false,
  });
}

function copyBlock(block: MineflayerBlock): DiagnosticBlock {
  const shapes: DiagnosticShape[] = [];
  if (!Array.isArray(block.shapes)) throw new TypeError('locally received block has no collision-shape array');
  for (const shape of block.shapes.slice(0, MAX_DIAGNOSTIC_SHAPES_PER_BLOCK)) {
    if (!Array.isArray(shape) || shape.length !== 6) throw new TypeError('block collision shape must contain six coordinates');
    const values = shape.map((value, index) => finite(value, `block shape coordinate ${index}`));
    shapes.push(Object.freeze({ values: Object.freeze(values) as unknown as DiagnosticShape['values'] }));
  }
  return Object.freeze({
    position: copyPoint(block.position, 'block position'),
    loaded: true,
    name: block.name,
    type: finite(block.type, 'block type'),
    stateId: finite(block.stateId, 'block state id'),
    shapes: Object.freeze(shapes),
    shapesTruncated: block.shapes.length > MAX_DIAGNOSTIC_SHAPES_PER_BLOCK,
  });
}

function copyPath(path: PartiallyComputedPath): DiagnosticPath {
  assertCount(path.visitedNodes, 'visited path node count');
  assertCount(path.generatedNodes, 'generated path node count');
  return Object.freeze({
    status: path.status,
    cost: finite(path.cost, 'path cost'),
    contextTimeMs: finite(path.time, 'pathfinder context time'),
    visitedNodes: path.visitedNodes,
    generatedNodes: path.generatedNodes,
    nodeCount: path.path.length,
    nodes: Object.freeze(path.path.slice(0, MAX_DIAGNOSTIC_PATH_NODES).map((node) => Object.freeze({
      x: finite(node.x, 'path node x'),
      y: finite(node.y, 'path node y'),
      z: finite(node.z, 'path node z'),
      cost: finite(node.cost, 'path node cost'),
      remainingBlocks: finite(node.remainingBlocks, 'path node remaining blocks'),
      toBreakCount: node.toBreak.length,
      toPlaceCount: node.toPlace.length,
    }))),
    nodesTruncated: path.path.length > MAX_DIAGNOSTIC_PATH_NODES,
  });
}

function copyGoal(goal: PathfinderGoal): DiagnosticGoal {
  const value = goal as unknown as Record<string, unknown>;
  const constructor = (goal as { readonly constructor?: { readonly name?: unknown } }).constructor;
  return Object.freeze({
    type: typeof constructor?.name === 'string' ? constructor.name : 'unknown',
    x: nullableFinite(value.x, 'goal x'),
    y: nullableFinite(value.y, 'goal y'),
    z: nullableFinite(value.z, 'goal z'),
    rangeSq: nullableFinite(value.rangeSq, 'goal range squared'),
    entityId: nullableCount((value.entity as { readonly id?: unknown } | undefined)?.id, 'goal entity id'),
  });
}

function copyPoint(value: { readonly x: number; readonly y: number; readonly z: number }, name: string): DiagnosticPoint {
  return point(
    finite(value.x, `${name} x`),
    finite(value.y, `${name} y`),
    finite(value.z, `${name} z`),
  );
}

function point(x: number, y: number, z: number): DiagnosticPoint {
  return Object.freeze({ x, y, z });
}

function copyPositionCorrection(packet: unknown): DiagnosticCorrection {
  if (packet === null || typeof packet !== 'object') throw new TypeError('position correction packet must be an object');
  const correction = packet as PacketPositionCorrection;
  return Object.freeze({
    x: finite(correction.x, 'position correction x'),
    y: finite(correction.y, 'position correction y'),
    z: finite(correction.z, 'position correction z'),
    yaw: finite(correction.yaw, 'position correction yaw'),
    pitch: finite(correction.pitch, 'position correction pitch'),
    flags: copyCorrectionFlags(correction.flags),
    delta: copyCorrectionDelta(correction),
    teleportId: nullableCount(correction.teleportId, 'position correction teleport id'),
  });
}

function copyCorrectionDelta(packet: PacketPositionCorrection): DiagnosticPoint {
  return point(
    finite(packet.dx, 'position correction delta x'),
    finite(packet.dy, 'position correction delta y'),
    finite(packet.dz, 'position correction delta z'),
  );
}

function copyCorrectionFlags(value: unknown): Readonly<{
  readonly x: boolean;
  readonly y: boolean;
  readonly z: boolean;
  readonly yaw: boolean;
  readonly pitch: boolean;
  readonly dx: boolean;
  readonly dy: boolean;
  readonly dz: boolean;
  readonly yawDelta: boolean;
}> {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('position correction flag mask must be a non-negative safe integer');
    return Object.freeze({
      x: (value & 1) !== 0,
      y: (value & 2) !== 0,
      z: (value & 4) !== 0,
      yaw: (value & 8) !== 0,
      pitch: (value & 16) !== 0,
      dx: (value & 32) !== 0,
      dy: (value & 64) !== 0,
      dz: (value & 128) !== 0,
      yawDelta: (value & 256) !== 0,
    });
  }
  if (value === null || typeof value !== 'object') throw new TypeError('position correction flags must be a flag mask or object');
  const flags = value as Readonly<Record<string, unknown>>;
  return Object.freeze({
    x: booleanFlag(flags.x, 'position correction x flag'),
    y: booleanFlag(flags.y, 'position correction y flag'),
    z: booleanFlag(flags.z, 'position correction z flag'),
    yaw: booleanFlag(flags.yaw, 'position correction yaw flag'),
    pitch: booleanFlag(flags.pitch, 'position correction pitch flag'),
    dx: booleanFlag(flags.dx, 'position correction dx flag'),
    dy: booleanFlag(flags.dy, 'position correction dy flag'),
    dz: booleanFlag(flags.dz, 'position correction dz flag'),
    yawDelta: booleanFlag(flags.yawDelta, 'position correction yaw delta flag'),
  });
}

function booleanFlag(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be boolean when supplied`);
  return value;
}

function isNearPlayer(bot: Bot, x: number, y: number, z: number): boolean {
  const position = bot.entity.position;
  return Math.abs(x - Math.floor(position.x)) <= 1
    && y >= Math.floor(position.y) - 1
    && y <= Math.floor(position.y) + 2
    && Math.abs(z - Math.floor(position.z)) <= 1;
}

function optionalBoolean(value: boolean | undefined, name: string): boolean | null {
  if (value === undefined) return null;
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be boolean when supplied`);
  return value;
}

function nullableFinite(value: unknown, name: string): number | null {
  return value === undefined || value === null ? null : finite(value, name);
}

function nullableCount(value: unknown, name: string): number | null {
  return value === undefined || value === null ? null : count(value, name);
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return value;
}

function count(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function assertCount(value: number, name: string): void {
  count(value, name);
}

function assertNever(value: never): never {
  throw new Error(`unhandled path diagnostic event: ${JSON.stringify(value)}`);
}
