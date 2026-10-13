import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlCodecError,
  decodeControlEnvelope,
  decodeControlFrame,
  encodeControlEnvelope,
  encodeControlFrame,
  MAX_CONTROL_FRAME_BYTES
} from "../src/control/index.js";
import type { ControlMessage } from "../src/control/types.js";

const MAX_U64 = 18_446_744_073_709_551_615n;

test("control envelopes round-trip u64 values without narrowing", () => {
  const message: ControlMessage = {
    protocol: 1,
    run_id: "fixture-run",
    sequence: MAX_U64,
    type: "prepare",
    payload: {
      map_semantic_id: "a".repeat(64),
      scenario_semantic_id: "b".repeat(64),
      seed: MAX_U64,
      mode: "hunger_games",
      settings: {
        match: {
          countdown_ticks: 0n,
          grace_ticks: 200n,
          authoritative_max_ticks: 7200n,
          respawn: false,
          block_breaking: false,
          block_placing: false,
          natural_mobs: false,
          natural_random_ticks: false
        },
        border: {
          initial_diameter_blocks: 126,
          shrink_start_tick: 1200n,
          shrink_end_tick: 6000n,
          final_diameter_blocks: 16
        }
      },
      roster: [{ kind: "bot", seat: 0, participant_id: "bot-local", username: "arena_bot_0", offline_uuid: "00000000-0000-0000-0000-000000000001" }]
    }
  };
  const encoded = encodeControlEnvelope(message);
  const decoded = decodeControlEnvelope(encoded);
  assert.deepEqual(decoded, message);
  assert.equal(new TextDecoder().decode(encoded).includes('"seed":"18446744073709551615"'), true);
});

test("control frames use one big-endian length and reject mismatches", () => {
  const message: ControlMessage = {
    protocol: 1,
    run_id: "fixture-run",
    sequence: 1n,
    type: "heartbeat",
    payload: {}
  };
  const frame = encodeControlFrame(message);
  assert.deepEqual(decodeControlFrame(frame), message);
  const badLength = frame.slice();
  new DataView(badLength.buffer).setUint32(0, badLength.byteLength, false);
  assert.throws(
    () => decodeControlFrame(badLength),
    (error: unknown) => error instanceof ControlCodecError && error.code === "invalid_frame"
  );
});

test("control decoder rejects oversize bodies before JSON parsing", () => {
  const frame = new Uint8Array(MAX_CONTROL_FRAME_BYTES + 5);
  new DataView(frame.buffer).setUint32(0, MAX_CONTROL_FRAME_BYTES + 1, false);
  assert.throws(
    () => decodeControlFrame(frame),
    (error: unknown) => error instanceof ControlCodecError && error.code === "oversized_frame"
  );
});

test("control decoder rejects numeric, noncanonical, overflow, unknown, and removed fields", () => {
  const invalid = [
    '{"protocol":1,"run_id":"fixture-run","sequence":1,"type":"heartbeat","payload":{}}',
    '{"protocol":1,"run_id":"fixture-run","sequence":"01","type":"heartbeat","payload":{}}',
    '{"protocol":1,"run_id":"fixture-run","sequence":"18446744073709551616","type":"heartbeat","payload":{}}',
    '{"protocol":1,"run_id":"fixture-run","sequence":"1","type":"heartbeat","payload":{"debug_world":true}}',
    '{"protocol":1,"run_id":"fixture-run","sequence":"1","type":"finish","payload":{}}'
  ];
  for (const value of invalid) {
    assert.throws(() => decodeControlEnvelope(value), ControlCodecError);
  }
});

test("prepare rejects civilization and noncontiguous bot seats", () => {
  const template = {
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
      roster: [{ kind: "bot", seat: 0, participant_id: "bot-local", username: "arena_bot_0", offline_uuid: "00000000-0000-0000-0000-000000000001" }]
    }
  };
  const civilization = JSON.stringify(template).replace('"mode":"hunger_games"', '"mode":"civilization"');
  assert.throws(() => decodeControlEnvelope(civilization), ControlCodecError);

  const invalidSeat = JSON.stringify(template).replace('"seat":0', '"seat":1');
  assert.throws(() => decodeControlEnvelope(invalidSeat), ControlCodecError);
});

test("control schema rejects duplicate JSON keys before DTO validation", () => {
  const duplicate = '{"protocol":1,"protocol":1,"run_id":"fixture-run","sequence":"1","type":"heartbeat","payload":{}}';
  assert.throws(() => decodeControlEnvelope(duplicate), ControlCodecError);
});

test("ready protocol identity remains within the schema integer range", () => {
  const ready = '{"protocol":1,"run_id":"fixture-run","sequence":"1","correlation":"1","type":"ready","payload":{"server":{"name":"paper","version":"1","minecraft_version":"1","protocol_version":2147483648},"plugin":{"name":"arena-foundation","version":"1"},"capabilities":["hunger_games_v1"]}}';
  assert.throws(() => decodeControlEnvelope(ready), ControlCodecError);
});
