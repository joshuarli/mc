import { EXTERNAL_USERNAME_PATTERN, LEGACY_MAX_COMPETITORS, MAX_COMPETITORS, type MapIr, type NaturalMapIr, type SeatIr } from '@arena/spec';
import { MAX_WORLD_PLAN_BYTES } from './owned-files/index.js';
import { isValidRunId } from './run-id.js';

const MAX_U64 = (1n << 64n) - 1n;
const NATURAL_FOOTPRINT_BLOCKS = 1024;

export type WorldPlanErrorKind =
  | 'invalid_run_id'
  | 'unsupported_terrain'
  | 'too_many_spawns'
  | 'spawn_seat_outside_schema'
  | 'noncontiguous_spawn_seats'
  | 'roster_spawn_mismatch'
  | 'invalid_external_username'
  | 'invalid_world_seed'
  | 'invalid_natural_dimensions'
  | 'encoded_output_too_large';

export class WorldPlanError extends Error {
  constructor(readonly kind: WorldPlanErrorKind) {
    super(kind);
  }
}

export function encodeWorldPlanV1(runId: string, map: MapIr): Buffer {
  validateRunId(runId);
  if (map.terrain !== 'planned') throw new WorldPlanError('unsupported_terrain');
  validateSpawnSeats(map, LEGACY_MAX_COMPETITORS);

  const writer = new BoundedJsonWriter(MAX_WORLD_PLAN_BYTES);
  writer.write('{"schema":1,"run_id":');
  writer.writeJsonString(runId);
  writer.write(',"map_semantic_id":');
  writer.writeJsonString(map.semanticId);
  writer.write(',"dimensions":{"width":');
  writer.writeNumber(map.dimensions.width);
  writer.write(',"depth":');
  writer.writeNumber(map.dimensions.depth);
  writer.write(',"min_y":');
  writer.writeNumber(map.dimensions.minY);
  writer.write(',"max_y":');
  writer.writeNumber(map.dimensions.maxY);
  writer.write('},"blocks":[');
  for (const [index, block] of map.blocks.entries()) {
    if (index !== 0) writer.write(',');
    writer.write('{"position":');
    writePosition(writer, block.position);
    writer.write(',"block":');
    writer.writeJsonString(block.block);
    writer.write('}');
  }
  writer.write('],"spawns":[');
  for (const [index, spawn] of map.spawns.entries()) {
    if (index !== 0) writer.write(',');
    writer.write('{"seat":');
    writer.writeNumber(spawn.seat);
    writer.write(',"position":');
    writePosition(writer, spawn.position);
    writer.write('}');
  }
  writer.write('],"loot_containers":[');
  for (const [index, container] of map.lootContainers.entries()) {
    if (index !== 0) writer.write(',');
    writer.write('{"position":');
    writePosition(writer, container.position);
    writer.write(',"inventory":[');
    for (const [itemIndex, item] of container.inventory.entries()) {
      if (itemIndex !== 0) writer.write(',');
      writer.writeJsonString(item);
    }
    writer.write(']}');
  }
  writer.write(']}');
  return writer.finish();
}

export function encodeWorldPlanV2(runId: string, worldSeed: bigint, map: NaturalMapIr): Buffer {
  validateRunId(runId);
  validateSpawnSeats(map, LEGACY_MAX_COMPETITORS);
  validateNaturalFootprint(map);
  if (worldSeed < 0n || worldSeed > MAX_U64) throw new WorldPlanError('invalid_world_seed');

  const writer = new BoundedJsonWriter(MAX_WORLD_PLAN_BYTES);
  writer.write('{"schema":2,"run_id":');
  writer.writeJsonString(runId);
  writer.write(',"world_seed":');
  writer.writeJsonString(worldSeed.toString(10));
  writer.write(',"map_semantic_id":');
  writer.writeJsonString(map.semanticId);
  writer.write(',"terrain":"vanilla","dimensions":{"width":');
  writer.writeNumber(map.dimensions.width);
  writer.write(',"depth":');
  writer.writeNumber(map.dimensions.depth);
  writer.write('},"blocks":[],"spawns":[');
  writeNaturalContent(writer, map);
  return writer.finish();
}

export function encodeWorldPlanV3(
  runId: string,
  worldSeed: bigint,
  map: NaturalMapIr,
  seats: readonly SeatIr[],
): Buffer {
  validateRunId(runId);
  validateSpawnSeats(map, MAX_COMPETITORS);
  validateNaturalFootprint(map);
  validateSeatRoster(map, seats);
  if (worldSeed < 0n || worldSeed > MAX_U64) throw new WorldPlanError('invalid_world_seed');

  const writer = new BoundedJsonWriter(MAX_WORLD_PLAN_BYTES);
  writer.write('{"schema":3,"run_id":');
  writer.writeJsonString(runId);
  writer.write(',"world_seed":');
  writer.writeJsonString(worldSeed.toString(10));
  writer.write(',"map_semantic_id":');
  writer.writeJsonString(map.semanticId);
  writer.write(',"terrain":"vanilla","dimensions":{"width":');
  writer.writeNumber(map.dimensions.width);
  writer.write(',"depth":');
  writer.writeNumber(map.dimensions.depth);
  writer.write('},"blocks":[],"roster":[');
  for (const [index, { seat, controller }] of seats.entries()) {
    if (index !== 0) writer.write(',');
    writer.write('{"seat":');
    writer.writeNumber(seat);
    if (controller.kind === 'bot') {
      writer.write(',"kind":"bot"}');
    } else {
      writer.write(',"kind":"external","username":');
      writer.writeJsonString(controller.username);
      writer.write('}');
    }
  }
  writer.write('],"spawns":[');
  writeNaturalContent(writer, map);
  return writer.finish();
}

function writeNaturalContent(writer: BoundedJsonWriter, map: NaturalMapIr): void {
  for (const [index, spawn] of map.spawns.entries()) {
    if (index !== 0) writer.write(',');
    writer.write('{"seat":');
    writer.writeNumber(spawn.seat);
    writer.write(',"column":');
    writeColumn(writer, spawn.column);
    writer.write('}');
  }
  writer.write('],"loot_containers":[');
  for (const [index, container] of map.lootContainers.entries()) {
    if (index !== 0) writer.write(',');
    writer.write('{"column":');
    writeColumn(writer, container.column);
    writer.write(',"inventory":[');
    for (const [itemIndex, item] of container.inventory.entries()) {
      if (itemIndex !== 0) writer.write(',');
      writer.writeJsonString(item);
    }
    writer.write(']}');
  }
  writer.write(']}');
}

export function encodeWorldPlan(runId: string, seed: bigint, map: MapIr): Buffer {
  return map.terrain === 'planned'
    ? encodeWorldPlanV1(runId, map)
    : encodeWorldPlanV2(runId, seed, map);
}

function validateRunId(runId: string): void {
  if (!isValidRunId(runId)) {
    throw new WorldPlanError('invalid_run_id');
  }
}

function validateSpawnSeats(map: MapIr, maxSeats: number): void {
  if (map.spawns.length > maxSeats) throw new WorldPlanError('too_many_spawns');
  for (const [expected, spawn] of map.spawns.entries()) {
    if (spawn.seat >= maxSeats) throw new WorldPlanError('spawn_seat_outside_schema');
    if (spawn.seat !== expected) throw new WorldPlanError('noncontiguous_spawn_seats');
  }
}

function validateNaturalFootprint(map: NaturalMapIr): void {
  if (map.dimensions.width !== NATURAL_FOOTPRINT_BLOCKS
      || map.dimensions.depth !== NATURAL_FOOTPRINT_BLOCKS) {
    throw new WorldPlanError('invalid_natural_dimensions');
  }
}

function validateSeatRoster(map: NaturalMapIr, seats: readonly SeatIr[]): void {
  if (seats.length !== map.spawns.length) throw new WorldPlanError('roster_spawn_mismatch');
  for (const [expected, { seat, controller }] of seats.entries()) {
    if (seat !== expected) throw new WorldPlanError('roster_spawn_mismatch');
    if (controller.kind === 'external' && !EXTERNAL_USERNAME_PATTERN.test(controller.username)) {
      throw new WorldPlanError('invalid_external_username');
    }
  }
}

function writeColumn(writer: BoundedJsonWriter, column: { readonly x: number; readonly z: number }): void {
  writer.write('{"x":');
  writer.writeNumber(column.x);
  writer.write(',"z":');
  writer.writeNumber(column.z);
  writer.write('}');
}

function writePosition(writer: BoundedJsonWriter, position: { readonly x: number; readonly y: number; readonly z: number }): void {
  writer.write('{"x":');
  writer.writeNumber(position.x);
  writer.write(',"y":');
  writer.writeNumber(position.y);
  writer.write(',"z":');
  writer.writeNumber(position.z);
  writer.write('}');
}

class BoundedJsonWriter {
  private readonly chunks: string[] = [];
  private byteLength = 0;

  constructor(private readonly maxBytes: number) {}

  write(value: string): void {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > this.maxBytes - this.byteLength) {
      throw new WorldPlanError('encoded_output_too_large');
    }
    this.byteLength += bytes;
    this.chunks.push(value);
  }

  writeNumber(value: number): void {
    if (!Number.isSafeInteger(value)) throw new TypeError('world-plan numbers must be safe integers');
    this.write(String(value));
  }

  writeJsonString(value: string): void {
    this.write(JSON.stringify(value)!);
  }

  finish(): Buffer {
    const encoded = Buffer.from(this.chunks.join(''), 'utf8');
    if (encoded.byteLength !== this.byteLength) throw new Error('world-plan UTF-8 byte count changed during encoding');
    return encoded;
  }
}

