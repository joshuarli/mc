import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlCodecError,
  ControlReceiver,
  decodeControlEnvelope,
  encodeControlEnvelope,
  encodeControlFrame
} from "../src/control/index.js";
import type { ControlMessage } from "../src/control/types.js";

test("control codec rejects lossy integer numbers and numeric underflow", () => {
  const lossyProtocolVersion = '{"protocol":1,"run_id":"fixture-run","sequence":"1","correlation":"1","type":"ready","payload":{"server":{"name":"paper","version":"1","minecraft_version":"1","protocol_version":1.00000000000000001},"plugin":{"name":"arena-foundation","version":"1"},"capabilities":["hunger_games_v1"]}}';
  const underflowCounter = '{"protocol":1,"run_id":"fixture-run","sequence":"1","type":"metrics","payload":{"server_tick_duration_micros":1e-324,"critical_queue_depth":0,"dropped_optional_metrics":0}}';
  assert.throws(() => decodeControlEnvelope(lossyProtocolVersion), ControlCodecError);
  assert.throws(() => decodeControlEnvelope(underflowCounter), ControlCodecError);
});

test("control codec counts Unicode code points against schema string limits", () => {
  const ready = JSON.stringify({
    protocol: 1,
    run_id: "fixture-run",
    sequence: "1",
    correlation: "1",
    type: "ready",
    payload: {
      server: { name: "😀".repeat(128), version: "1", minecraft_version: "1", protocol_version: 1 },
      plugin: { name: "arena-foundation", version: "1" },
      capabilities: ["hunger_games_v1"]
    }
  });
  assert.doesNotThrow(() => decodeControlEnvelope(ready));
});

test("control codec rejects unpaired surrogates in outbound values and keys", () => {
  const base = {
    protocol: 1,
    run_id: "fixture-run",
    sequence: 1n,
    type: "error",
    payload: { code: "internal", message: "valid message" }
  } as unknown as ControlMessage;
  const invalidValue = { ...base, payload: { code: "internal", message: "\ud800" } } as unknown as ControlMessage;
  const invalidKey = {
    ...base,
    payload: { code: "internal", message: "valid message", "\ud800": "invalid key" }
  } as unknown as ControlMessage;
  assert.throws(() => encodeControlEnvelope(invalidValue), ControlCodecError);
  assert.throws(() => encodeControlEnvelope(invalidKey), ControlCodecError);
});

test("control receiver freezes decoded messages and authenticated capabilities", () => {
  const receiver = new ControlReceiver("fixture-run", "fixture-secret", ["hunger_games_v1"]);
  const accepted = receiver.acceptFrame(encodeControlFrame({
    protocol: 1,
    run_id: "fixture-run",
    sequence: 1n,
    type: "hello",
    payload: { token: "fixture-secret", capabilities: ["hunger_games_v1"] }
  }));
  if (accepted.type !== "hello") throw new Error("expected authenticated hello");
  assert.equal(Object.isFrozen(accepted), true);
  assert.equal(Object.isFrozen(accepted.payload), true);
  assert.equal(Object.isFrozen(accepted.payload.capabilities), true);
  assert.equal(Reflect.set(accepted.payload.capabilities, 0, "untrusted"), false);

  receiver.expectReadyAfter(2n);
  const ready = receiver.acceptFrame(encodeControlFrame({
    protocol: 1,
    run_id: "fixture-run",
    sequence: 2n,
    correlation: 2n,
    type: "ready",
    payload: {
      server: { name: "paper", version: "1", minecraft_version: "1", protocol_version: 1 },
      plugin: { name: "arena-foundation", version: "1" },
      capabilities: ["hunger_games_v1"]
    }
  }));
  if (ready.type !== "ready") throw new Error("expected correlated readiness");
  assert.equal(Object.isFrozen(ready.payload.server), true);
});
