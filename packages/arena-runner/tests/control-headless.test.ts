import assert from "node:assert/strict";
import test from "node:test";
import { ControlCodecError, decodeControlEnvelope } from "../src/control/index.js";

test("control-v1 rejects human roster, capability, and timeout fields", () => {
  const humanPrepare = JSON.stringify({
    protocol: 1,
    run_id: "fixture-run",
    sequence: "1",
    type: "prepare",
    payload: {
      map_semantic_id: "a".repeat(64),
      scenario_semantic_id: "b".repeat(64),
      seed: "1",
      mode: "hunger_games",
      settings: {
        match: {
          countdown_ticks: "0",
          grace_ticks: "0",
          authoritative_max_ticks: "7200",
          respawn: false,
          block_breaking: false,
          block_placing: false,
          natural_mobs: false,
          natural_random_ticks: false
        },
        border: {
          initial_diameter_blocks: 126,
          shrink_start_tick: "1200",
          shrink_end_tick: "6000",
          final_diameter_blocks: 16
        }
      },
      roster: [{ kind: "human", seat: 0, participant_id: "human-local" }]
    }
  });
  const dynamicCapability = '{"protocol":1,"run_id":"fixture-run","sequence":"1","type":"hello","payload":{"token":"secret","capabilities":["dynamic_human_seat_v1"]}}';
  const humanTimeout = '{"protocol":1,"run_id":"fixture-run","sequence":"1","type":"outcome","payload":{"kind":"abort","reason":"human_wait_timeout","survivors":[],"at":null}}';
  assert.throws(() => decodeControlEnvelope(humanPrepare), ControlCodecError);
  assert.throws(() => decodeControlEnvelope(dynamicCapability), ControlCodecError);
  assert.throws(() => decodeControlEnvelope(humanTimeout), ControlCodecError);
});
