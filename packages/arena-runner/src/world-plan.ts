import type { MapIr } from '@arena/spec';

const WORLD_PLAN_SCHEMA_VERSION = 1;
const MAX_WORLD_PLAN_BYTES = 128 * 1024 * 1024;

export type WorldPlanErrorKind =
  | 'invalid_run_id'
  | 'too_many_spawns'
  | 'spawn_seat_outside_schema'
  | 'noncontiguous_spawn_seats'
  | 'encoded_output_too_large';

export class WorldPlanError extends Error {
  constructor(readonly kind: WorldPlanErrorKind) {
    super(kind);
  }
}

export function encodeWorldPlanV1(runId: string, map: MapIr): Buffer {
  validateRunId(runId);
  validateSpawnSeats(map);

  const writer = new BoundedJsonWriter(MAX_WORLD_PLAN_BYTES);
  writer.write(`{"schema":${WORLD_PLAN_SCHEMA_VERSION},"run_id":`);
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

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(runId)) {
    throw new WorldPlanError('invalid_run_id');
  }
}

function validateSpawnSeats(map: MapIr): void {
  if (map.spawns.length > 6) throw new WorldPlanError('too_many_spawns');
  for (const [expected, spawn] of map.spawns.entries()) {
    if (spawn.seat > 5) throw new WorldPlanError('spawn_seat_outside_schema');
    if (spawn.seat !== expected) throw new WorldPlanError('noncontiguous_spawn_seats');
  }
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

