import { performance } from 'node:perf_hooks';
import {
  currentKnowledge,
  type BorderUnknownReason,
  unknownKnowledge,
  worldBorder,
  type Knowledge,
  type WorldBorder,
} from '@arena/core';

interface BorderPacket {
  readonly x?: unknown;
  readonly z?: unknown;
  readonly oldDiameter?: unknown;
  readonly newDiameter?: unknown;
  readonly speed?: unknown;
  readonly diameter?: unknown;
}

interface PacketEventSource {
  on(event: string, listener: (packet: BorderPacket) => void): unknown;
  removeListener(event: string, listener: (packet: BorderPacket) => void): unknown;
}

interface DiameterTransition {
  readonly from: number;
  readonly to: number;
  readonly startedAt: number;
  readonly durationMs: number;
}

type Clock = () => number;

const BORDER_EVENTS = [
  'initialize_world_border',
  'world_border_center',
  'world_border_lerp_size',
  'world_border_size',
  'login',
  'respawn',
  'end',
] as const;

export class ClientWorldBorder {
  readonly #client: PacketEventSource;
  readonly #clock: Clock;
  readonly #listeners: ReadonlyMap<string, (packet: BorderPacket) => void>;
  #centerX: number | null = null;
  #centerZ: number | null = null;
  #diameter: number | null = null;
  #transition: DiameterTransition | null = null;

  constructor(client: PacketEventSource, clock: Clock = () => performance.now()) {
    this.#client = client;
    this.#clock = clock;
    this.#listeners = new Map([
      ['initialize_world_border', (packet: BorderPacket) => this.#initialize(packet)],
      ['world_border_center', (packet: BorderPacket) => this.#setCenter(packet)],
      ['world_border_lerp_size', (packet: BorderPacket) => this.#lerpSize(packet)],
      ['world_border_size', (packet: BorderPacket) => this.#setSize(packet)],
      ['login', () => this.#clear()],
      ['respawn', () => this.#clear()],
      ['end', () => this.#clear()],
    ]);

    for (const event of BORDER_EVENTS) {
      const listener = this.#listeners.get(event);
      if (listener === undefined) {
        throw new Error(`missing border listener for ${event}`);
      }
      this.#client.on(event, listener);
    }
  }

  snapshot(): Knowledge<WorldBorder> {
    if (this.#centerX === null || this.#centerZ === null || this.#diameter === null) {
      return unknownKnowledge();
    }

    const centerX = this.#centerX;
    const centerZ = this.#centerZ;
    if (!Number.isSafeInteger(centerX) || !Number.isSafeInteger(centerZ)) {
      return unknownKnowledge();
    }

    const radiusBlocks = Math.floor(this.#currentDiameter() / 2);
    if (!Number.isSafeInteger(radiusBlocks) || radiusBlocks <= 0) {
      return unknownKnowledge();
    }
    return currentKnowledge(worldBorder(centerX, centerZ, radiusBlocks));
  }

  unknownReason(): BorderUnknownReason | null {
    if (this.#centerX === null || this.#centerZ === null || this.#diameter === null) return 'noPacketReceived';
    if (!Number.isSafeInteger(this.#centerX) || !Number.isSafeInteger(this.#centerZ)) return 'fractionalCenter';
    const radiusBlocks = Math.floor(this.#currentDiameter() / 2);
    if (!Number.isSafeInteger(radiusBlocks) || radiusBlocks <= 0) return 'invalidRadius';
    return null;
  }

  close(): void {
    for (const event of BORDER_EVENTS) {
      const listener = this.#listeners.get(event);
      if (listener === undefined) {
        throw new Error(`missing border listener for ${event}`);
      }
      this.#client.removeListener(event, listener);
    }
    this.#clear();
  }

  #initialize(packet: BorderPacket): void {
    this.#centerX = finiteNumber(packet.x, 'initialize_world_border.x');
    this.#centerZ = finiteNumber(packet.z, 'initialize_world_border.z');
    const from = positiveDiameter(packet.oldDiameter, 'initialize_world_border.oldDiameter');
    const to = positiveDiameter(packet.newDiameter, 'initialize_world_border.newDiameter');
    const durationMs = nonnegativeSafeInteger(packet.speed, 'initialize_world_border.speed');
    this.#beginTransition(from, to, durationMs);
  }

  #setCenter(packet: BorderPacket): void {
    this.#centerX = finiteNumber(packet.x, 'world_border_center.x');
    this.#centerZ = finiteNumber(packet.z, 'world_border_center.z');
  }

  #lerpSize(packet: BorderPacket): void {
    const from = positiveDiameter(packet.oldDiameter, 'world_border_lerp_size.oldDiameter');
    const to = positiveDiameter(packet.newDiameter, 'world_border_lerp_size.newDiameter');
    const durationMs = nonnegativeSafeInteger(packet.speed, 'world_border_lerp_size.speed');
    this.#beginTransition(from, to, durationMs);
  }

  #setSize(packet: BorderPacket): void {
    this.#diameter = positiveDiameter(packet.diameter, 'world_border_size.diameter');
    this.#transition = null;
  }

  #beginTransition(from: number, to: number, durationMs: number): void {
    const startedAt = this.#clock();
    if (!Number.isFinite(startedAt)) {
      throw new RangeError(`monotonic clock returned a non-finite value: ${startedAt}`);
    }
    if (durationMs === 0) {
      this.#diameter = to;
      this.#transition = null;
      return;
    }
    this.#diameter = from;
    this.#transition = { from, to, startedAt, durationMs };
  }

  #currentDiameter(): number {
    const transition = this.#transition;
    if (transition === null) {
      if (this.#diameter === null) {
        throw new Error('border diameter requested before receipt');
      }
      return this.#diameter;
    }

    const elapsedMs = Math.max(0, this.#clock() - transition.startedAt);
    if (!Number.isFinite(elapsedMs)) {
      throw new RangeError(`monotonic clock returned a non-finite value: ${elapsedMs}`);
    }
    const progress = Math.min(1, elapsedMs / transition.durationMs);
    const diameter = transition.from + (transition.to - transition.from) * progress;
    if (progress === 1) {
      this.#diameter = transition.to;
      this.#transition = null;
    }
    return diameter;
  }

  #clear(): void {
    this.#centerX = null;
    this.#centerZ = null;
    this.#diameter = null;
    this.#transition = null;
  }
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite number`);
  }
  return value;
}

function positiveDiameter(value: unknown, field: string): number {
  const diameter = finiteNumber(value, field);
  if (diameter <= 0) {
    throw new RangeError(`${field} must be greater than zero`);
  }
  return diameter;
}

function nonnegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer`);
  }
  return value;
}
