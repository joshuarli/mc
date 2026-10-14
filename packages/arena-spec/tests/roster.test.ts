import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  GameMode,
  LEGACY_MAX_COMPETITORS,
  MAX_COMPETITORS,
  SpecError,
  SpecErrorKind,
  compileScenario,
} from "../src/index.js";

const SCENARIO_24 = readRepoFile("scenarios/hunger-24.toml");
const MAP_24 = readRepoFile("maps/hunger-24.toml");
const SCENARIO_256 = readRepoFile("fixtures/spec/hunger-256-scenario.toml");
const MAP_256 = readRepoFile("fixtures/spec/hunger-256-map.toml");
const SCENARIO_V2 = readRepoFile("fixtures/spec/hunger-v1.toml")
  .replace("schema = 1", "schema = 2")
  .replace("[roster]", "opening_styles = [\"explorer\", \"scavenger\", \"hunter\"]\n\n[roster]");
const MAP_V2_SIX = readRepoFile("maps/hunger-six.toml");

test("scenario_v3_compiles_hunger_24_with_resolved_bot_seats", () => {
  const scenario = compileScenario(SCENARIO_24, MAP_24);

  assert.equal(scenario.schemaVersion, 3);
  assert.equal(scenario.mode, GameMode.HungerGames);
  assert.equal(scenario.roster.competitors, 24);
  assert.equal(scenario.roster.seats.length, 24);
  assert.deepEqual(scenario.roster.seats[7], { seat: 7, controller: { kind: "bot" } });
  assert.equal(scenario.roster.spectatorCapacity, 4n);
  assert.equal(scenario.map.spawns.length, 24);
});

test("scenario_v3_roster_accepts_256_seats_and_rejects_257", () => {
  const scenario = compileScenario(SCENARIO_256, MAP_256);
  assert.equal(MAX_COMPETITORS, 256);
  assert.equal(scenario.roster.seats.length, 256);
  assert.deepEqual(scenario.roster.seats[0]?.controller, { kind: "external", username: "Alex_Fixture" });
  assert.deepEqual(scenario.roster.seats[255]?.controller, { kind: "external", username: "Last_Seat" });
  assert.deepEqual(scenario.roster.seats[1]?.controller, { kind: "bot" });

  const tooMany = specError(() => compileScenario(SCENARIO_256.replace("competitors = 256", "competitors = 257"), MAP_256));
  assert.equal(tooMany.kind, SpecErrorKind.Range);
  assert.equal(tooMany.path, "scenario.roster.competitors");

  const spawnMismatch = specError(() => compileScenario(SCENARIO_256.replace("competitors = 256", "competitors = 255")
    .replace(', { seat = 255, username = "Last_Seat" }', ""), MAP_256));
  assert.equal(spawnMismatch.kind, SpecErrorKind.Geometry);
});

test("scenario_v3_rejects_rosters_above_the_prepared_chunk_cap", () => {
  const error = specError(() => compileScenario(
    SCENARIO_256.replace("view_distance_chunks = 6", "view_distance_chunks = 32")
      .replace("simulation_distance_chunks = 5", "simulation_distance_chunks = 5"),
    MAP_256,
  ));

  assert.equal(error.kind, SpecErrorKind.ResourceLimit);
  assert.equal(error.path, "scenario.server.view_distance_chunks");
});

test("scenario_v3_external_seats_validate_identity_and_bind_scenario_identity", () => {
  const base = compileScenario(SCENARIO_24, MAP_24);
  const withExternal = compileScenario(
    SCENARIO_24.replace("spectator_capacity = 4\n", "spectator_capacity = 4\nexternal = [{ seat = 3, username = \"Alex_Fixture\" }]\n"),
    MAP_24,
  );
  assert.deepEqual(withExternal.roster.seats[3]?.controller, { kind: "external", username: "Alex_Fixture" });
  assert.notEqual(withExternal.semanticId, base.semanticId);
  assert.equal(withExternal.map.semanticId, base.map.semanticId);

  const renamed = compileScenario(
    SCENARIO_24.replace("spectator_capacity = 4\n", "spectator_capacity = 4\nexternal = [{ seat = 3, username = \"Alex_Other\" }]\n"),
    MAP_24,
  );
  assert.notEqual(renamed.semanticId, withExternal.semanticId);

  const reject = (external: string, path: string, kind: SpecErrorKind): void => {
    const error = specError(() => compileScenario(
      SCENARIO_24.replace("spectator_capacity = 4\n", `spectator_capacity = 4\nexternal = ${external}\n`),
      MAP_24,
    ));
    assert.equal(error.path, path, external);
    assert.equal(error.kind, kind, external);
  };
  reject('[{ seat = 24, username = "Alex_Fixture" }]', "scenario.roster.external[0].seat", SpecErrorKind.Range);
  reject('[{ seat = 3, username = "ab" }]', "scenario.roster.external[0].username", SpecErrorKind.InvalidValue);
  reject('[{ seat = 3, username = "bad name" }]', "scenario.roster.external[0].username", SpecErrorKind.InvalidValue);
  reject('[{ seat = 3, username = "ArenaBot3" }]', "scenario.roster.external[0].username", SpecErrorKind.Conflict);
  reject('[{ seat = 3, username = "arenaspec0" }]', "scenario.roster.external[0].username", SpecErrorKind.Conflict);
  reject('[{ seat = 3, username = "Alex_One" }, { seat = 3, username = "Alex_Two" }]', "scenario.roster.external[1].seat", SpecErrorKind.Conflict);
  reject('[{ seat = 5, username = "Alex_One" }, { seat = 3, username = "Alex_Two" }]', "scenario.roster.external[1].seat", SpecErrorKind.Conflict);
  reject('[{ seat = 3, username = "Alex_One" }, { seat = 4, username = "ALEX_ONE" }]', "scenario.roster.external[1].username", SpecErrorKind.Conflict);
  reject('[{ seat = 3, username = "Alex_One", role = "x" }]', "scenario.roster.external[0].role", SpecErrorKind.UnknownField);
});

test("scenario_v3_spectator_capacity_is_independent_of_competitor_seats", () => {
  const scenario = compileScenario(SCENARIO_24.replace("spectator_capacity = 4", "spectator_capacity = 300"), MAP_24);

  assert.equal(scenario.roster.spectatorCapacity, 300n);
  assert.equal(scenario.roster.seats.length, 24);
});

test("scenario_v1_and_v2_reject_the_generalized_roster", () => {
  assert.equal(LEGACY_MAX_COMPETITORS, 6);
  const external = "spectator_capacity = 4\nexternal = [{ seat = 0, username = \"Alex_Fixture\" }]\n";
  const v2External = specError(() => compileScenario(
    SCENARIO_V2.replace("spectator_capacity = 4\n", external),
    MAP_V2_SIX,
  ));
  assert.equal(v2External.path, "scenario.roster.external");
  assert.equal(v2External.kind, SpecErrorKind.UnknownField);

  const v2Seven = specError(() => compileScenario(SCENARIO_V2.replace("competitors = 6", "competitors = 7"), MAP_V2_SIX));
  assert.equal(v2Seven.kind, SpecErrorKind.Range);
  assert.equal(v2Seven.path, "scenario.roster.competitors");

  const v1External = specError(() => compileScenario(
    readRepoFile("scenarios/hunger-six.toml").replace("schema = 2", "schema = 1").replace("spectator_capacity = 4\n", external),
    MAP_V2_SIX,
  ));
  assert.equal(v1External.kind, SpecErrorKind.UnknownField);

  const v4 = specError(() => compileScenario(SCENARIO_24.replace("schema = 3", "schema = 4"), MAP_24));
  assert.equal(v4.path, "scenario.schema");
});

test("scenario_v3_requires_hunger_games_and_natural_terrain", () => {
  const civilization = specError(() => compileScenario(
    SCENARIO_24.replace('mode = "hunger_games"', 'mode = "civilization"'),
    MAP_24,
  ));
  assert.equal(civilization.path, "scenario.schema");

  const planned = specError(() => compileScenario(SCENARIO_24, readRepoFile("fixtures/spec/hunger-map-v1.toml")));
  assert.equal(planned.path, "scenario.map");
});

test("natural_border_center_is_the_floor_of_the_mean_spawn_column", () => {
  const map = `
schema = 2
name = "center"
terrain = "vanilla"
dimensions = { width = 1024, depth = 1024 }
operations = [
  { kind = "spawn", seat = 0, position = { x = 100, z = 500 } },
  { kind = "spawn", seat = 1, position = { x = 103, z = 500 } },
  { kind = "loot_container", position = { x = 101, z = 501 }, inventory = ["minecraft:bread"] }
]
`;
  const scenario = (initial: string) => SCENARIO_24
    .replace("competitors = 24", "competitors = 2")
    .replace("initial_diameter_blocks = 400", `initial_diameter_blocks = ${initial}`)
    .replace("final_diameter_blocks = 16", "final_diameter_blocks = 2");
  assert.doesNotThrow(() => compileScenario(scenario("4.5"), map));
  const error = specError(() => compileScenario(scenario("3.5"), map));
  assert.equal(error.kind, SpecErrorKind.Geometry);
  assert.match(error.message, /outside the initial border/);
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
