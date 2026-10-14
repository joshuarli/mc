import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  ControlCodecError,
  ControlReceiver,
  decodeControlEnvelope,
  encodeControlEnvelope,
  encodeControlFrame
} from "../src/control/index.js";

const protocolFixtures = join(process.cwd(), "fixtures/protocol");

const roster = Array.from({ length: 6 }, (_, seat) => ({
  kind: "bot",
  seat,
  participant_id: `bot-${seat}`,
  username: `arena_bot_${seat}`,
  offline_uuid: `00000000-0000-0000-0000-${String(seat + 1).padStart(12, "0")}`
}));

const civilizationSettings = {
  match: {
    countdown_ticks: "200",
    grace_ticks: "2400",
    authoritative_max_ticks: "18000",
    respawn: false,
    block_breaking: true,
    block_placing: true,
    natural_mobs: false,
    natural_random_ticks: false
  },
  border: { kind: "fixed", diameter_blocks: 192 },
  civilization: {
    factions: [
      {
        id: "ember",
        members: [
          { seat: 0, role: "gatherer_crafter" },
          { seat: 1, role: "builder" },
          { seat: 2, role: "defender_scout" }
        ]
      },
      {
        id: "tide",
        members: [
          { seat: 3, role: "gatherer_crafter" },
          { seat: 4, role: "builder" },
          { seat: 5, role: "defender_scout" }
        ]
      }
    ],
    starting_kit: [
      { item: "minecraft:bread", count: 4 },
      { item: "minecraft:wooden_axe", count: 1 },
      { item: "minecraft:wooden_pickaxe", count: 1 },
      { item: "minecraft:wooden_sword", count: 1 }
    ],
    capture_zone: {
      min: { x: 80, y: 60, z: 80 },
      max: { x: 88, y: 68, z: 88 },
      uncontested_ticks: 200,
      score_points_per_tick: 1
    },
    blueprint: {
      id: "oak-outpost-v1",
      anchors: {
        ember: { position: { x: 48, y: 64, z: 48 }, rotation_degrees: 0 },
        tide: { position: { x: 144, y: 64, z: 144 }, rotation_degrees: 180 }
      }
    }
  }
};

function envelope(type: string, payload: unknown, sequence = "1"): string {
  return JSON.stringify({ protocol: 1, run_id: "civ-run", sequence, type, payload });
}

function createHungerGamesOnlyReceiver(): ControlReceiver {
  const receiver = new ControlReceiver("civ-run", "session-token", ["hunger_games_v1", "civilization_v1"]);
  receiver.acceptFrame(encodeControlFrame({
    protocol: 1,
    run_id: "civ-run",
    sequence: 1n,
    type: "hello",
    payload: { token: "session-token", capabilities: ["hunger_games_v1"] }
  }));
  receiver.expectReadyAfter(1n);
  receiver.acceptFrame(encodeControlFrame({
    protocol: 1,
    run_id: "civ-run",
    sequence: 2n,
    correlation: 1n,
    type: "ready",
    payload: {
      server: { name: "paper", version: "1", minecraft_version: "1", protocol_version: 1 },
      plugin: { name: "arena", version: "1" },
      capabilities: ["hunger_games_v1"]
    }
  }));
  return receiver;
}

test("shared civilization wire fixtures decode and re-encode", async () => {
  for (const name of [
    "control-prepare-civilization.json",
    "control-civilization-state.json",
    "control-outcome-faction-winner.json",
    "control-outcome-civilization-draw.json"
  ]) {
    const fixture = await readFile(join(protocolFixtures, name), "utf8");
    const decoded = decodeControlEnvelope(fixture);
    const reencoded = decodeControlEnvelope(encodeControlEnvelope(decoded));
    assert.deepEqual(reencoded, decoded, name);
  }
});

test("control accepts civilization preparation and both negotiated capabilities", () => {
  const prepare = decodeControlEnvelope(envelope("prepare", {
    map_semantic_id: "a".repeat(64),
    scenario_semantic_id: "b".repeat(64),
    seed: "18446744073709551615",
    mode: "civilization",
    settings: civilizationSettings,
    roster
  }));
  assert.equal(prepare.type, "prepare");
  if (prepare.type !== "prepare") assert.fail("expected prepare message");
  assert.equal(prepare.payload.mode, "civilization");
  assert.equal(prepare.payload.settings.match.grace_ticks, 2400n);
  assert.equal(prepare.payload.settings.civilization.blueprint.anchors.tide.rotation_degrees, 180);
  assert.equal(prepare.payload.roster.length, 6);

  const hello = decodeControlEnvelope(envelope("hello", {
    token: "session-token",
    capabilities: ["hunger_games_v1", "civilization_v1"]
  }));
  assert.equal(hello.type, "hello");
  if (hello.type !== "hello") assert.fail("expected hello message");
  assert.deepEqual(hello.payload.capabilities, ["hunger_games_v1", "civilization_v1"]);
});

test("civilization state keeps match ticks and fixed faction score order", () => {
  const state = decodeControlEnvelope(envelope("civilization_state", {
    at: { domain: "match", value: "600" },
    occupants: [0, 3],
    owner_faction: "ember",
    challenger_faction: "tide",
    capture_progress_ticks: "199",
    scores: [
      { faction_id: "ember", points: "12" },
      { faction_id: "tide", points: "7" }
    ]
  }));
  assert.equal(state.type, "civilization_state");
  if (state.type !== "civilization_state") assert.fail("expected civilization state");
  assert.equal(state.payload.at.value, 600n);
  assert.equal(state.payload.scores[0].points, 12n);
  assert.equal(Object.isFrozen(state.payload.scores), true);
});

test("an HG-only handshake cannot send civilization state or score outcomes", () => {
  const stateReceiver = createHungerGamesOnlyReceiver();
  const state = encodeControlFrame({
    protocol: 1,
    run_id: "civ-run",
    sequence: 3n,
    type: "civilization_state",
    payload: {
      at: { domain: "match", value: 1n },
      occupants: [],
      owner_faction: null,
      challenger_faction: null,
      capture_progress_ticks: 0n,
      scores: [
        { faction_id: "ember", points: 0n },
        { faction_id: "tide", points: 0n }
      ]
    }
  });
  assert.throws(
    () => stateReceiver.acceptFrame(state),
    (error: unknown) => error instanceof ControlCodecError && error.code === "unsupported_capability"
  );

  const outcomeReceiver = createHungerGamesOnlyReceiver();
  const outcome = encodeControlFrame({
    protocol: 1,
    run_id: "civ-run",
    sequence: 3n,
    type: "outcome",
    payload: {
      kind: "faction_winner",
      winner_faction_id: "ember",
      reason: "elimination",
      scores: [
        { faction_id: "ember", points: 1n },
        { faction_id: "tide", points: 0n }
      ],
      survivors: [0],
      at: { domain: "match", value: 1n }
    }
  });
  assert.throws(
    () => outcomeReceiver.acceptFrame(outcome),
    (error: unknown) => error instanceof ControlCodecError && error.code === "unsupported_capability"
  );
});

test("faction outcomes require matching variant fields and score order", () => {
  const winner = decodeControlEnvelope(envelope("outcome", {
    kind: "faction_winner",
    winner_faction_id: "ember",
    reason: "elimination",
    scores: [
      { faction_id: "ember", points: "12" },
      { faction_id: "tide", points: "7" }
    ],
    survivors: [0, 1],
    at: { domain: "match", value: "4200" }
  }));
  assert.equal(winner.type, "outcome");
  if (winner.type !== "outcome") assert.fail("expected outcome message");
  assert.equal(winner.payload.kind, "faction_winner");
  if (winner.payload.kind !== "faction_winner") assert.fail("expected faction winner");
  assert.equal(winner.payload.winner_faction_id, "ember");

  const badScores = envelope("outcome", {
    kind: "faction_winner",
    winner_faction_id: "ember",
    reason: "tick_limit",
    scores: [
      { faction_id: "tide", points: "7" },
      { faction_id: "ember", points: "12" }
    ],
    survivors: [0, 3],
    at: { domain: "match", value: "18000" }
  });
  assert.throws(() => decodeControlEnvelope(badScores), ControlCodecError);
});

test("civilization draw requires scores and equal tick-limit totals", () => {
  const draw = decodeControlEnvelope(envelope("outcome", {
    kind: "draw",
    reason: "tick_limit",
    scores: [
      { faction_id: "ember", points: "4" },
      { faction_id: "tide", points: "4" }
    ],
    survivors: [0, 3],
    at: { domain: "match", value: "18000" }
  }));
  assert.equal(draw.type, "outcome");
  if (draw.type !== "outcome") assert.fail("expected outcome message");
  assert.equal(draw.payload.kind, "draw");
  if (draw.payload.kind !== "draw" || !("scores" in draw.payload)) assert.fail("expected civilization draw");
  assert.equal(draw.payload.scores[1].points, 4n);

  const tiedAtWrongScores = envelope("outcome", {
    kind: "draw",
    reason: "tick_limit",
    scores: [
      { faction_id: "ember", points: "4" },
      { faction_id: "tide", points: "3" }
    ],
    survivors: [0, 3],
    at: { domain: "match", value: "18000" }
  });
  assert.throws(() => decodeControlEnvelope(tiedAtWrongScores), ControlCodecError);
});

test("civilization prepare rejects noncanonical roles and negative coordinates", () => {
  const validPrepare = envelope("prepare", {
    map_semantic_id: "a".repeat(64),
    scenario_semantic_id: "b".repeat(64),
    seed: "1",
    mode: "civilization",
    settings: civilizationSettings,
    roster
  });
  assert.throws(
    () => decodeControlEnvelope(validPrepare.replace('"role":"gatherer_crafter"', '"role":"builder"')),
    ControlCodecError
  );

  assert.throws(
    () => decodeControlEnvelope(validPrepare.replace('"min":{"x":80', '"min":{"x":-1')),
    ControlCodecError
  );
});

test("civilization control preserves signed safe-integer heights and nonnegative horizontal indices", () => {
  const wire = (axis: 'x' | 'y' | 'z', coordinate: number) => envelope("prepare", {
    map_semantic_id: "a".repeat(64), scenario_semantic_id: "b".repeat(64), seed: "1", mode: "civilization", roster,
    settings: { ...civilizationSettings, civilization: { ...civilizationSettings.civilization,
      capture_zone: { ...civilizationSettings.civilization.capture_zone,
        min: { x: 80, y: -35, z: 80, [axis]: coordinate }, max: { x: 88, y: 68, z: 88 } } } },
  });
  for (const height of [-35, -Number.MAX_SAFE_INTEGER]) {
    const message = decodeControlEnvelope(wire('y', height));
    assert.deepEqual(decodeControlEnvelope(encodeControlEnvelope(message)), message);
    if (message.type !== 'prepare' || message.payload.mode !== 'civilization') assert.fail('civilization prepare required');
    assert.equal(message.payload.settings.civilization.capture_zone.min.y, height);
  }
  for (const [axis, coordinate] of [['x', -1], ['z', -1], ['y', -Number.MAX_SAFE_INTEGER - 1], ['y', -35.5]] as const) {
    assert.throws(() => decodeControlEnvelope(wire(axis, coordinate)),
      (error: unknown) => error instanceof ControlCodecError && error.code === 'invalid_message');
  }
});
