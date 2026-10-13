import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { blockPosition } from "@arena/core";
import {
  GameMode,
  SpecError,
  SpecErrorKind,
  MAX_SOURCE_BYTES,
  compileMap,
  compileScenario,
  scenarioMapReference,
} from "../src/index.js";

const HUNGER = readRepoFile("scenarios/hunger-six.toml");
const HUNGER_MAP = readRepoFile("maps/hunger-six.toml");
const DUEL = readRepoFile("scenarios/duel.toml");
const DUEL_MAP = readRepoFile("maps/duel.toml");
const UNKNOWN_OPERATION = readRepoFile("fixtures/spec/unknown-operation.toml");
const UNKNOWN_FIELD = readRepoFile("fixtures/spec/unknown-field.toml");

test("scenario_v1_compiles_hunger_six_and_duel", () => {
  const hunger = compileScenario(HUNGER, HUNGER_MAP);
  assert.equal(hunger.mode, GameMode.HungerGames);
  assert.equal(hunger.roster.competitors, 6);
  assert.equal(hunger.map.spawns.length, 6);
  assert.equal(hunger.map.lootContainers.length, 4);
  assert.equal(hunger.map.blocks.length, 16_384 + 14);
  assert.equal(hunger.server.minecraft, "26.1.2");

  const duel = compileScenario(DUEL, DUEL_MAP);
  assert.equal(duel.roster.competitors, 2);
  assert.equal(duel.map.spawns.length, 2);
  assert.equal(duel.map.lootContainers.length, 2);
  assert.equal(duel.seed, 88_172_645_463_325_252n);
  assert.notEqual(hunger.semanticId, duel.semanticId);
});

test("scenario_map_reference_is_available_before_loading_map_source", () => {
  assert.equal(scenarioMapReference(HUNGER), "../maps/hunger-six.toml");
  const invalid = specError(() => scenarioMapReference(`unknown = true\n${HUNGER}`));
  assert.equal(invalid.kind, SpecErrorKind.UnknownField);
  assert.equal(invalid.path, "scenario.unknown");
});

test("semantic_ids_ignore_toml_layout_and_labels_but_cover_world_content", () => {
  const baseline = compileScenario(HUNGER, HUNGER_MAP);
  const layoutVariant = HUNGER
    .replace('map = "../maps/hunger-six.toml"', 'map = "../maps/./hunger-six.toml"')
    .replace('policy = "../policies/baseline.toml"', 'policy = "../policies/./baseline.toml"');
  const renamedMap = HUNGER_MAP.replace('name = "hunger-six"', 'name = "arena-alias"');
  const equivalent = compileScenario(layoutVariant, renamedMap);
  assert.equal(baseline.semanticId, equivalent.semanticId);

  const changedWorld = HUNGER_MAP.replace('block = "minecraft:stone"', 'block = "minecraft:dirt"');
  const changed = compileScenario(HUNGER, changedWorld);
  assert.notEqual(baseline.semanticId, changed.semanticId);
  assert.match(baseline.semanticId, /^[0-9a-f]{64}$/);
});

test("scenario_compiler_rejects_unknown_fields_enums_and_invalid_ranges", () => {
  const unknownField = specError(() => compileScenario(`unknown = true\n${HUNGER}`, HUNGER_MAP));
  assert.equal(unknownField.kind, SpecErrorKind.UnknownField);
  assert.equal(unknownField.path, "scenario.unknown");

  const unknownMode = specError(() => compileScenario(HUNGER.replace('mode = "hunger_games"', 'mode = "survival"'), HUNGER_MAP));
  assert.equal(unknownMode.kind, SpecErrorKind.InvalidValue);
  assert.equal(unknownMode.path, "scenario.mode");

  const invalidBorder = specError(() => compileScenario(HUNGER.replace("shrink_end_tick = 6000", "shrink_end_tick = 1200"), HUNGER_MAP));
  assert.equal(invalidBorder.kind, SpecErrorKind.Range);
  assert.equal(invalidBorder.path, "scenario.border.shrink_end_tick");

  const borderFinishesAtLimit = specError(() => compileScenario(HUNGER.replace("shrink_end_tick = 6000", "shrink_end_tick = 7200"), HUNGER_MAP));
  assert.equal(borderFinishesAtLimit.kind, SpecErrorKind.Range);
  assert.equal(borderFinishesAtLimit.path, "scenario.border.shrink_end_tick");

  const overflow = specError(() => compileScenario(HUNGER.replace("seed = 481516", "seed = 9223372036854775808"), HUNGER_MAP));
  assert.equal(overflow.kind, SpecErrorKind.Syntax);
});

test("map_compiler_rejects_unknown_schema_fields_operations_and_coordinate_overflow", () => {
  const unknownField = specError(() => compileMap(UNKNOWN_FIELD));
  assert.equal(unknownField.kind, SpecErrorKind.UnknownField);
  assert.equal(unknownField.path, "map.palette");
  assert.deepEqual(unknownField.sourceLocation, { line: 3, column: 1 });
  assert.equal(unknownField.toString(), "3:1: map.palette: unknown field");

  const unknownOperationField = `
schema = 1
name = "unknown-operation-field"
operations = [
  { kind = "path", position = { x = 0, y = 1, z = 0 }, block = "stone", typo = true }
]
[dimensions]
width = 8
depth = 8
min_y = 0
max_y = 8
`;
  const inlineError = specError(() => compileMap(unknownOperationField));
  assert.equal(inlineError.kind, SpecErrorKind.UnknownField);
  assert.equal(inlineError.path, "map.operations[0].typo");
  assert.equal(inlineError.sourceLocation?.line, 5);
  assert.ok(inlineError.sourceLocation!.column > 1);

  const unknownOperation = specError(() => compileMap(UNKNOWN_OPERATION));
  assert.equal(unknownOperation.kind, SpecErrorKind.InvalidValue);
  assert.equal(unknownOperation.path, "map.operations[0].kind");

  const overflow = specError(() => compileMap(HUNGER_MAP.replace("width = 128", "width = 4294967296")));
  assert.equal(overflow.kind, SpecErrorKind.Range);
  assert.equal(overflow.path, "map.dimensions.width");
});

test("map_compiler_resolves_nested_tables_under_the_current_array_table", () => {
  const nestedTables = `
schema = 1
name = "nested-array-table"

[dimensions]
width = 8
depth = 8
min_y = 0
max_y = 8

[[operations]]
kind = "cuboid"
block = "stone"

[operations.from]
x = 0
y = 1
z = 0

[operations.to]
x = 7
y = 1
z = 7

[[operations]]
kind = "spawn"
seat = 0
position = { x = 1, y = 2, z = 1 }

[[operations]]
kind = "loot_container"
position = { x = 4, y = 2, z = 4 }
inventory = ["bread"]
`;
  const inlineTables = `
schema = 1
name = "nested-array-table"

[dimensions]
width = 8
depth = 8
min_y = 0
max_y = 8

operations = [
  { kind = "cuboid", from = { x = 0, y = 1, z = 0 }, to = { x = 7, y = 1, z = 7 }, block = "stone" },
  { kind = "spawn", seat = 0, position = { x = 1, y = 2, z = 1 } },
  { kind = "loot_container", position = { x = 4, y = 2, z = 4 }, inventory = ["bread"] }
]
`;

  assert.equal(compileMap(nestedTables).semanticId, compileMap(inlineTables).semanticId);
});

test("chest_inventory_limit_matches_cross_language_contracts", () => {
  const maxItems = 27;
  const inventory = Array.from({ length: maxItems }, () => '"minecraft:bread"').join(", ");
  const accepted = HUNGER_MAP.replace(
    'inventory = ["minecraft:bread", "minecraft:stone_sword"]',
    `inventory = [${inventory}]`,
  );
  assert.equal(compileMap(accepted).lootContainers[0].inventory.length, maxItems);

  const overLimit = Array.from({ length: maxItems + 1 }, () => '"minecraft:bread"').join(", ");
  const rejected = HUNGER_MAP.replace(
    'inventory = ["minecraft:bread", "minecraft:stone_sword"]',
    `inventory = [${overLimit}]`,
  );
  const error = specError(() => compileMap(rejected));
  assert.equal(error.kind, SpecErrorKind.ResourceLimit);
  assert.equal(error.path, "map.operations[17].inventory");

  const mapSchema = JSON.parse(readRepoFile("schemas/map.schema.json")) as Record<string, unknown>;
  const worldPlanSchema = JSON.parse(readRepoFile("schemas/world-plan.schema.json")) as Record<string, unknown>;
  assert.ok(JSON.stringify(mapSchema).includes('"maxItems": 27'));
  assert.ok(JSON.stringify(mapSchema).includes('"minItems": 1'));
  assert.ok(JSON.stringify(worldPlanSchema).includes('"maxItems": 27'));
  assert.ok(JSON.stringify(worldPlanSchema).includes('"minItems": 1'));
  assert.ok(readRepoFile("docs/scenarios.md").includes("Loot lists contain 1–27 items"));
});

test("map_block_write_cap_rejects_oversized_cuboids", () => {
  const source = `
schema = 1
name = "oversized-cuboid"

[dimensions]
width = 1000001
depth = 1
min_y = 0
max_y = 2

[[operations]]
kind = "cuboid"
from = { x = 0, y = 0, z = 0 }
to = { x = 1000000, y = 0, z = 0 }
block = "stone"
`;
  const error = specError(() => compileMap(source));
  assert.equal(error.kind, SpecErrorKind.ResourceLimit);
  assert.equal(error.path, "map.operations[0]");
});

test("map_chest_placement_counts_toward_the_block_write_cap", () => {
  const source = `
schema = 1
name = "chest-over-placement-cap"

[dimensions]
width = 1000
depth = 1000
min_y = 0
max_y = 3

[[operations]]
kind = "cuboid"
from = { x = 0, y = 0, z = 0 }
to = { x = 999, y = 0, z = 999 }
block = "stone"

[[operations]]
kind = "spawn"
seat = 0
position = { x = 1, y = 1, z = 1 }

[[operations]]
kind = "loot_container"
position = { x = 4, y = 1, z = 4 }
inventory = ["bread"]
`;
  const error = specError(() => compileMap(source));
  assert.equal(error.kind, SpecErrorKind.ResourceLimit);
});

test("compilers_reject_sources_above_the_utf8_byte_limit", () => {
  assert.equal(MAX_SOURCE_BYTES, 16 * 1024 * 1024);
  const oversized = " ".repeat(MAX_SOURCE_BYTES - 1) + "é";
  assert.equal(oversized.length, MAX_SOURCE_BYTES);
  assert.equal(Buffer.byteLength(oversized), MAX_SOURCE_BYTES + 1);

  const mapError = specError(() => compileMap(oversized));
  assert.equal(mapError.kind, SpecErrorKind.ResourceLimit);
  assert.equal(mapError.path, "map.source");

  const scenarioError = specError(() => compileScenario(oversized, HUNGER_MAP));
  assert.equal(scenarioError.kind, SpecErrorKind.ResourceLimit);
  assert.equal(scenarioError.path, "scenario.source");

  const mapReferenceError = specError(() => compileScenario(HUNGER, oversized));
  assert.equal(mapReferenceError.kind, SpecErrorKind.ResourceLimit);
  assert.equal(mapReferenceError.path, "map.source");
});

test("map_compiler_checks_spawn_support_headroom_and_routes", () => {
  const noHeadroom = `
schema = 1
name = "bad-spawn"
operations = [
  { kind = "cuboid", from = { x = 0, y = 1, z = 0 }, to = { x = 7, y = 1, z = 7 }, block = "stone" },
  { kind = "cuboid", from = { x = 1, y = 3, z = 1 }, to = { x = 1, y = 3, z = 1 }, block = "stone" },
  { kind = "spawn", seat = 0, position = { x = 1, y = 2, z = 1 } },
  { kind = "loot_container", position = { x = 4, y = 2, z = 4 }, inventory = ["bread"] }
]
[dimensions]
width = 8
depth = 8
min_y = 0
max_y = 8
`;
  const spawnError = specError(() => compileMap(noHeadroom));
  assert.equal(spawnError.kind, SpecErrorKind.Geometry);
  assert.equal(spawnError.path, "map.spawn[0]");

  const disconnectedFinalZone = `
schema = 1
name = "isolated-final-zone"
operations = [
  { kind = "cuboid", from = { x = 0, y = 1, z = 0 }, to = { x = 3, y = 1, z = 3 }, block = "stone" },
  { kind = "cuboid", from = { x = 5, y = 1, z = 5 }, to = { x = 6, y = 1, z = 6 }, block = "stone" },
  { kind = "spawn", seat = 0, position = { x = 1, y = 2, z = 2 } },
  { kind = "spawn", seat = 1, position = { x = 3, y = 2, z = 1 } },
  { kind = "loot_container", position = { x = 2, y = 2, z = 3 }, inventory = ["bread"] }
]
[dimensions]
width = 12
depth = 12
min_y = 0
max_y = 8
`;
  const scenario = DUEL
    .replace("initial_diameter_blocks = 62", "initial_diameter_blocks = 12")
    .replace("final_diameter_blocks = 16", "final_diameter_blocks = 2");
  const routeError = specError(() => compileScenario(scenario, disconnectedFinalZone));
  assert.equal(routeError.kind, SpecErrorKind.Geometry);
  assert.equal(routeError.path, "scenario.border");
});

test("map_positions_use_shared_core_geometry_and_stable_order", () => {
  const map = compileMap(HUNGER_MAP);
  assert.deepEqual(map.spawns[0].position, blockPosition(64, 65, 40));
  assert.ok(Object.isFrozen(map.spawns[0].position));
  for (let index = 1; index < map.blocks.length; index += 1) {
    const previous = map.blocks[index - 1].position;
    const current = map.blocks[index].position;
    assert.ok(previous.x < current.x
      || (previous.x === current.x && previous.y < current.y)
      || (previous.x === current.x && previous.y === current.y && previous.z <= current.z));
  }
});

test("map_semantic_id_matches_java_world_plan_v1_fixture", () => {
  const fixture = JSON.parse(readRepoFile("tests/fixtures/world-plan/world-plan-v1.json")) as { map_semantic_id: string };
  const map = compileMap(readRepoFile("fixtures/spec/world-plan-map-v1.toml"));
  assert.equal(map.semanticId, fixture.map_semantic_id);
});

test("scenario_prepared_chunk_halo_matches_java_limit_at_aligned_boundaries", () => {
  const scenario = HUNGER
    .replace("competitors = 6", "competitors = 1")
    .replace("view_distance_chunks = 6", "view_distance_chunks = 2")
    .replace("simulation_distance_chunks = 5", "simulation_distance_chunks = 2")
    .replace("initial_diameter_blocks = 126", "initial_diameter_blocks = 945");
  // The last blocks lie on chunk edges, and a two-chunk halo starts at chunk -2.
  const atLimit = haloMap(945, 1_969);
  assert.equal(compileScenario(scenario, atLimit).map.dimensions.width, 945);

  const overLimit = specError(() => compileScenario(scenario, haloMap(945, 1_985)));
  assert.equal(overLimit.kind, SpecErrorKind.ResourceLimit);
  assert.equal(overLimit.path, "scenario.server.view_distance_chunks");
  assert.match(overLimit.message, /8,192/);
});

function specError(operation: () => unknown): SpecError {
  try {
    operation();
  } catch (error) {
    if (error instanceof SpecError) return error;
    throw error;
  }
  assert.fail("expected a specification error");
}

function readRepoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function haloMap(width: number, depth: number): string {
  return `
schema = 1
name = "prepared-chunk-halo"

[dimensions]
width = ${width}
depth = ${depth}
min_y = 0
max_y = 128

[[operations]]
kind = "cuboid"
from = { x = 471, y = 64, z = 983 }
to = { x = 473, y = 64, z = 985 }
block = "stone"

[[operations]]
kind = "spawn"
seat = 0
position = { x = 472, y = 65, z = 984 }

[[operations]]
kind = "loot_container"
position = { x = 473, y = 65, z = 984 }
inventory = ["bread"]
`;
}
