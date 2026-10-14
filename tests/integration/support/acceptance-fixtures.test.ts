import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { compilePolicy, compileScenario, scenarioMapReference } from "@arena/spec";
import { plannedMap } from "./planned-map.js";

const FIXTURE_DIRECTORY = "tests/acceptance/fixtures";

test("all live acceptance scenario and policy sources compile offline", () => {
  const fixtureScenarios = readdirSync(FIXTURE_DIRECTORY)
    .filter((name) => name.endsWith("-scenario.toml")
      || (name.startsWith("hunger-six-seed-") && name.endsWith(".toml")))
    .sort()
    .map((name) => resolve(FIXTURE_DIRECTORY, name));

  for (const scenarioPath of [resolve("scenarios/duel.toml"), ...fixtureScenarios]) {
    const scenarioSource = readFileSync(scenarioPath, "utf8");
    const mapPath = resolve(dirname(scenarioPath), scenarioMapReference(scenarioSource));
    const mapSource = readFileSync(mapPath, "utf8");
    const scenario = compileScenario(scenarioSource, mapSource);
    const policyPath = resolve(dirname(scenarioPath), scenario.policyReference);
    const policy = compilePolicy(readFileSync(policyPath, "utf8"));

    assert.ok(scenario.map.blocks.length > 0, `${scenarioPath} must compile a nonempty world map`);
    assert.ok(policy.semanticId, `${scenarioPath} must resolve and compile its policy source`);
  }
});

test("match-rules freeze fixture offers an ordinary weapon", () => {
  const scenarioPath = resolve(FIXTURE_DIRECTORY, "match-rules-freeze-scenario.toml");
  const scenarioSource = readFileSync(scenarioPath, "utf8");
  const mapPath = resolve(dirname(scenarioPath), scenarioMapReference(scenarioSource));
  const scenario = compileScenario(scenarioSource, readFileSync(mapPath, "utf8"));
  assert.ok(
    scenario.map.lootContainers.some(({ inventory }) => inventory.includes("minecraft:stone_sword")),
    "the ordinary duel fixture must let the attacker loot a stone sword",
  );
});

test("fairness fixtures keep both stationary competitors inside the final border", () => {
  for (const name of ["fairness-scenario.toml", "fairness-perturbed-scenario.toml"]) {
    const scenarioPath = resolve(FIXTURE_DIRECTORY, name);
    const source = readFileSync(scenarioPath, "utf8");
    const scenario = compileScenario(source, readFileSync(resolve(dirname(scenarioPath), scenarioMapReference(source)), "utf8"));
    const centerX = scenario.map.dimensions.width / 2;
    const centerZ = scenario.map.dimensions.depth / 2;
    assert.equal(scenario.mode, "hunger_games");
    if (scenario.mode !== "hunger_games") throw new Error("fairness fixtures require Hunger Games");
    const radius = scenario.border.finalDiameterBlocks / 2;
    for (const spawn of plannedMap(scenario.map).spawns) {
      assert.ok(Math.abs(spawn.position.x + 0.5 - centerX) + 0.3 < radius, `${name}: seat ${spawn.seat} must remain within the border in x`);
      assert.ok(Math.abs(spawn.position.z + 0.5 - centerZ) + 0.3 < radius, `${name}: seat ${spawn.seat} must remain within the border in z`);
    }
  }
});
