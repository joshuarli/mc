import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  GameMode,
  LEGACY_MAX_COMPETITORS,
  MAX_COMPETITORS,
  RESERVED_RUNNER_USERNAME_PREFIXES,
  SpecError,
  SpecErrorKind,
  compileScenario,
  isReservedRunnerUsername,
  withExternalSeat,
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
    readRepoFile("scenarios/hunger-six.toml").replace("schema = 3", "schema = 1").replace("spectator_capacity = 4\n", external),
    MAP_V2_SIX,
  ));
  assert.equal(v1External.kind, SpecErrorKind.UnknownField);

  const unsupported = specError(() => compileScenario(SCENARIO_24.replace("schema = 3", "schema = 5"), MAP_24));
  assert.equal(unsupported.path, "scenario.schema");
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

const SCENARIO_12 = readRepoFile("scenarios/hunger-12.toml");
const MAP_12 = readRepoFile("maps/hunger-12.toml");

const FRONTIER_RULES = `
[rules]
kind = "frontier_survival"
version = 1
edit_radius_blocks = 96
max_block_edits_per_seat = 2000
`;

function frontierScenario(): string {
  return SCENARIO_12
    .replace("block_breaking = false", "block_breaking = true")
    .replace("block_placing = false", "block_placing = true")
    + FRONTIER_RULES;
}

test("scenario_v3_compiles_hunger_12_as_classic_rules", () => {
  const scenario = compileScenario(SCENARIO_12, MAP_12);

  assert.equal(scenario.schemaVersion, 3);
  if (scenario.schemaVersion !== 3) throw new Error("schema 3 expected");
  assert.deepEqual(scenario.rules, { kind: "classic" });
  assert.equal(scenario.roster.seats.length, 12);
});

test("scenario_v3_frontier_survival_requires_block_editing_without_random_ticks", () => {
  const scenario = compileScenario(frontierScenario(), MAP_12);
  if (scenario.schemaVersion !== 3) throw new Error("schema 3 expected");
  assert.deepEqual(scenario.rules, {
    kind: "frontier_survival", version: 1, editRadiusBlocks: 96, maxBlockEditsPerSeat: 2000,
  });
  assert.notEqual(scenario.semanticId, compileScenario(SCENARIO_12, MAP_12).semanticId);

  const classicWithEdits = specError(() => compileScenario(
    SCENARIO_12.replace("block_breaking = false", "block_breaking = true"), MAP_12));
  assert.equal(classicWithEdits.path, "scenario.match");

  const noEdits = specError(() => compileScenario(
    frontierScenario().replace("block_breaking = true", "block_breaking = false"), MAP_12));
  assert.equal(noEdits.path, "scenario.match");

  const randomTicks = specError(() => compileScenario(
    frontierScenario().replace("natural_random_ticks = false", "natural_random_ticks = true"), MAP_12));
  assert.equal(randomTicks.path, "scenario.match");

  const hugeRadius = specError(() => compileScenario(
    frontierScenario().replace("edit_radius_blocks = 96", "edit_radius_blocks = 513"), MAP_12));
  assert.equal(hugeRadius.path, "scenario.rules.edit_radius_blocks");

  const unversioned = specError(() => compileScenario(
    frontierScenario().replace("version = 1", "version = 2"), MAP_12));
  assert.equal(unversioned.path, "scenario.rules.version");
});

test("scenario_v3_squads_partition_every_seat_into_named_teams", () => {
  const squads = `
[rules]
kind = "squads"
version = 1
squads = [
  { id = "alpha", seats = [0, 1, 2, 3, 4, 5] },
  { id = "bravo", seats = [6, 7, 8, 9, 10, 11] },
]
`;
  const scenario = compileScenario(SCENARIO_12 + squads, MAP_12);
  if (scenario.schemaVersion !== 3 || scenario.rules.kind !== "squads") throw new Error("squads expected");
  assert.deepEqual(scenario.rules.squads.map(({ id }) => id), ["alpha", "bravo"]);
  assert.deepEqual(scenario.rules.squads[1]?.seats, [6, 7, 8, 9, 10, 11]);

  const reject = (replacement: string, path: string): void => {
    const error = specError(() => compileScenario(
      SCENARIO_12 + squads.replace('{ id = "bravo", seats = [6, 7, 8, 9, 10, 11] }', replacement), MAP_12));
    assert.equal(error.path, path, replacement);
  };
  reject('{ id = "bravo", seats = [6, 7, 8, 9, 10] }', "scenario.rules.squads");
  reject('{ id = "bravo", seats = [5, 6, 7, 8, 9, 10, 11] }', "scenario.rules.squads[1].seats[0]");
  reject('{ id = "alpha", seats = [6, 7, 8, 9, 10, 11] }', "scenario.rules.squads[1].id");
  reject('{ id = "Bravo", seats = [6, 7, 8, 9, 10, 11] }', "scenario.rules.squads[1].id");
  reject('{ id = "bravo", seats = [6, 7, 8, 9, 10, 12] }', "scenario.rules.squads[1].seats[5]");
  reject('{ id = "bravo", seats = [] }', "scenario.rules.squads[1].seats");
});

test("scenario_v3_uhc_duel_requires_two_mirrored_seats_and_one_kit", () => {
  const source = readRepoFile("scenarios/uhc-duel.toml");
  const map = readRepoFile("maps/uhc-duel.toml");
  const scenario = compileScenario(source, map);
  if (scenario.schemaVersion !== 3 || scenario.rules.kind !== "uhc_duel") throw new Error("uhc duel expected");
  assert.equal(scenario.roster.competitors, 2);
  assert.equal(scenario.matchSettings.respawn, false);
  assert.deepEqual(scenario.rules.kit, {
    armor: "iron",
    sword: "iron",
    arrows: 16,
    goldenApples: 2,
    food: "minecraft:cooked_beef",
    foodCount: 8,
    shield: true,
  });
  const classic = compileScenario(source.replace(/\n\[rules\][\s\S]*$/, "\n"), map);
  if (classic.schemaVersion !== 3) throw new Error("schema 3 expected");
  assert.deepEqual(classic.rules, { kind: "classic" });
  assert.notEqual(classic.semanticId, scenario.semanticId);
  const unshielded = compileScenario(source.replace("\nshield = true\n", "\n"), map);
  if (unshielded.schemaVersion !== 3 || unshielded.rules.kind !== "uhc_duel") throw new Error("unshielded uhc expected");
  assert.equal(unshielded.rules.kit.shield, false);
  assert.notEqual(unshielded.semanticId, scenario.semanticId);

  const reject = (scenarioText: string, mapText: string, path: string): void => {
    assert.equal(specError(() => compileScenario(scenarioText, mapText)).path, path);
  };
  reject(source.replace("competitors = 2", "competitors = 1"), map, "scenario.roster.competitors");
  reject(source.replace("respawn = false", "respawn = true"), map, "scenario.match.respawn");
  reject(source.replace("block_breaking = false", "block_breaking = true"), map, "scenario.match");
  reject(source.replace('armor = "iron"', 'armor = "netherite_helmet"'), map, "scenario.rules.kit.armor");
  reject(source.replace('food = "minecraft:cooked_beef"', 'food = "minecraft:diamond_sword"'), map, "scenario.rules.kit.food");
  reject(source.replace("\ngolden_apples = 2\n", "\n"), map, "scenario.rules.kit.golden_apples");
  reject(source.replace('food = "minecraft:cooked_beef"\nfood_count = 8', 'food = "minecraft:mushroom_stew"\nfood_count = 2'), map, "scenario.rules.kit.food_count");
  reject(source + "seat = 0\n", map, "scenario.rules.kit.seat");
  reject(source.replace("[rules.kit]", "[[rules.kit]]"), map, "scenario.rules.kit");
  reject(source, map.replace("x = 528", "x = 529"), "scenario.map");
  reject(SCENARIO_V2 + '\n[rules]\nkind = "uhc_duel"\nversion = 1\n', MAP_V2_SIX, "scenario.rules");
});

test("scenario_v2_rejects_rule_tables", () => {
  const error = specError(() => compileScenario(
    SCENARIO_V2 + '\n[rules]\nkind = "frontier_survival"\nversion = 1\n', MAP_V2_SIX));
  assert.equal(error.kind, SpecErrorKind.UnknownField);
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

test("reserved_runner_username_prefixes_are_exported_and_case_insensitive", () => {
  assert.deepEqual([...RESERVED_RUNNER_USERNAME_PREFIXES], ["ArenaBot", "ArenaSpec"]);
  for (const name of ["ArenaBot3", "arenabot", "ARENASPEC9", "ArenaSpecX"]) {
    assert.equal(isReservedRunnerUsername(name), true, name);
  }
  for (const name of ["Alex_Fixture", "Arena_Bot", "BotArena"]) {
    assert.equal(isReservedRunnerUsername(name), false, name);
  }
});

test("scenario_external_seat_override_rebinds_identity_inside_the_spec", () => {
  const base = compileScenario(SCENARIO_24, MAP_24);
  const first = withExternalSeat(base, { seat: 0, username: "Alex_9" });

  assert.deepEqual(first.roster.seats[0]?.controller, { kind: "external", username: "Alex_9" });
  assert.deepEqual(base.roster.seats[0]?.controller, { kind: "bot" });
  assert.notEqual(first.semanticId, base.semanticId);
  assert.notEqual(first.semanticId, withExternalSeat(base, { seat: 1, username: "Alex_9" }).semanticId);
  assert.notEqual(first.semanticId, withExternalSeat(base, { seat: 0, username: "Alex_8" }).semanticId);
  assert.equal(withExternalSeat(base, { seat: 0, username: "Alex_9" }).semanticId, first.semanticId);
  const expected = createHash("sha256")
    .update(`arena.scenario.effective-roster.v1\0${base.semanticId}\x000\0Alex_9`, "utf8").digest("hex");
  assert.equal(first.semanticId, expected);

  const reject = (action: () => unknown, kind: SpecErrorKind, path: string): void => {
    const error = specError(action);
    assert.equal(error.kind, kind);
    assert.equal(error.path, path);
  };
  reject(() => withExternalSeat(base, { seat: 24, username: "Alex_9" }), SpecErrorKind.Range, "external_seat.seat");
  reject(() => withExternalSeat(base, { seat: 0, username: "ab" }), SpecErrorKind.InvalidValue, "external_seat.username");
  reject(() => withExternalSeat(base, { seat: 0, username: "ArenaBot0" }), SpecErrorKind.Conflict, "external_seat.username");
  reject(() => withExternalSeat(first, { seat: 0, username: "Alex_8" }), SpecErrorKind.Conflict, "external_seat.seat");
  reject(() => withExternalSeat(first, { seat: 1, username: "alex_9" }), SpecErrorKind.Conflict, "external_seat.username");
  reject(() => withExternalSeat(compileScenario(readRepoFile("scenarios/duel.toml"), readRepoFile("maps/duel.toml")),
    { seat: 0, username: "Alex_9" }), SpecErrorKind.InvalidValue, "external_seat");
});
