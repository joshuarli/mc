import assert from "node:assert/strict";
import test from "node:test";
import { blockPosition } from "@arena/core";
import type { RuntimeAuthorityEvent } from "../../packages/arena-runner/src/runtime/types.js";

import {
  assertCivilizationCargoDeaths,
  assertCivilizationMaterialConservation,
  assertCivilizationOutpostsPresent,
  parseCivilizationMaterialLog,
  type CivilizationMaterialBaseline,
  type CivilizationMaterialCheckpoint,
  type CivilizationMaterialRecord,
} from "./civilization-material-evidence.js";

test("civilization material log accepts complete server markers for one run", () => {
  const records = parseCivilizationMaterialLog(logFor([checkpointMarker(1, 0), checkpointMarker(2, 1)]), "run-1");

  assert.equal(records.length, 2);
  assert.equal(records[0]?.kind, "checkpoint");
  assert.equal(records[1]?.kind, "checkpoint");
});

test("civilization material log rejects malformed, truncated, wrong-run, and extra-key markers", () => {
  assert.throws(() => parseCivilizationMaterialLog(serverLine("{"), "run-1"), /malformed or truncated JSON/);
  assert.throws(() => parseCivilizationMaterialLog(logFor([checkpointMarker(1, 0, "run-2")]), "run-1"), /different run/);

  const extraKey = { ...checkpointMarker(1, 0), ignored: true };
  assert.throws(() => parseCivilizationMaterialLog(logFor([extraKey]), "run-1"), /unsupported keys/);
  const duplicateKey = JSON.stringify(checkpointMarker(1, 0)).replace(
    '"kind":"checkpoint"',
    '"kind":"checkpoint","kind":"checkpoint"',
  );
  assert.throws(() => parseCivilizationMaterialLog(serverLine(duplicateKey), "run-1"), /repeated JSON key/);
  assert.throws(
    () => parseCivilizationMaterialLog(logFor([checkpointMarker(2, 0)]), "run-1"),
    /sequence is not contiguous/,
  );
  assert.throws(
    () => parseCivilizationMaterialLog(logFor([checkpointMarker(1, 1)]), "run-1"),
    /tick-zero checkpoint/,
  );
  assert.throws(
    () => parseCivilizationMaterialLog(logFor([checkpointMarker(1, 0), checkpointMarker(2, 1)]), "run-1"),
    /checkpoint is unchanged/,
  );
  assert.throws(
    () => parseCivilizationMaterialLog(logFor([checkpointMarker(1, 0), deathCargoMarker(2, 0, 1)]), "run-1"),
    /no same-tick end-of-tick checkpoint/,
  );
  assert.throws(
    () => parseCivilizationMaterialLog(logFor([
      checkpointMarker(1, 0),
      deathCargoMarker(2, 0, 1),
      checkpointMarker(3, 2),
    ]), "run-1"),
    /does not match the pending death tick/,
  );
  const atRecordCap = Array.from({ length: 257 }, (_, index) => checkpointMarker(index + 1, index, "run-1",
    index === 0 ? [] : [{ entity_id: itemId(index), oak_logs: 0, oak_planks: 1 }]));
  assert.throws(() => parseCivilizationMaterialLog(logFor(atRecordCap), "run-1"), /record limit exceeded/);
});

test("civilization material log rejects marker lines outside the plugin server record", () => {
  const record = JSON.stringify(checkpointMarker(1, 0));
  const playerMessage = `[00:00:00] [Server thread/INFO]: Player: ARENA_CIV_MATERIAL_V1 ${record}`;

  assert.throws(() => parseCivilizationMaterialLog(playerMessage, "run-1"), /no server marker records/);
});

test("civilization material log requires canonical, uniquely sorted item entity UUIDs", () => {
  const firstId = "00000000-0000-0000-0000-000000000001";
  const secondId = "00000000-0000-0000-0000-000000000002";
  const valid = checkpointMarker(1, 0, "run-1", [
    { entity_id: firstId, oak_logs: 1, oak_planks: 0 },
    { entity_id: secondId, oak_logs: 0, oak_planks: 1 },
  ]);
  assert.equal(parseCivilizationMaterialLog(logFor([valid]), "run-1").length, 1);

  const nonCanonical = checkpointMarker(1, 0, "run-1", [
    { entity_id: "item-1", oak_logs: 1, oak_planks: 0 },
  ]);
  assert.throws(() => parseCivilizationMaterialLog(logFor([nonCanonical]), "run-1"), /canonical UUID string/);

  const unsorted = checkpointMarker(1, 0, "run-1", [
    { entity_id: secondId, oak_logs: 1, oak_planks: 0 },
    { entity_id: firstId, oak_logs: 0, oak_planks: 1 },
  ]);
  assert.throws(() => parseCivilizationMaterialLog(logFor([unsorted]), "run-1"), /uniquely sorted by entity id/);
});

test("civilization material log rejects marker records larger than the producer limit", () => {
  const oversized = { ...checkpointMarker(1, 0), padding: "x".repeat(16 * 1024) };
  assert.throws(() => parseCivilizationMaterialLog(logFor([oversized]), "run-1"), /exceeds the 16 KiB record limit/);
});

test("civilization conservation derives its baseline from the exact map sources and initial stock", () => {
  const baseline = materialBaseline();
  const checkpoints = [
    checkpoint(1n, 0n, [position(1)], [], []),
    checkpoint(2n, 1n, [], [{ seat: 0, oakLogs: 1, oakPlanks: 0 }], []),
  ];

  assertCivilizationMaterialConservation(checkpoints, baseline);
  const ordinaryPlacement = {
    ...checkpoint(2n, 1n, [], [{ seat: 0, oakLogs: 0, oakPlanks: 3 }], []),
    placedOakPlanks: [position(99)],
  };
  assertCivilizationMaterialConservation([checkpoints[0]!, ordinaryPlacement], baseline);
  assert.throws(
    () => assertCivilizationMaterialConservation([
      checkpoint(1n, 0n, [position(1), position(1)], [], []),
    ], baseline),
    /duplicate block position/,
  );
  assert.throws(
    () => assertCivilizationMaterialConservation([
      checkpoint(1n, 0n, [position(1)], [], []),
      checkpoint(2n, 1n, [position(1)], [], []),
    ], baseline),
    /unchanged from its predecessor/,
  );
});

test("civilization conservation rejects granted or lost material", () => {
  const baseline = materialBaseline();
  const initial = checkpoint(1n, 0n, [position(1)], [], []);
  const grant = checkpoint(2n, 1n, [], [{ seat: 0, oakLogs: 2, oakPlanks: 0 }], []);
  const loss = checkpoint(2n, 1n, [], [], []);

  assert.throws(
    () => assertCivilizationMaterialConservation([initial, grant], baseline),
    /fixed-map baseline of 4/,
  );
  assert.throws(
    () => assertCivilizationMaterialConservation([initial, loss], baseline),
    /fixed-map baseline of 4/,
  );
});

test("civilization outpost evidence requires all thirty declared planks and allows other placements", () => {
  const positions = Array.from({ length: 30 }, (_, index) => blockPosition(index, 64, 20));
  const complete = { ...checkpoint(4n, 2n, [], [], []), placedOakPlanks: [...positions, position(99)] };

  assertCivilizationOutpostsPresent(complete, positions);
  assert.throws(() => assertCivilizationOutpostsPresent({ ...complete, placedOakPlanks: positions.slice(1) }, positions),
    /missing cells from the two complete outposts/);
});

test("civilization death cargo survives a pickup between checkpoints without a false drop-delta requirement", () => {
  const baseline = materialBaseline();
  const records: CivilizationMaterialRecord[] = [
    { kind: "checkpoint", checkpoint: checkpoint(1n, 0n, [position(1)], [], []) },
    { kind: "checkpoint", checkpoint: checkpoint(2n, 1n, [], [], [{ entityId: itemId(50), oakLogs: 1, oakPlanks: 0 }]) },
    {
      kind: "death_cargo",
      death: {
        sequence: 3n,
        atMatchTick: 2n,
        seat: 0,
        cause: "death",
        beforeCheckpointSequence: 2n,
        oakLogs: 1,
        oakPlanks: 0,
        droppedOakLogs: 1,
        droppedOakPlanks: 0,
      },
    },
    { kind: "checkpoint", checkpoint: checkpoint(4n, 2n, [], [], [{ entityId: itemId(81), oakLogs: 1, oakPlanks: 0 }]) },
  ];
  const events: RuntimeAuthorityEvent[] = [{
    protocol: 1,
    run_id: "run-1",
    sequence: 1n,
    type: "elimination",
    payload: {
      at: { domain: "match", value: 2n },
      eliminations: [{ seat: 0, cause: "death" }],
    },
  }];

  assertCivilizationCargoDeaths(records, events, baseline);
  assert.throws(
    () => assertCivilizationCargoDeaths(records, [], baseline),
    /no matching authoritative death elimination/,
  );
  const mismatchedDrops = records.map((record) => record.kind === "death_cargo"
    ? { ...record, death: { ...record.death, droppedOakLogs: 0 } }
    : record);
  assert.throws(
    () => assertCivilizationCargoDeaths(mismatchedDrops, events, baseline),
    /dropped stacks do not match/,
  );
});

test("civilization death evidence requires an empty dead inventory and every event receipt", () => {
  const baseline = materialBaseline();
  const valid = deathRecords(1, 1);
  const events = [deathEvent(2n)];
  const occupiedInventory = valid.map((record) => record.kind === "checkpoint" && record.checkpoint.sequence === 4n
    ? { ...record, checkpoint: { ...record.checkpoint, inventories: [
      { seat: 0, oakLogs: 1, oakPlanks: 0 }, ...record.checkpoint.inventories.slice(1),
    ], itemEntities: [] } }
    : record);
  assert.throws(() => assertCivilizationCargoDeaths(occupiedInventory, events, baseline), /must not retain tracked cargo/);

  assert.throws(
    () => assertCivilizationCargoDeaths(valid, [deathEvent(2n), deathEvent(3n, 1)], baseline),
    /events and civilization cargo markers do not match/,
  );
});

test("zero-cargo deaths retain an unchanged same-tick checkpoint, including a shared multi-death checkpoint", () => {
  const baseline = materialBaseline();
  const oneDeath = parseCivilizationMaterialLog(logFor([
    checkpointMarker(1, 0),
    deathCargoMarker(2, 0, 0),
    checkpointMarker(3, 0, "run-1", [], [position(1)]),
  ]), "run-1");
  assertCivilizationCargoDeaths(oneDeath, [deathEvent(0n)], baseline);

  const twoDeaths = parseCivilizationMaterialLog(logFor([
    checkpointMarker(1, 0),
    deathCargoMarker(2, 0, 1),
    deathCargoMarker(3, 1, 1),
    checkpointMarker(4, 1, "run-1", [], [position(1)]),
  ]), "run-1");
  assertCivilizationCargoDeaths(twoDeaths, [deathBatchEvent(1n, [0, 1])], baseline);
});

function materialBaseline(): CivilizationMaterialBaseline {
  return {
    naturalOakLogSources: [position(1)],
    initialStock: { oakLogs: 0, oakPlanks: 0 },
    containerPositions: [blockPosition(10, 64, 10), blockPosition(20, 64, 20)],
  };
}

function checkpoint(
  sequence: bigint,
  tick: bigint,
  remaining: readonly ReturnType<typeof position>[],
  inventory: readonly Readonly<{ seat: number; oakLogs: number; oakPlanks: number }>[],
  drops: readonly Readonly<{ entityId: string; oakLogs: number; oakPlanks: number }>[],
): CivilizationMaterialCheckpoint {
  const bySeat = new Map(inventory.map((count) => [count.seat, count]));
  return {
    sequence,
    atMatchTick: tick,
    remainingNaturalOakLogs: remaining,
    inventories: Array.from({ length: 6 }, (_, seat) => bySeat.get(seat) ?? { seat, oakLogs: 0, oakPlanks: 0 }),
    itemEntities: drops,
    containers: materialBaseline().containerPositions.map((containerPosition) => ({
      position: containerPosition,
      oakLogs: 0,
      oakPlanks: 0,
    })),
    placedOakPlanks: [],
  };
}

function deathRecords(oakLogs: number, droppedOakLogs: number): CivilizationMaterialRecord[] {
  return [
    { kind: "checkpoint", checkpoint: checkpoint(1n, 0n, [position(1)], [], []) },
    { kind: "checkpoint", checkpoint: checkpoint(2n, 1n, [], [], [{ entityId: itemId(50), oakLogs: 1, oakPlanks: 0 }]) },
    { kind: "death_cargo", death: {
      sequence: 3n,
      atMatchTick: 2n,
      seat: 0,
      cause: "death",
      beforeCheckpointSequence: 2n,
      oakLogs,
      oakPlanks: 0,
      droppedOakLogs,
      droppedOakPlanks: 0,
    } },
    { kind: "checkpoint", checkpoint: checkpoint(4n, 2n, [], [], [{ entityId: itemId(81), oakLogs: 1, oakPlanks: 0 }]) },
  ];
}

function deathEvent(tick: bigint, seat = 0, sequence = 1): RuntimeAuthorityEvent {
  return {
    protocol: 1,
    run_id: "run-1",
    sequence: BigInt(sequence),
    type: "elimination",
    payload: { at: { domain: "match", value: tick }, eliminations: [{ seat, cause: "death" }] },
  };
}

function deathBatchEvent(tick: bigint, seats: readonly number[]): RuntimeAuthorityEvent {
  return {
    protocol: 1,
    run_id: "run-1",
    sequence: 1n,
    type: "elimination",
    payload: {
      at: { domain: "match", value: tick },
      eliminations: seats.map((seat) => ({ seat, cause: "death" as const })),
    },
  };
}

function checkpointMarker(
  sequence: number,
  tick: number,
  runId = "run-1",
  itemEntities: readonly unknown[] = [],
  naturalLogPositions: readonly ReturnType<typeof position>[] = tick === 0 ? [position(1)] : [],
) {
  return {
    kind: "checkpoint",
    run_id: runId,
    sequence: String(sequence),
    match_tick: String(tick),
    natural_log_positions: naturalLogPositions,
    inventories: Array.from({ length: 6 }, (_, seat) => ({ seat, oak_logs: 0, oak_planks: 0 })),
    item_entities: itemEntities,
    containers: materialBaseline().containerPositions.map((containerPosition) => ({
      position: containerPosition,
      oak_logs: 0,
      oak_planks: 0,
    })),
    placed_oak_planks: [],
  };
}

function deathCargoMarker(sequence: number, seat: number, tick: number) {
  return {
    kind: "death_cargo",
    run_id: "run-1",
    sequence: String(sequence),
    match_tick: String(tick),
    seat,
    cause: "death",
    before_checkpoint_sequence: "1",
    oak_logs: 0,
    oak_planks: 0,
    dropped_oak_logs: 0,
    dropped_oak_planks: 0,
  };
}

function logFor(records: readonly unknown[]): string {
  return records.map((record) => serverLine(JSON.stringify(record))).join("\n");
}

function serverLine(payload: string): string {
  return `[00:00:00] [Server thread/INFO]: [ArenaFoundation] ARENA_CIV_MATERIAL_V1|${payload}`;
}

function position(x: number) {
  return blockPosition(x, 64, 10);
}

function itemId(suffix: number): string {
  return `00000000-0000-0000-0000-${suffix.toString(16).padStart(12, "0")}`;
}
