import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { compilePolicy, compileScenario, scenarioMapReference } from "@arena/spec";

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
