import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { SpecError, SpecErrorKind, compileScenario } from "../src/index.js";

const UHC_KIT = {
  armor: "iron",
  sword: "iron",
  arrows: 16,
  goldenApples: 2,
  food: "minecraft:cooked_beef",
  foodCount: 8,
  shield: true,
} as const;

const LAYOUTS = [
  ["scenarios/uhc-melee.toml", "maps/uhc-melee.toml", 10, 16],
  ["scenarios/uhc-bow.toml", "maps/uhc-bow.toml", 17, 40],
  ["scenarios/uhc-cover.toml", "maps/uhc-cover.toml", 10, 16],
  ["scenarios/uhc-elevation.toml", "maps/uhc-elevation.toml", 17, 40],
] as const;

test("scenario_v4_planned_uhc_compiles_four_reachable_layouts", () => {
  const natural = compileScenario(readRepoFile("scenarios/uhc-duel.toml"), readRepoFile("maps/uhc-duel.toml"));
  assert.equal(natural.schemaVersion, 3);
  for (const [scenarioPath, mapPath, near, far] of LAYOUTS) {
    const scenario = compileScenario(readRepoFile(scenarioPath), readRepoFile(mapPath));
    assert.equal(scenario.schemaVersion, 4, scenarioPath);
    if (scenario.schemaVersion !== 4 || scenario.rules.kind !== "uhc_duel") throw new Error("schema 4 uhc expected");
    assert.equal(scenario.map.terrain, "planned");
    assert.ok(scenario.map.dimensions.width <= 64 && scenario.map.dimensions.depth <= 64, scenarioPath);
    assert.notEqual(scenario.map.dimensions.width, 1024);
    assert.deepEqual(scenario.rules.kit, UHC_KIT);
    assert.notEqual(scenario.semanticId, natural.semanticId);
    if (scenario.map.terrain !== "planned") throw new Error("planned map expected");
    const [left, right] = scenario.map.spawns;
    if (left === undefined || right === undefined) throw new Error("spawn pair missing");
    assert.equal(left.position.y, right.position.y, scenarioPath);
    const separation = Math.hypot(right.position.x - left.position.x, right.position.z - left.position.z);
    assert.ok(separation >= near && separation <= far, `${scenarioPath} separation ${separation}`);
    assertPointSymmetric(scenario.map);
  }

  const elevation = compileScenario(readRepoFile("scenarios/uhc-elevation.toml"), readRepoFile("maps/uhc-elevation.toml"));
  if (elevation.map.terrain !== "planned") throw new Error("elevation map expected");
  const surface = feetByColumn(elevation.map.blocks);
  const valley = surface.get("20,20");
  const pad = surface.get("10,20");
  if (valley === undefined || pad === undefined) throw new Error("elevation surface missing");
  assert.ok(pad - valley >= 1 && pad - valley < 20);
  for (let x = 10; x < 30; x += 1) {
    const current = surface.get(`${x},20`);
    const next = surface.get(`${x + 1},20`);
    if (current === undefined || next === undefined) throw new Error("elevation lane is not walkable");
    assert.ok(Math.abs(next - current) <= 1, `step at x ${x}`);
  }

  const cover = compileScenario(readRepoFile("scenarios/uhc-cover.toml"), readRepoFile("maps/uhc-cover.toml"));
  if (cover.map.terrain !== "planned") throw new Error("cover map expected");
  assert.ok(cover.map.blocks.some((block) => block.block === "minecraft:cobblestone"));
});

test("scenario_v4_planned_uhc_rejects_blocked_line_of_sight_and_unescapable_pits", () => {
  const scenario = readRepoFile("scenarios/uhc-melee.toml");
  const melee = readRepoFile("maps/uhc-melee.toml");
  const walled = melee.replace(
    'kind = "loot_container"',
    `kind = "cuboid"
from = { x = 15, y = 65, z = 6 }
to = { x = 15, y = 66, z = 10 }
block = "minecraft:stone"

[[operations]]
kind = "loot_container"`,
  );
  const walledError = specError(() => compileScenario(scenario, walled));
  assert.equal(walledError.kind, SpecErrorKind.Geometry);
  assert.equal(walledError.path, "scenario.map");
  assert.match(walledError.message, /reciprocal line of sight/);

  const pit = `
schema = 1
name = "uhc-pit"
[dimensions]
width = 33
depth = 17
min_y = 0
max_y = 80
[[operations]]
kind = "cuboid"
from = { x = 0, y = 64, z = 0 }
to = { x = 14, y = 64, z = 16 }
block = "minecraft:stone"
[[operations]]
kind = "cuboid"
from = { x = 18, y = 64, z = 0 }
to = { x = 32, y = 64, z = 16 }
block = "minecraft:stone"
[[operations]]
kind = "cuboid"
from = { x = 15, y = 44, z = 0 }
to = { x = 17, y = 44, z = 16 }
block = "minecraft:stone"
[[operations]]
kind = "spawn"
seat = 0
position = { x = 10, y = 65, z = 8 }
[[operations]]
kind = "spawn"
seat = 1
position = { x = 22, y = 65, z = 8 }
[[operations]]
kind = "loot_container"
position = { x = 12, y = 65, z = 8 }
inventory = ["minecraft:bread"]
`;
  const pitError = specError(() => compileScenario(scenario, pit));
  assert.equal(pitError.kind, SpecErrorKind.Geometry);
  assert.match(pitError.message, /traversable surface|unescapable drop/);
});

test("scenario_v4_allows_a_planned_map_only_for_uhc_duel", () => {
  const meleeScenario = readRepoFile("scenarios/uhc-melee.toml");
  const meleeMap = readRepoFile("maps/uhc-melee.toml");
  const naturalScenario = readRepoFile("scenarios/uhc-duel.toml");
  const naturalMap = readRepoFile("maps/uhc-duel.toml");
  const classic = specError(() => compileScenario(meleeScenario.replace(/\n\[rules\][\s\S]*$/, "\n"), meleeMap));
  assert.equal(classic.path, "scenario.map");
  assert.match(classic.message, /planned map only for uhc duel/);

  const schema3 = specError(() => compileScenario(naturalScenario, meleeMap));
  assert.equal(schema3.path, "scenario.map");
  assert.match(schema3.message, /natural terrain map/);

  const schema4Natural = compileScenario(naturalScenario.replace("schema = 3", "schema = 4"), naturalMap);
  assert.equal(schema4Natural.schemaVersion, 4);
  assert.equal(schema4Natural.map.terrain, "vanilla");
  const schema3Natural = compileScenario(naturalScenario, naturalMap);
  assert.notEqual(schema4Natural.semanticId, schema3Natural.semanticId);
  const brokenMirror = specError(() => compileScenario(
    naturalScenario.replace("schema = 3", "schema = 4"),
    naturalMap.replace("x = 528", "x = 529"),
  ));
  assert.equal(brokenMirror.path, "scenario.map");

  const hunger24 = compileScenario(
    readRepoFile("scenarios/hunger-24.toml").replace("schema = 3", "schema = 4"),
    readRepoFile("maps/hunger-24.toml"),
  );
  assert.equal(hunger24.schemaVersion, 4);
  if (hunger24.schemaVersion !== 4) throw new Error("schema 4 expected");
  assert.deepEqual(hunger24.rules, { kind: "classic" });
  assert.equal(hunger24.map.terrain, "vanilla");

  const unknown = specError(() => compileScenario(`${meleeScenario}\nnote = "lab"\n`, meleeMap));
  assert.equal(unknown.kind, SpecErrorKind.UnknownField);

  const unsupported = specError(() => compileScenario(meleeScenario.replace("schema = 4", "schema = 5"), meleeMap));
  assert.equal(unsupported.path, "scenario.schema");
});

function assertPointSymmetric(map: {
  readonly dimensions: { readonly width: number; readonly depth: number };
  readonly blocks: readonly { readonly position: { readonly x: number; readonly y: number; readonly z: number }; readonly block: string }[];
  readonly spawns: readonly { readonly position: { readonly x: number; readonly y: number; readonly z: number } }[];
}): void {
  const blocks = new Map(map.blocks.map((block) => [
    `${block.position.x},${block.position.y},${block.position.z}`,
    block.block,
  ]));
  for (const [key, block] of blocks) {
    const [x, y, z] = key.split(",").map(Number);
    if (x === undefined || y === undefined || z === undefined) throw new Error("bad block key");
    const mirror = `${map.dimensions.width - 1 - x},${y},${map.dimensions.depth - 1 - z}`;
    assert.equal(blocks.get(mirror), block, mirror);
  }
  const [left, right] = map.spawns;
  if (left === undefined || right === undefined) throw new Error("spawn pair missing");
  assert.equal(right.position.x, map.dimensions.width - 1 - left.position.x);
  assert.equal(right.position.y, left.position.y);
  assert.equal(right.position.z, map.dimensions.depth - 1 - left.position.z);
}

function feetByColumn(
  blocks: readonly { readonly position: { readonly x: number; readonly y: number; readonly z: number } }[],
): Map<string, number> {
  const highest = new Map<string, number>();
  for (const { position } of blocks) {
    const key = `${position.x},${position.z}`;
    const previous = highest.get(key);
    if (previous === undefined || position.y > previous) highest.set(key, position.y);
  }
  return new Map([...highest].map(([key, y]) => [key, y + 1]));
}

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
