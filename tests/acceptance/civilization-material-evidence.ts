import type { BlockPosition } from "@arena/core";
import type { RuntimeAuthorityEvent } from "../../packages/arena-runner/src/runtime/types.js";

const MARKER_NAME = "ARENA_CIV_MATERIAL_V1";
const MARKER_PREFIX = `${MARKER_NAME}|`;
const SERVER_RECORD_PREFIX = /^\[[^\]\r\n]+\] \[Server thread\/INFO\]: \[ArenaFoundation\] /;
const MAX_MARKER_RECORDS = 256;
const MAX_MARKER_LINE_BYTES = 16 * 1024;

export interface CivilizationMaterialCounts {
  readonly oakLogs: number;
  readonly oakPlanks: number;
}

export interface CivilizationInventoryCount extends CivilizationMaterialCounts {
  readonly seat: number;
}

export interface CivilizationDropCount extends CivilizationMaterialCounts {
  readonly entityId: string;
}

export interface CivilizationContainerCount extends CivilizationMaterialCounts {
  readonly position: BlockPosition;
}

export interface CivilizationMaterialCheckpoint {
  readonly sequence: bigint;
  readonly atMatchTick: bigint;
  readonly remainingNaturalOakLogs: readonly BlockPosition[];
  readonly inventories: readonly CivilizationInventoryCount[];
  readonly itemEntities: readonly CivilizationDropCount[];
  readonly containers: readonly CivilizationContainerCount[];
  readonly placedOakPlanks: readonly BlockPosition[];
}

export interface CivilizationDeathCargo {
  readonly sequence: bigint;
  readonly atMatchTick: bigint;
  readonly seat: number;
  readonly cause: "death";
  readonly beforeCheckpointSequence: bigint;
  readonly oakLogs: number;
  readonly oakPlanks: number;
  readonly droppedOakLogs: number;
  readonly droppedOakPlanks: number;
}

export type CivilizationMaterialRecord =
  | Readonly<{ kind: "checkpoint"; checkpoint: CivilizationMaterialCheckpoint }>
  | Readonly<{ kind: "death_cargo"; death: CivilizationDeathCargo }>;

export interface CivilizationMaterialBaseline {
  readonly naturalOakLogSources: readonly BlockPosition[];
  readonly initialStock: CivilizationMaterialCounts;
  readonly containerPositions: readonly BlockPosition[];
}

export function parseCivilizationMaterialLog(log: string, expectedRunId: string): readonly CivilizationMaterialRecord[] {
  if (expectedRunId.length === 0) throw new Error("civilization material log requires the owned run id");

  const records: CivilizationMaterialRecord[] = [];
  let previousSequence = 0n;
  let previousTick = 0n;
  let previousCheckpointTick = -1n;
  let lastCheckpointSequence: bigint | undefined;
  let previousCheckpoint: CivilizationMaterialCheckpoint | undefined;
  let pendingDeathTick: bigint | undefined;
  for (const [index, rawLine] of log.split(/\n/).entries()) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const recordPrefix = SERVER_RECORD_PREFIX.exec(line);
    if (recordPrefix === null) continue;
    const message = line.slice(recordPrefix[0].length);
    if (!message.startsWith(MARKER_NAME)) continue;
    if (!message.startsWith(MARKER_PREFIX)) {
      throw new Error(`civilization material marker line ${index + 1} has an invalid prefix`);
    }
    if (Buffer.byteLength(message, "utf8") > MAX_MARKER_LINE_BYTES) {
      throw new Error(`civilization material marker line ${index + 1} exceeds the 16 KiB record limit`);
    }
    if (records.length >= MAX_MARKER_RECORDS) {
      throw new Error("civilization material marker record limit exceeded; evidence is incomplete");
    }

    const payload = parseJsonObject(message.slice(MARKER_PREFIX.length), `marker line ${index + 1}`);
    const record = parseMarker(payload, expectedRunId, `marker line ${index + 1}`);
    const sequence = record.kind === "checkpoint" ? record.checkpoint.sequence : record.death.sequence;
    const atMatchTick = record.kind === "checkpoint" ? record.checkpoint.atMatchTick : record.death.atMatchTick;
    if (sequence !== previousSequence + 1n) {
      throw new Error(`civilization material marker sequence is not contiguous at line ${index + 1}`);
    }
    if (atMatchTick < previousTick) {
      throw new Error(`civilization material marker ticks move backwards at line ${index + 1}`);
    }
    if (records.length === 0 && (record.kind !== "checkpoint" || atMatchTick !== 0n)) {
      throw new Error("civilization material log must begin with the tick-zero checkpoint");
    }
    if (record.kind === "checkpoint") {
      if (atMatchTick < previousCheckpointTick
        || (atMatchTick === previousCheckpointTick && pendingDeathTick === undefined)) {
        throw new Error(`civilization material checkpoints are not in increasing tick order at line ${index + 1}`);
      }
      if (pendingDeathTick !== undefined && pendingDeathTick !== atMatchTick) {
        throw new Error(`post-death checkpoint does not match the pending death tick at line ${index + 1}`);
      }
      if (pendingDeathTick === undefined && previousCheckpoint !== undefined
        && materialStateKey(previousCheckpoint) === materialStateKey(record.checkpoint)) {
        throw new Error(`civilization material checkpoint is unchanged at line ${index + 1}`);
      }
      previousCheckpointTick = atMatchTick;
      lastCheckpointSequence = sequence;
      previousCheckpoint = record.checkpoint;
      pendingDeathTick = undefined;
    } else {
      if (record.death.beforeCheckpointSequence !== lastCheckpointSequence) {
        throw new Error(`death cargo marker does not reference the latest prior checkpoint at line ${index + 1}`);
      }
      if (pendingDeathTick !== undefined && pendingDeathTick !== atMatchTick) {
        throw new Error(`death cargo marker precedes the pending death checkpoint at line ${index + 1}`);
      }
      pendingDeathTick = atMatchTick;
    }

    previousSequence = sequence;
    previousTick = atMatchTick;
    records.push(record);
  }

  if (records.length === 0) throw new Error("civilization material log contains no server marker records");
  if (pendingDeathTick !== undefined) throw new Error("civilization death cargo has no same-tick end-of-tick checkpoint");
  return Object.freeze(records);
}

export function assertCivilizationMaterialConservation(
  checkpoints: readonly CivilizationMaterialCheckpoint[],
  baseline: CivilizationMaterialBaseline,
): void {
  assertMaterialConservation(checkpoints, baseline, new Set<bigint>());
}

function assertMaterialConservation(
  checkpoints: readonly CivilizationMaterialCheckpoint[],
  baseline: CivilizationMaterialBaseline,
  postDeathCheckpointSequences: ReadonlySet<bigint>,
): void {
  if (checkpoints.length === 0) throw new Error("material conservation requires the initial server checkpoint");
  validateBaseline(baseline);
  const first = checkpoints[0];
  if (first === undefined || first.atMatchTick !== 0n) {
    throw new Error("material conservation requires the tick-zero initial checkpoint");
  }
  if (!samePositionSet(first.remainingNaturalOakLogs, baseline.naturalOakLogSources)) {
    throw new Error("tick-zero natural log sources do not match the prepared map");
  }

  const sourcePositions = uniquePositions(baseline.naturalOakLogSources, "prepared map natural log sources");
  const initialUnits = BigInt(sourcePositions.size) * 4n
    + BigInt(baseline.initialStock.oakLogs) * 4n
    + BigInt(baseline.initialStock.oakPlanks);
  let previousTick = -1n;
  let previousSources = sourcePositions;
  let previousSequence = 0n;
  let previousCheckpoint: CivilizationMaterialCheckpoint | undefined;

  for (const [index, checkpoint] of checkpoints.entries()) {
    validateCheckpoint(checkpoint, index, baseline);
    if (checkpoint.sequence <= previousSequence) {
      throw new Error(`material checkpoint sequences are not strictly increasing at index ${index}`);
    }
    if (checkpoint.atMatchTick < previousTick
      || (checkpoint.atMatchTick === previousTick && !postDeathCheckpointSequences.has(checkpoint.sequence))) {
      throw new Error(`material checkpoints are not in increasing match-tick order at index ${index}`);
    }
    if (previousCheckpoint !== undefined && materialStateKey(previousCheckpoint) === materialStateKey(checkpoint)
      && !postDeathCheckpointSequences.has(checkpoint.sequence)) {
      throw new Error(`material checkpoint ${index} is unchanged from its predecessor`);
    }
    previousTick = checkpoint.atMatchTick;

    const remainingSources = uniquePositions(checkpoint.remainingNaturalOakLogs,
      `checkpoint ${index} natural log sources`);
    for (const position of remainingSources) {
      if (!sourcePositions.has(position)) {
        throw new Error(`checkpoint ${index} contains a natural log source absent from the prepared map`);
      }
      if (!previousSources.has(position)) {
        throw new Error(`checkpoint ${index} restores a removed natural log source`);
      }
    }

    const expectedUnits = initialUnits;
    const observedUnits = materialUnits(checkpoint);
    if (observedUnits !== expectedUnits) {
      throw new Error(
        `checkpoint ${index} has ${observedUnits} wood units; expected the fixed-map baseline of ${expectedUnits}`,
      );
    }
    previousSources = remainingSources;
    previousSequence = checkpoint.sequence;
    previousCheckpoint = checkpoint;
  }
}

export function assertCivilizationOutpostsPresent(
  checkpoint: CivilizationMaterialCheckpoint,
  outpostPositions: readonly BlockPosition[],
): void {
  if (outpostPositions.length !== 30) {
    throw new Error("civilization outpost evidence requires the thirty declared blueprint positions");
  }
  assertCivilizationPlacedPositionsPresent(checkpoint, outpostPositions, "the two complete outposts");
}

export function assertCivilizationPlacedPositionsPresent(
  checkpoint: CivilizationMaterialCheckpoint,
  expectedPositions: readonly BlockPosition[],
  description: string,
): void {
  if (expectedPositions.length === 0) throw new Error("civilization placed-position evidence cannot be empty");
  const placedPositions = uniquePositions(checkpoint.placedOakPlanks, "checkpoint placed oak planks");
  const expected = uniquePositions(expectedPositions, "declared outpost blueprint positions");
  if (expected.size !== expectedPositions.length || [...expected].some((position) => !placedPositions.has(position))) {
    throw new Error(`authoritative placed-plank census is missing cells from ${description}`);
  }
}

export function assertCivilizationCargoDeaths(
  records: readonly CivilizationMaterialRecord[],
  events: readonly RuntimeAuthorityEvent[],
  baseline: CivilizationMaterialBaseline,
): void {
  const checkpoints = records.flatMap((record) => record.kind === "checkpoint" ? [record.checkpoint] : []);
  const deaths = records.flatMap((record) => record.kind === "death_cargo" ? [record.death] : []);
  if (deaths.length === 0) throw new Error("civilization cargo evidence requires an ordinary death cargo marker");
  const postDeathCheckpointSequences = new Set<bigint>();
  for (const death of deaths) {
    const after = checkpoints.find(({ sequence }) => sequence > death.sequence);
    if (after === undefined || after.atMatchTick !== death.atMatchTick) {
      throw new Error("death cargo marker must be followed by its same-tick end-of-tick material checkpoint");
    }
    postDeathCheckpointSequences.add(after.sequence);
  }
  assertMaterialConservation(checkpoints, baseline, postDeathCheckpointSequences);

  const markerDeaths = new Set<string>();
  for (const death of deaths) {
    const deathKey = `${death.atMatchTick}:${death.seat}`;
    if (markerDeaths.has(deathKey)) throw new Error("civilization log repeats a death cargo marker");
    markerDeaths.add(deathKey);
    const before = checkpoints.find(({ sequence }) => sequence === death.beforeCheckpointSequence);
    if (before === undefined || before.sequence >= death.sequence || before.atMatchTick > death.atMatchTick) {
      throw new Error("death cargo marker must follow an earlier material checkpoint");
    }
    const after = checkpoints.find(({ sequence }) => sequence > death.sequence);
    if (after === undefined || after.atMatchTick !== death.atMatchTick) {
      throw new Error("death cargo marker must be followed by its same-tick end-of-tick material checkpoint");
    }
    validateDeathCargo(death);
    if (death.droppedOakLogs !== death.oakLogs || death.droppedOakPlanks !== death.oakPlanks) {
      throw new Error("death event dropped stacks do not match the victim's actual tracked cargo");
    }
    const victimAfter = inventoryForSeat(after, death.seat);
    if (victimAfter.oakLogs !== 0 || victimAfter.oakPlanks !== 0) {
      throw new Error("a dead competitor must not retain tracked cargo in the next checkpoint");
    }

    const eventIndex = events.findIndex((event) => event.type === "elimination"
      && event.payload.at.domain === "match" && event.payload.at.value === death.atMatchTick
      && event.payload.eliminations.some(({ seat, cause }) => seat === death.seat && cause === "death"));
    if (eventIndex === -1) throw new Error("death cargo marker has no matching authoritative death elimination");
  }

  const eventDeaths = new Set<string>();
  for (const event of events) {
    if (event.type !== "elimination" || event.payload.at.domain !== "match") continue;
    for (const { seat, cause } of event.payload.eliminations) {
      if (cause !== "death") continue;
      const deathKey = `${event.payload.at.value}:${seat}`;
      if (eventDeaths.has(deathKey)) throw new Error("authoritative event stream repeats an ordinary death");
      eventDeaths.add(deathKey);
    }
  }
  if (eventDeaths.size !== markerDeaths.size || [...eventDeaths].some((death) => !markerDeaths.has(death))) {
    throw new Error("ordinary death events and civilization cargo markers do not match");
  }
}

function parseMarker(payload: Record<string, unknown>, expectedRunId: string, source: string): CivilizationMaterialRecord {
  if (payload.run_id !== expectedRunId) throw new Error(`${source} belongs to a different run`);
  const sequence = decimalBigInt(payload.sequence, `${source}.sequence`);
  const atMatchTick = decimalBigInt(payload.match_tick, `${source}.match_tick`);
  if (payload.kind === "checkpoint") {
    assertKeys(payload, ["kind", "run_id", "sequence", "match_tick", "natural_log_positions", "inventories",
      "item_entities", "containers", "placed_oak_planks"], source);
    const inventories = arrayValue(payload.inventories, `${source}.inventories`).map((value, index) => {
      const inventory = objectValue(value, `${source}.inventories[${index}]`);
      assertKeys(inventory, ["seat", "oak_logs", "oak_planks"], `${source}.inventories[${index}]`);
      const seat = integerValue(inventory.seat, `${source}.inventories[${index}].seat`, 0, 5);
      if (seat !== index) throw new Error(`${source}.inventories must list seats zero through five in order`);
      return Object.freeze({
        seat,
        oakLogs: integerValue(inventory.oak_logs, `${source}.inventories[${index}].oak_logs`),
        oakPlanks: integerValue(inventory.oak_planks, `${source}.inventories[${index}].oak_planks`),
      });
    });
    if (inventories.length !== 6) throw new Error(`${source}.inventories must contain all six competitor seats`);
    let previousEntityId: string | undefined;
    const itemEntities = arrayValue(payload.item_entities, `${source}.item_entities`).map((value, index) => {
      const entity = objectValue(value, `${source}.item_entities[${index}]`);
      assertKeys(entity, ["entity_id", "oak_logs", "oak_planks"], `${source}.item_entities[${index}]`);
      const entityId = entity.entity_id;
      if (typeof entityId !== "string" || !isCanonicalUuid(entityId)) {
        throw new Error(`${source}.item_entities[${index}].entity_id must be a canonical UUID string`);
      }
      const oakLogs = integerValue(entity.oak_logs, `${source}.item_entities[${index}].oak_logs`);
      const oakPlanks = integerValue(entity.oak_planks, `${source}.item_entities[${index}].oak_planks`);
      if (oakLogs === 0 && oakPlanks === 0) {
        throw new Error(`${source}.item_entities[${index}] must contain tracked material`);
      }
      if (previousEntityId !== undefined && previousEntityId >= entityId) {
        throw new Error(`${source}.item_entities must be uniquely sorted by entity id`);
      }
      previousEntityId = entityId;
      return Object.freeze({
        entityId,
        oakLogs,
        oakPlanks,
      });
    });
    let previousContainerPosition: BlockPosition | undefined;
    const containers = arrayValue(payload.containers, `${source}.containers`).map((value, index) => {
      const container = objectValue(value, `${source}.containers[${index}]`);
      assertKeys(container, ["position", "oak_logs", "oak_planks"], `${source}.containers[${index}]`);
      const position = blockPositionValue(container.position, `${source}.containers[${index}].position`);
      if (previousContainerPosition !== undefined && comparePositions(previousContainerPosition, position) >= 0) {
        throw new Error(`${source}.containers must be uniquely sorted by block position`);
      }
      previousContainerPosition = position;
      return Object.freeze({
        position,
        oakLogs: integerValue(container.oak_logs, `${source}.containers[${index}].oak_logs`),
        oakPlanks: integerValue(container.oak_planks, `${source}.containers[${index}].oak_planks`),
      });
    });
    return Object.freeze({
      kind: "checkpoint",
      checkpoint: Object.freeze({
        sequence,
        atMatchTick,
        remainingNaturalOakLogs: Object.freeze(positionArray(payload.natural_log_positions, `${source}.natural_log_positions`)),
        inventories: Object.freeze(inventories),
        itemEntities: Object.freeze(itemEntities),
        containers: Object.freeze(containers),
        placedOakPlanks: Object.freeze(positionArray(payload.placed_oak_planks, `${source}.placed_oak_planks`)),
      }),
    });
  }
  if (payload.kind === "death_cargo") {
    assertKeys(payload, ["kind", "run_id", "sequence", "match_tick", "seat", "cause",
      "before_checkpoint_sequence", "oak_logs", "oak_planks", "dropped_oak_logs", "dropped_oak_planks"], source);
    if (payload.cause !== "death") throw new Error(`${source}.cause must be death`);
    return Object.freeze({
      kind: "death_cargo",
      death: Object.freeze({
        sequence,
        atMatchTick,
        seat: integerValue(payload.seat, `${source}.seat`, 0, 5),
        cause: "death",
        beforeCheckpointSequence: decimalBigInt(payload.before_checkpoint_sequence, `${source}.before_checkpoint_sequence`),
        oakLogs: integerValue(payload.oak_logs, `${source}.oak_logs`),
        oakPlanks: integerValue(payload.oak_planks, `${source}.oak_planks`),
        droppedOakLogs: integerValue(payload.dropped_oak_logs, `${source}.dropped_oak_logs`),
        droppedOakPlanks: integerValue(payload.dropped_oak_planks, `${source}.dropped_oak_planks`),
      }),
    });
  }
  throw new Error(`${source}.kind is not a supported civilization material record`);
}

function validateBaseline(baseline: CivilizationMaterialBaseline): void {
  const sourcePositions = uniquePositions(baseline.naturalOakLogSources, "prepared map natural log sources");
  if (sourcePositions.size === 0) throw new Error("prepared map must declare at least one natural oak log source");
  const containerPositions = uniquePositions(baseline.containerPositions, "prepared map container positions");
  if (containerPositions.size === 0) throw new Error("prepared map must declare the tracked containers");
  validateCounts(baseline.initialStock, "prepared scenario initial wood stock");
}

function validateCheckpoint(
  checkpoint: CivilizationMaterialCheckpoint,
  index: number,
  baseline: CivilizationMaterialBaseline,
): void {
  if (checkpoint.sequence <= 0n || checkpoint.atMatchTick < 0n) {
    throw new RangeError(`checkpoint ${index} has a nonpositive sequence or negative match tick`);
  }

  const seats = new Set<number>();
  for (const [seatIndex, inventory] of checkpoint.inventories.entries()) {
    if (!Number.isSafeInteger(inventory.seat) || inventory.seat < 0 || inventory.seat > 5
      || seats.has(inventory.seat) || inventory.seat !== seatIndex) {
      throw new Error(`checkpoint ${index} has an invalid or repeated inventory seat`);
    }
    seats.add(inventory.seat);
    validateCounts(inventory, `checkpoint ${index} seat ${inventory.seat}`);
  }
  if (seats.size !== 6) throw new Error(`checkpoint ${index} must include all six competitor inventories`);

  const dropIds = new Set<string>();
  for (const drop of checkpoint.itemEntities) {
    if (!isCanonicalUuid(drop.entityId) || dropIds.has(drop.entityId)) {
      throw new Error(`checkpoint ${index} has an invalid or repeated item entity id`);
    }
    dropIds.add(drop.entityId);
    validateCounts(drop, `checkpoint ${index} item entity ${drop.entityId}`);
  }

  if (!samePositionSet(checkpoint.containers.map(({ position }) => position), baseline.containerPositions)) {
    throw new Error(`checkpoint ${index} containers do not match the prepared map`);
  }
  for (const container of checkpoint.containers) validateCounts(container, `checkpoint ${index} container`);
  uniquePositions(checkpoint.placedOakPlanks, `checkpoint ${index} placed oak planks`);
  assertSortedUniquePositions(checkpoint.placedOakPlanks, `checkpoint ${index} placed oak planks`);
  assertSortedUniquePositions(checkpoint.remainingNaturalOakLogs, `checkpoint ${index} natural log sources`);
  let previousEntityId: string | undefined;
  for (const entity of checkpoint.itemEntities) {
    if (!isCanonicalUuid(entity.entityId) || (entity.oakLogs === 0 && entity.oakPlanks === 0)) {
      throw new Error(`checkpoint ${index} includes an invalid tracked item entity`);
    }
    if (previousEntityId !== undefined && previousEntityId >= entity.entityId) {
      throw new Error(`checkpoint ${index} item entities are not uniquely sorted by id`);
    }
    previousEntityId = entity.entityId;
  }
  const containers = checkpoint.containers.map(({ position }) => position);
  assertSortedUniquePositions(containers, `checkpoint ${index} containers`);
}

function validateDeathCargo(death: CivilizationDeathCargo): void {
  if (death.sequence <= 0n || death.atMatchTick < 0n || death.beforeCheckpointSequence <= 0n
    || !Number.isSafeInteger(death.seat) || death.seat < 0 || death.seat > 5) {
    throw new RangeError("death cargo receipt has an invalid sequence, tick, or seat");
  }
  validateCounts({ oakLogs: death.oakLogs, oakPlanks: death.oakPlanks }, "death cargo");
  validateCounts({ oakLogs: death.droppedOakLogs, oakPlanks: death.droppedOakPlanks }, "death event dropped stacks");
}

function materialUnits(checkpoint: CivilizationMaterialCheckpoint): bigint {
  const counts = [...checkpoint.inventories, ...checkpoint.itemEntities, ...checkpoint.containers];
  let units = 0n;
  for (const count of counts) {
    validateCounts(count, "material checkpoint");
    units += BigInt(count.oakLogs) * 4n + BigInt(count.oakPlanks);
  }
  return units
    + BigInt(checkpoint.remainingNaturalOakLogs.length) * 4n
    + BigInt(checkpoint.placedOakPlanks.length);
}

function materialStateKey(checkpoint: CivilizationMaterialCheckpoint): string {
  return JSON.stringify([
    checkpoint.remainingNaturalOakLogs.map(positionKey),
    checkpoint.inventories.map(({ seat, oakLogs, oakPlanks }) => [seat, oakLogs, oakPlanks]),
    checkpoint.itemEntities.map(({ entityId, oakLogs, oakPlanks }) => [entityId, oakLogs, oakPlanks]),
    checkpoint.containers.map(({ position, oakLogs, oakPlanks }) => [positionKey(position), oakLogs, oakPlanks]),
    checkpoint.placedOakPlanks.map(positionKey),
  ]);
}

function positionKey(position: BlockPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

function inventoryForSeat(checkpoint: CivilizationMaterialCheckpoint, seat: number): CivilizationInventoryCount {
  const inventory = checkpoint.inventories.find((candidate) => candidate.seat === seat);
  if (inventory === undefined) throw new Error(`checkpoint has no inventory for seat ${seat}`);
  return inventory;
}

function validateCounts(counts: CivilizationMaterialCounts, source: string): void {
  for (const [item, count] of [["oak logs", counts.oakLogs], ["oak planks", counts.oakPlanks]] as const) {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`${source} has an invalid ${item} count`);
  }
}

function samePositionSet(first: readonly BlockPosition[], second: readonly BlockPosition[]): boolean {
  const firstKeys = uniquePositions(first, "material block positions");
  const secondKeys = uniquePositions(second, "expected material block positions");
  return firstKeys.size === secondKeys.size && [...firstKeys].every((position) => secondKeys.has(position));
}

function uniquePositions(positions: readonly BlockPosition[], source: string): Set<string> {
  const keys = new Set<string>();
  for (const position of positions) {
    if (![position.x, position.y, position.z].every(Number.isSafeInteger)) {
      throw new RangeError(`${source} contains an invalid block position`);
    }
    const key = `${position.x},${position.y},${position.z}`;
    if (keys.has(key)) throw new Error(`${source} contains a duplicate block position`);
    keys.add(key);
  }
  return keys;
}

function parseJsonObject(value: string, source: string): Record<string, unknown> {
  assertNoDuplicateJsonKeys(value, source);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${source} contains malformed or truncated JSON`);
  }
  return objectValue(parsed, source);
}

function assertNoDuplicateJsonKeys(value: string, source: string): void {
  const objects: Set<string>[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      const start = index;
      let escaped = false;
      for (index += 1; index < value.length; index += 1) {
        const next = value[index];
        if (escaped) escaped = false;
        else if (next === "\\") escaped = true;
        else if (next === '"') break;
      }
      if (index >= value.length) return;
      const literal = value.slice(start, index + 1);
      let nextIndex = index + 1;
      while (/\s/.test(value[nextIndex] ?? "")) nextIndex += 1;
      if (value[nextIndex] === ":") {
        const objectKeys = objects.at(-1);
        if (objectKeys === undefined) continue;
        let key: string;
        try {
          key = JSON.parse(literal) as string;
        } catch {
          return;
        }
        if (objectKeys.has(key)) throw new Error(`${source} contains a repeated JSON key`);
        objectKeys.add(key);
      }
      continue;
    }
    if (character === "{") objects.push(new Set());
    else if (character === "}") objects.pop();
  }
}

function objectValue(value: unknown, source: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, expected: readonly string[], source: string): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${source} has missing or unsupported keys`);
  }
}

function arrayValue(value: unknown, source: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${source} must be an array`);
  return value;
}

function positionArray(value: unknown, source: string): BlockPosition[] {
  const positions = arrayValue(value, source).map((position, index) => blockPositionValue(position, `${source}[${index}]`));
  assertSortedUniquePositions(positions, source);
  return positions;
}

function assertSortedUniquePositions(positions: readonly BlockPosition[], source: string): void {
  for (let index = 1; index < positions.length; index += 1) {
    if (comparePositions(positions[index - 1]!, positions[index]!) >= 0) {
      throw new Error(`${source} must be uniquely sorted by block position`);
    }
  }
}

function comparePositions(first: BlockPosition, second: BlockPosition): number {
  return first.x - second.x || first.y - second.y || first.z - second.z;
}

function blockPositionValue(value: unknown, source: string): BlockPosition {
  const position = objectValue(value, source);
  assertKeys(position, ["x", "y", "z"], source);
  return Object.freeze({
    x: integerValue(position.x, `${source}.x`, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    y: integerValue(position.y, `${source}.y`, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    z: integerValue(position.z, `${source}.z`, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
  });
}

function integerValue(value: unknown, source: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new RangeError(`${source} must be a safe integer between ${min} and ${max}`);
  }
  return value as number;
}

function decimalBigInt(value: unknown, source: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${source} must be a canonical nonnegative decimal string`);
  }
  return BigInt(value);
}

function isCanonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
