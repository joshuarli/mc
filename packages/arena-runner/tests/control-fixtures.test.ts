import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { decodeControlEnvelope, encodeControlEnvelope } from "../src/control/index.js";
import type { HungerGamesV2PreparePayload } from "../src/control/index.js";

const fixtureDirectory = join(process.cwd(), "fixtures", "protocol");
const fixtureNames = readdirSync(fixtureDirectory).filter((name) => name.endsWith(".json")).sort();

function fixture(name: string): Uint8Array {
  return readFileSync(join(fixtureDirectory, name));
}

test("control fixtures decode and re-encode every valid cross-language message", () => {
  const valid = fixtureNames.filter((name) => !name.startsWith("control-invalid-"));
  assert.ok(valid.length >= 20);
  for (const name of valid) {
    const bytes = fixture(name);
    const encoded = encodeControlEnvelope(decodeControlEnvelope(bytes));
    assert.deepEqual(JSON.parse(new TextDecoder().decode(encoded)), JSON.parse(new TextDecoder().decode(bytes)), name);
  }
});

test("control fixtures reject every invalid cross-language message", () => {
  const invalid = fixtureNames.filter((name) => name.startsWith("control-invalid-"));
  assert.ok(invalid.length >= 20);
  for (const name of invalid) {
    assert.throws(() => decodeControlEnvelope(fixture(name)), name);
  }
});

test("control roster v2 admits external seats up to 256 competitors", () => {
  const small = decodeControlEnvelope(fixture("control-prepare-roster-v2.json"));
  assert.equal(small.type, "prepare");
  if (small.type !== "prepare" || !("roster_version" in small.payload)) assert.fail("generalized prepare expected");
  const payload: HungerGamesV2PreparePayload = small.payload;
  assert.deepEqual(payload.roster.filter(({ kind }) => kind === "external").map(({ seat }) => seat), [3, 6]);

  const full = decodeControlEnvelope(fixture("control-prepare-roster-v2-256.json"));
  if (full.type !== "prepare") assert.fail("prepare expected");
  assert.equal(full.payload.roster.length, 256);
  assert.equal(full.payload.roster[255]?.kind, "external");
});

test("control legacy prepare keeps its six bot seat contract", () => {
  assert.throws(() => decodeControlEnvelope(fixture("control-invalid-roster-v1-external.json")));
  assert.throws(() => decodeControlEnvelope(fixture("control-invalid-roster-v1-seven-seats.json")));
  assert.throws(() => decodeControlEnvelope(fixture("control-invalid-civilization-roster-v2.json")));
});

test("control rule modes decode with their parameters and reject inconsistent match settings", () => {
  const frontier = decodeControlEnvelope(fixture("control-prepare-rules-frontier.json"));
  const squads = decodeControlEnvelope(fixture("control-prepare-rules-squads.json"));
  if (frontier.type !== "prepare" || squads.type !== "prepare") assert.fail("prepare expected");
  assert.deepEqual("rules" in frontier.payload ? frontier.payload.rules : undefined, {
    kind: "frontier_survival", version: 1, edit_radius_blocks: 96, max_block_edits_per_seat: 2000,
  });
  const squadRules = "rules" in squads.payload ? squads.payload.rules : undefined;
  assert.equal(squadRules?.kind === "squads" ? squadRules.squads.length : 0, 2);
});
