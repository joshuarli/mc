import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { decodeCheckpoint, decodeControlEnvelope, encodeControlEnvelope } from "../src/control/index.js";
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

const checkpointDirectory = join(process.cwd(), "fixtures", "checkpoint");

test("control checkpoint fixtures decode the saved match with dead seats and the opaque extension", () => {
  const plain = decodeCheckpoint(readFileSync(join(checkpointDirectory, "checkpoint-v1.ckpt")));
  assert.equal(plain.record.match_tick, 520n);
  assert.deepEqual(plain.record.eliminations.map(({ seat, cause }) => [seat, cause]), [[2, "death"], [5, "disconnect"]]);
  assert.equal(plain.record.seats.filter(({ alive }) => alive).length, 6);
  assert.equal(plain.record.seats[2]?.state, undefined);
  assert.equal(plain.record.extension, null);
  assert.equal(plain.digest.length, 64);

  const extended = decodeCheckpoint(readFileSync(join(checkpointDirectory, "checkpoint-v1-extension.ckpt")));
  assert.equal(extended.record.extension?.version, 3);
  assert.equal(Buffer.from(extended.record.extension?.payload ?? "", "base64").toString("utf8"), "faction-state");
});

test("control checkpoint fixtures reject incomplete, tampered, and inconsistent records", () => {
  const invalid = readdirSync(checkpointDirectory).filter((name) => name.startsWith("checkpoint-invalid-"));
  assert.equal(invalid.length, 7);
  for (const name of invalid) {
    assert.throws(() => decodeCheckpoint(readFileSync(join(checkpointDirectory, name))), name);
  }
});

test("control damage events carry attribution and reject inconsistent entries", () => {
  const message = decodeControlEnvelope(fixture("control-damage.json"));
  if (message.type !== "damage") assert.fail("damage expected");
  assert.equal(message.payload.entries.length, 4);
  assert.deepEqual(message.payload.entries[1], {
    victim: 1, attacker: null, cause: "border", amount: 1, attacker_is_competitor: false,
  });
  const prepare = decodeControlEnvelope(fixture("control-prepare-damage-events.json"));
  assert.equal(prepare.type === "prepare" && "damage_events" in prepare.payload ? prepare.payload.damage_events : false, true);
});
