import { blockPosition } from "@arena/core";
import type { BlockPosition } from "@arena/core";

import { CanonicalHasher, type SemanticId } from "./hash.js";
import { SpecError, SpecErrorKind } from "./errors.js";
import * as raw from "./raw.js";

const MAX_BLOCK_WRITES = 1_000_000n;
const MAX_OPERATIONS = 100_000;
const MAX_LOOT_INVENTORY_ITEMS = 27;
const I32_MIN = -2_147_483_648n;
const I32_MAX = 2_147_483_647n;
const U16_MAX = 65_535n;

/** Inclusive vertical and horizontal bounds for a compiled map. */
export interface MapDimensions {
  readonly width: number;
  readonly depth: number;
  readonly minY: number;
  readonly maxY: number;
}

/** A final non-air block placement in canonical coordinate order. */
export interface BlockPlacement {
  readonly position: BlockPosition;
  readonly block: string;
}

/** A validated spawn point assigned to a stable seat. */
export interface SpawnPoint {
  readonly seat: number;
  readonly position: BlockPosition;
}

/** A chest setup record with its ordered starting inventory. */
export interface LootContainer {
  readonly position: BlockPosition;
  readonly inventory: readonly string[];
}

/** Immutable, validated map input for the world adapter. */
export interface MapIr {
  readonly name: string;
  readonly dimensions: MapDimensions;
  readonly blocks: readonly BlockPlacement[];
  readonly spawns: readonly SpawnPoint[];
  readonly lootContainers: readonly LootContainer[];
  readonly semanticId: SemanticId;
}

interface GeometryMetadata {
  readonly surfaceY: ReadonlyMap<string, number>;
  readonly components: ReadonlyMap<string, number>;
}

const geometryByMap = new WeakMap<MapIr, GeometryMetadata>();

/** Compiles a schema-v1 TOML map into immutable, validated world data. */
export function compileMap(source: string): MapIr {
  const root = raw.asTable(raw.parseDocument(source, "map"), "map");
  raw.checkFields(root, ["schema", "name", "dimensions", "operations"], ["schema", "name", "dimensions", "operations"], "map");

  if (raw.integer(raw.field(root, "schema", "map"), "map.schema") !== 1n) {
    throw new SpecError(SpecErrorKind.InvalidValue, "map.schema", "only schema version 1 is supported");
  }
  const name = raw.string(raw.field(root, "name", "map"), "map.name");
  const dimensions = parseDimensions(raw.field(root, "dimensions", "map"));
  const operations = raw.asArray(raw.field(root, "operations", "map"), "map.operations");
  if (operations.length > MAX_OPERATIONS) {
    throw new SpecError(SpecErrorKind.ResourceLimit, "map.operations", `at most ${MAX_OPERATIONS} operations are supported`);
  }

  const blocks = new Map<string, { readonly position: BlockPosition; block: string }>();
  const spawns = new Map<number, BlockPosition>();
  const loot = new Map<string, { readonly position: BlockPosition; readonly inventory: readonly string[] }>();
  let attemptedWrites = 0n;

  for (const [index, operationValue] of operations.entries()) {
    const path = `map.operations[${index}]`;
    const operation = raw.asTable(operationValue, path);
    const kind = raw.string(raw.field(operation, "kind", path), `${path}.kind`);
    switch (kind) {
      case "cuboid": {
        raw.checkFields(operation, ["kind", "from", "to", "block"], ["kind", "from", "to", "block"], path);
        const from = parsePosition(raw.field(operation, "from", path), `${path}.from`, dimensions);
        const to = parsePosition(raw.field(operation, "to", path), `${path}.to`, dimensions);
        if (from.x > to.x || from.y > to.y || from.z > to.z) {
          throw new SpecError(SpecErrorKind.Range, path, "cuboid `from` coordinates must not exceed `to` coordinates");
        }
        const block = parseResourceId(raw.field(operation, "block", path), `${path}.block`);
        const volume = BigInt(to.x - from.x + 1) * BigInt(to.y - from.y + 1) * BigInt(to.z - from.z + 1);
        attemptedWrites = addBlockWrites(attemptedWrites, volume, path);
        if ([...loot.keys()].some((key) => insideCuboid(loot.get(key)!.position, from, to))) {
          throw new SpecError(SpecErrorKind.Conflict, path, "block operation would overwrite an earlier loot container");
        }
        for (let x = from.x; x <= to.x; x += 1) {
          for (let y = from.y; y <= to.y; y += 1) {
            for (let z = from.z; z <= to.z; z += 1) {
              assignBlock(blocks, makePosition(x, y, z), block);
            }
          }
        }
        break;
      }
      case "path":
      case "ramp": {
        raw.checkFields(operation, ["kind", "position", "block"], ["kind", "position", "block"], path);
        const position = parsePosition(raw.field(operation, "position", path), `${path}.position`, dimensions);
        const block = parseResourceId(raw.field(operation, "block", path), `${path}.block`);
        attemptedWrites = addBlockWrites(attemptedWrites, 1n, path);
        if (loot.has(positionKey(position))) {
          throw new SpecError(SpecErrorKind.Conflict, path, "block operation would overwrite an earlier loot container");
        }
        assignBlock(blocks, position, block);
        break;
      }
      case "spawn": {
        raw.checkFields(operation, ["kind", "position", "seat"], ["kind", "position", "seat"], path);
        const position = parsePosition(raw.field(operation, "position", path), `${path}.position`, dimensions);
        const seat = nonnegativeU16(raw.field(operation, "seat", path), `${path}.seat`);
        if (spawns.has(seat)) {
          throw new SpecError(SpecErrorKind.Conflict, `${path}.seat`, "spawn seat is declared more than once");
        }
        spawns.set(seat, position);
        break;
      }
      case "loot_container": {
        raw.checkFields(operation, ["kind", "position", "inventory"], ["kind", "position", "inventory"], path);
        const position = parsePosition(raw.field(operation, "position", path), `${path}.position`, dimensions);
        const inventoryValues = raw.asArray(raw.field(operation, "inventory", path), `${path}.inventory`);
        if (inventoryValues.length > MAX_LOOT_INVENTORY_ITEMS) {
          throw new SpecError(
            SpecErrorKind.ResourceLimit,
            `${path}.inventory`,
            `a chest inventory can contain at most ${MAX_LOOT_INVENTORY_ITEMS} items`,
          );
        }
        const inventory = inventoryValues.map((value, itemIndex) => parseResourceId(value, `${path}.inventory[${itemIndex}]`));
        if (inventory.length === 0) {
          throw new SpecError(SpecErrorKind.InvalidValue, `${path}.inventory`, "loot inventory must contain at least one item");
        }
        const key = positionKey(position);
        if (loot.has(key)) {
          throw new SpecError(SpecErrorKind.Conflict, `${path}.position`, "loot container position is declared more than once");
        }
        loot.set(key, { position, inventory: Object.freeze(inventory) });
        assignBlock(blocks, position, "minecraft:chest");
        break;
      }
      default:
        throw new SpecError(SpecErrorKind.InvalidValue, `${path}.kind`, `unknown map operation \`${kind}\``);
    }
  }

  if (spawns.size === 0) {
    throw new SpecError(SpecErrorKind.Geometry, "map.operations", "map must define at least one spawn");
  }
  if (loot.size === 0) {
    throw new SpecError(SpecErrorKind.Geometry, "map.operations", "map must define at least one loot container");
  }

  const spawnPoints = [...spawns.entries()]
    .sort(([left], [right]) => left - right)
    .map(([seat, position]) => Object.freeze({ seat, position }));
  const lootContainers = [...loot.values()]
    .sort((left, right) => comparePositions(left.position, right.position))
    .map(({ position, inventory }) => Object.freeze({ position, inventory }));
  const surfaceY = buildWalkableSurface(blocks, dimensions);
  const components = labelSurfaceComponents(surfaceY);
  validateSpawns(spawnPoints, surfaceY, components);
  const firstSpawn = spawnPoints[0];
  if (firstSpawn === undefined) throw new Error("validated map has no spawn points");
  validateLoot(lootContainers, blocks, surfaceY, components, firstSpawn);
  const blockPlacements = [...blocks.values()]
    .sort((left, right) => comparePositions(left.position, right.position))
    .map(({ position, block }) => Object.freeze({ position, block }));
  const semanticId = hashMap(dimensions, blockPlacements, spawnPoints, lootContainers);

  const map: MapIr = Object.freeze({
    name,
    dimensions,
    blocks: Object.freeze(blockPlacements),
    spawns: Object.freeze(spawnPoints),
    lootContainers: Object.freeze(lootContainers),
    semanticId,
  });
  geometryByMap.set(map, Object.freeze({ surfaceY, components }));
  return map;
}

export function validateSpawnSeats(map: MapIr, count: number, path: string): void {
  if (map.spawns.length !== count) {
    throw new SpecError(SpecErrorKind.Geometry, path, `map has ${map.spawns.length} spawns but scenario requires ${count}`);
  }
  for (const [expected, spawn] of map.spawns.entries()) {
    if (spawn.seat !== expected) {
      throw new SpecError(SpecErrorKind.Geometry, path, `spawn seats must be contiguous from zero; expected seat ${expected}`);
    }
  }
}

export function validateBorder(
  map: MapIr,
  initialDiameter: number,
  finalDiameter: number,
  path: string,
): void {
  if (initialDiameter > Math.min(map.dimensions.width, map.dimensions.depth)) {
    throw new SpecError(SpecErrorKind.Geometry, path, "initial border diameter must fit inside the map footprint");
  }
  const metadata = geometryByMap.get(map);
  if (metadata === undefined) throw new Error("compiled map geometry is missing");
  const centerX = (map.dimensions.width - 1) / 2;
  const centerZ = (map.dimensions.depth - 1) / 2;
  const initialRadiusSquared = (initialDiameter / 2) ** 2;
  const finalRadiusSquared = (finalDiameter / 2) ** 2;

  for (const spawn of map.spawns) {
    if (!insideCircle(spawn.position.x, spawn.position.z, centerX, centerZ, initialRadiusSquared)) {
      throw new SpecError(SpecErrorKind.Geometry, path, `spawn seat ${spawn.seat} lies outside the initial border`);
    }
    const component = metadata.components.get(columnKey(spawn.position.x, spawn.position.z));
    if (component === undefined) throw new Error("validated spawn has no traversable component");
    const reachesFinalZone = [...metadata.surfaceY.entries()].some(([key]) => {
      const [x, z] = parseColumnKey(key);
      return metadata.components.get(key) === component && insideCircle(x, z, centerX, centerZ, finalRadiusSquared);
    });
    if (!reachesFinalZone) {
      throw new SpecError(SpecErrorKind.Geometry, path, `spawn seat ${spawn.seat} cannot reach the final border zone`);
    }
  }

  for (const container of map.lootContainers) {
    if (!insideCircle(container.position.x, container.position.z, centerX, centerZ, initialRadiusSquared)) {
      throw new SpecError(SpecErrorKind.Geometry, path, "loot container lies outside the initial border");
    }
  }
}

function parseDimensions(value: raw.RawValue): MapDimensions {
  const path = "map.dimensions";
  const table = raw.asTable(value, path);
  raw.checkFields(table, ["width", "depth", "min_y", "max_y"], ["width", "depth", "min_y", "max_y"], path);
  const width = positiveU32(raw.field(table, "width", path), `${path}.width`);
  const depth = positiveU32(raw.field(table, "depth", path), `${path}.depth`);
  const minY = signedI32(raw.field(table, "min_y", path), `${path}.min_y`);
  const maxY = signedI32(raw.field(table, "max_y", path), `${path}.max_y`);
  if (width - 1 > 2_147_483_647 || depth - 1 > 2_147_483_647) {
    throw new SpecError(SpecErrorKind.Range, path, "width and depth must fit signed block coordinates");
  }
  if (minY > maxY) {
    throw new SpecError(SpecErrorKind.Range, `${path}.max_y`, "must be greater than or equal to min_y");
  }
  return Object.freeze({ width, depth, minY, maxY });
}

function parsePosition(value: raw.RawValue, path: string, dimensions: MapDimensions): BlockPosition {
  const table = raw.asTable(value, path);
  raw.checkFields(table, ["x", "y", "z"], ["x", "y", "z"], path);
  const x = signedI32(raw.field(table, "x", path), `${path}.x`);
  const y = signedI32(raw.field(table, "y", path), `${path}.y`);
  const z = signedI32(raw.field(table, "z", path), `${path}.z`);
  const position = makePosition(x, y, z);
  checkPosition(position, dimensions, path);
  return position;
}

function makePosition(x: number, y: number, z: number): BlockPosition {
  return Object.freeze(blockPosition(x, y, z));
}

function checkPosition(position: BlockPosition, dimensions: MapDimensions, path: string): void {
  if (position.x < 0 || position.x >= dimensions.width) {
    throw new SpecError(SpecErrorKind.Range, `${path}.x`, "must be within the map width");
  }
  if (position.z < 0 || position.z >= dimensions.depth) {
    throw new SpecError(SpecErrorKind.Range, `${path}.z`, "must be within the map depth");
  }
  if (position.y < dimensions.minY || position.y > dimensions.maxY) {
    throw new SpecError(SpecErrorKind.Range, `${path}.y`, "must be within the map vertical bounds");
  }
}

function positiveU32(value: raw.RawValue, path: string): number {
  const integer = raw.integer(value, path);
  if (integer <= 0n) throw new SpecError(SpecErrorKind.Range, path, "must be greater than zero");
  if (integer > 4_294_967_295n) throw new SpecError(SpecErrorKind.Range, path, "exceeds the supported coordinate range");
  return Number(integer);
}

function signedI32(value: raw.RawValue, path: string): number {
  const integer = raw.integer(value, path);
  if (integer < I32_MIN || integer > I32_MAX) {
    throw new SpecError(SpecErrorKind.Range, path, "exceeds signed block coordinate range");
  }
  return Number(integer);
}

function nonnegativeU16(value: raw.RawValue, path: string): number {
  const integer = raw.integer(value, path);
  if (integer < 0n) throw new SpecError(SpecErrorKind.Range, path, "must not be negative");
  if (integer > U16_MAX) throw new SpecError(SpecErrorKind.Range, path, "exceeds the supported seat range");
  return Number(integer);
}

function parseResourceId(value: raw.RawValue, path: string): string {
  const text = raw.string(value, path);
  const separator = text.indexOf(":");
  const namespace = separator === -1 ? "minecraft" : text.slice(0, separator);
  const resourcePath = separator === -1 ? text : text.slice(separator + 1);
  if (separator !== -1 && resourcePath.includes(":")) return invalidResourceId(path);
  if (
    namespace.length === 0
    || resourcePath.length === 0
    || ![...namespace].every(validNamespaceCharacter)
    || ![...resourcePath].every(validPathCharacter)
    || resourcePath.startsWith("/")
    || resourcePath.endsWith("/")
    || resourcePath.includes("//")
  ) return invalidResourceId(path);
  return `${namespace}:${resourcePath}`;
}

function invalidResourceId(path: string): never {
  throw new SpecError(SpecErrorKind.InvalidValue, path, "must be a valid Minecraft resource identifier");
}

function validNamespaceCharacter(character: string): boolean {
  return /^[a-z0-9_.-]$/.test(character);
}

function validPathCharacter(character: string): boolean {
  return character === "/" || validNamespaceCharacter(character);
}

function addBlockWrites(current: bigint, additional: bigint, path: string): bigint {
  const total = current + additional;
  if (total > MAX_BLOCK_WRITES) {
    throw new SpecError(SpecErrorKind.ResourceLimit, path, `at most ${MAX_BLOCK_WRITES} block writes are supported per map`);
  }
  return total;
}

function positionKey(position: BlockPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

function columnKey(x: number, z: number): string {
  return `${x},${z}`;
}

function parseColumnKey(key: string): readonly [number, number] {
  const separator = key.indexOf(",");
  return [Number(key.slice(0, separator)), Number(key.slice(separator + 1))];
}

function comparePositions(left: BlockPosition, right: BlockPosition): number {
  return left.x - right.x || left.y - right.y || left.z - right.z;
}

function assignBlock(
  blocks: Map<string, { readonly position: BlockPosition; block: string }>,
  position: BlockPosition,
  block: string,
): void {
  if (isAir(block)) blocks.delete(positionKey(position));
  else blocks.set(positionKey(position), { position, block });
}

function isAir(block: string): boolean {
  return block === "minecraft:air" || block === "minecraft:cave_air" || block === "minecraft:void_air";
}

function insideCuboid(position: BlockPosition, from: BlockPosition, to: BlockPosition): boolean {
  return position.x >= from.x && position.x <= to.x
    && position.y >= from.y && position.y <= to.y
    && position.z >= from.z && position.z <= to.z;
}

function buildWalkableSurface(
  blocks: ReadonlyMap<string, { readonly position: BlockPosition; block: string }>,
  dimensions: MapDimensions,
): Map<string, number> {
  const highestBlock = new Map<string, { readonly x: number; readonly z: number; y: number }>();
  for (const { position } of blocks.values()) {
    const key = columnKey(position.x, position.z);
    const previous = highestBlock.get(key);
    if (previous === undefined || position.y > previous.y) {
      highestBlock.set(key, { x: position.x, z: position.z, y: position.y });
    }
  }

  const surface = new Map<string, number>();
  for (const { x, z, y } of highestBlock.values()) {
    const feetY = y + 1;
    const headY = feetY + 1;
    if (feetY >= dimensions.minY && headY <= dimensions.maxY) {
      surface.set(columnKey(x, z), feetY);
    }
  }
  if (surface.size === 0) {
    throw new SpecError(SpecErrorKind.Geometry, "map.operations", "map has no two-block-high walkable surface");
  }
  return surface;
}

function labelSurfaceComponents(surface: ReadonlyMap<string, number>): Map<string, number> {
  const labels = new Map<string, number>();
  const columns = [...surface.keys()].sort(compareColumnKeys);
  let nextComponent = 0;
  for (const start of columns) {
    if (labels.has(start)) continue;
    const component = nextComponent;
    nextComponent += 1;
    const queue = [start];
    labels.set(start, component);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor];
      if (current === undefined) throw new Error("surface traversal queue is missing a pending column");
      const [x, z] = parseColumnKey(current);
      const y = surface.get(current);
      if (y === undefined) throw new Error("surface traversal reached a missing column");
      for (const [nextX, nextZ] of cardinalNeighbors(x, z)) {
        const next = columnKey(nextX, nextZ);
        const nextY = surface.get(next);
        if (nextY === undefined || Math.abs(nextY - y) > 1 || labels.has(next)) continue;
        labels.set(next, component);
        queue.push(next);
      }
    }
  }
  return labels;
}

function compareColumnKeys(left: string, right: string): number {
  const [leftX, leftZ] = parseColumnKey(left);
  const [rightX, rightZ] = parseColumnKey(right);
  return leftX - rightX || leftZ - rightZ;
}

function cardinalNeighbors(x: number, z: number): readonly (readonly [number, number])[] {
  return [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]];
}

function validateSpawns(
  spawns: readonly SpawnPoint[],
  surface: ReadonlyMap<string, number>,
  components: ReadonlyMap<string, number>,
): void {
  for (const [index, spawn] of spawns.entries()) {
    const column = columnKey(spawn.position.x, spawn.position.z);
    if (surface.get(column) !== spawn.position.y) {
      throw new SpecError(
        SpecErrorKind.Geometry,
        `map.spawn[${spawn.seat}]`,
        "spawn needs a full-block support with two clear blocks of headroom",
      );
    }
    for (const other of spawns.slice(0, index)) {
      const dx = spawn.position.x - other.position.x;
      const dz = spawn.position.z - other.position.z;
      if (dx * dx + dz * dz < 4) {
        throw new SpecError(
          SpecErrorKind.Geometry,
          `map.spawn[${spawn.seat}]`,
          `spawn is less than two blocks from seat ${other.seat}`,
        );
      }
    }
  }
  const spawnComponents = new Set(spawns.map((spawn) => components.get(columnKey(spawn.position.x, spawn.position.z))).filter((value) => value !== undefined));
  if (spawnComponents.size !== 1) {
    throw new SpecError(SpecErrorKind.Geometry, "map.spawn", "all spawn seats must share one traversable surface");
  }
}

function validateLoot(
  loot: readonly LootContainer[],
  blocks: ReadonlyMap<string, { readonly position: BlockPosition; block: string }>,
  surface: ReadonlyMap<string, number>,
  components: ReadonlyMap<string, number>,
  spawn: SpawnPoint,
): void {
  const spawnComponent = components.get(columnKey(spawn.position.x, spawn.position.z));
  if (spawnComponent === undefined) {
    throw new SpecError(SpecErrorKind.Geometry, "map.spawn", "map has no traversable spawn surface");
  }
  for (const [index, container] of loot.entries()) {
    const position = container.position;
    const path = `map.loot[${index}]`;
    if (!blocks.has(positionKey(position))) {
      throw new SpecError(SpecErrorKind.Geometry, path, "loot container block is missing");
    }
    const belowY = position.y - 1;
    if (!blocks.has(`${position.x},${belowY},${position.z}`)) {
      throw new SpecError(SpecErrorKind.Geometry, path, "loot container needs a support block below it");
    }
    let accessibleComponent: number | undefined;
    for (const [x, z] of cardinalNeighbors(position.x, position.z)) {
      const column = columnKey(x, z);
      if (surface.get(column) === position.y) {
        accessibleComponent = components.get(column);
        if (accessibleComponent !== undefined) break;
      }
    }
    if (accessibleComponent === undefined) {
      throw new SpecError(SpecErrorKind.Geometry, path, "loot container needs an adjacent walkable interaction position");
    }
    if (accessibleComponent !== spawnComponent) {
      throw new SpecError(SpecErrorKind.Geometry, path, "loot container is unreachable from the spawn surface");
    }
  }
}

function insideCircle(x: number, z: number, centerX: number, centerZ: number, radiusSquared: number): boolean {
  const dx = x - centerX;
  const dz = z - centerZ;
  return dx * dx + dz * dz <= radiusSquared;
}

function hashMap(
  dimensions: MapDimensions,
  blocks: readonly BlockPlacement[],
  spawns: readonly SpawnPoint[],
  loot: readonly LootContainer[],
): SemanticId {
  const hash = new CanonicalHasher("arena.map.ir.v1\0");
  hash.u32(dimensions.width);
  hash.u32(dimensions.depth);
  hash.i32(dimensions.minY);
  hash.i32(dimensions.maxY);
  hash.u64(BigInt(blocks.length));
  for (const placement of blocks) {
    hash.i32(placement.position.x);
    hash.i32(placement.position.y);
    hash.i32(placement.position.z);
    hash.string(placement.block);
  }
  hash.u64(BigInt(spawns.length));
  for (const spawn of spawns) {
    hash.u16(spawn.seat);
    hash.i32(spawn.position.x);
    hash.i32(spawn.position.y);
    hash.i32(spawn.position.z);
  }
  hash.u64(BigInt(loot.length));
  for (const container of loot) {
    hash.i32(container.position.x);
    hash.i32(container.position.y);
    hash.i32(container.position.z);
    hash.u64(BigInt(container.inventory.length));
    for (const item of container.inventory) hash.string(item);
  }
  return hash.finish();
}
