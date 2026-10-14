import assert from "node:assert/strict";
import test from "node:test";
import {
  assertControlCorrelation,
  ControlCodecError,
  ControlReceiver,
  encodeControlFrame
} from "../src/control/index.js";
import type { ControlMessage } from "../src/control/types.js";

function frame(message: ControlMessage): Uint8Array {
  return encodeControlFrame(message);
}

test("control receiver authenticates before accepting plugin events", () => {
  const receiver = new ControlReceiver("fixture-run", "fixture-secret", ["hunger_games_v1"]);
  const wrongToken: ControlMessage = {
    protocol: 1,
    run_id: "fixture-run",
    sequence: 1n,
    type: "hello",
    payload: { token: "wrong-secret", capabilities: ["hunger_games_v1"] }
  };
  assert.throws(
    () => receiver.acceptFrame(frame(wrongToken)),
    (error: unknown) => error instanceof ControlCodecError && error.code === "authentication_failed"
  );
  assert.equal(receiver.lastAcceptedSequence, 0n);
  assert.equal(receiver.isReady, false);
});

test("control receiver requires hello, correlated ready, and increasing plugin sequences", () => {
  const receiver = new ControlReceiver("fixture-run", "fixture-secret", ["hunger_games_v1"]);
  const hello: ControlMessage = {
    protocol: 1,
    run_id: "fixture-run",
    sequence: 4n,
    type: "hello",
    payload: { token: "fixture-secret", capabilities: ["hunger_games_v1"] }
  };
  assert.equal(receiver.acceptFrame(frame(hello)).type, "hello");
  assert.equal(receiver.lastAcceptedSequence, 4n);

  receiver.expectReadyAfter(9n);
  const ready: ControlMessage = {
    protocol: 1,
    run_id: "fixture-run",
    sequence: 6n,
    correlation: 9n,
    type: "ready",
    payload: {
      server: { name: "paper", version: "26.1.2-74", minecraft_version: "26.1.2", protocol_version: 775 },
      plugin: { name: "arena-foundation", version: "0.1.0" },
      capabilities: ["hunger_games_v1"]
    }
  };
  assert.equal(receiver.acceptFrame(frame(ready)).type, "ready");
  assert.equal(receiver.isReady, true);

  const replay: ControlMessage = {
    protocol: 1,
    run_id: "fixture-run",
    sequence: 6n,
    type: "heartbeat",
    payload: {}
  };
  assert.throws(
    () => receiver.acceptFrame(frame(replay)),
    (error: unknown) => error instanceof ControlCodecError && error.code === "non_monotonic_sequence"
  );
  assert.equal(receiver.lastAcceptedSequence, 6n);
});

test("control receiver rejects stale runs and runner-only commands before sequence mutation", () => {
  const receiver = new ControlReceiver("fixture-run", "fixture-secret", ["hunger_games_v1"]);
  const stale: ControlMessage = {
    protocol: 1,
    run_id: "another-run",
    sequence: 1n,
    type: "hello",
    payload: { token: "fixture-secret", capabilities: ["hunger_games_v1"] }
  };
  assert.throws(
    () => receiver.acceptFrame(frame(stale)),
    (error: unknown) => error instanceof ControlCodecError && error.code === "run_mismatch"
  );
  assert.equal(receiver.lastAcceptedSequence, 0n);

  const commandBeforeHello: ControlMessage = {
    protocol: 1,
    run_id: "fixture-run",
    sequence: 1n,
    type: "start",
    payload: {}
  };
  assert.throws(() => receiver.acceptFrame(frame(commandBeforeHello)), ControlCodecError);
  assert.equal(receiver.lastAcceptedSequence, 0n);
});

test("control outcome is terminal and acknowledgments match the initiating sequence", () => {
  const receiver = new ControlReceiver("fixture-run", "fixture-secret", ["hunger_games_v1"]);
  receiver.acceptFrame(frame({
    protocol: 1,
    run_id: "fixture-run",
    sequence: 1n,
    type: "hello",
    payload: { token: "fixture-secret", capabilities: ["hunger_games_v1"] }
  }));
  receiver.expectReadyAfter(2n);
  receiver.acceptFrame(frame({
    protocol: 1,
    run_id: "fixture-run",
    sequence: 2n,
    correlation: 2n,
    type: "ready",
    payload: {
      server: { name: "paper", version: "26.1.2-74", minecraft_version: "26.1.2", protocol_version: 775 },
      plugin: { name: "arena-foundation", version: "0.1.0" },
      capabilities: ["hunger_games_v1"]
    }
  }));
  receiver.acceptFrame(frame({
    protocol: 1,
    run_id: "fixture-run",
    sequence: 3n,
    type: "outcome",
    payload: { kind: "winner", winner_seat: 0, survivors: [0], at: { domain: "match", value: 10n } }
  }));
  assert.equal(receiver.isTerminal, true);
  assert.throws(
    () => receiver.acceptFrame(frame({ protocol: 1, run_id: "fixture-run", sequence: 4n, type: "heartbeat", payload: {} })),
    (error: unknown) => error instanceof ControlCodecError && error.code === "invalid_handshake"
  );
  assert.equal(receiver.lastAcceptedSequence, 3n);

  const ack: ControlMessage = {
    protocol: 1,
    run_id: "fixture-run",
    sequence: 10n,
    correlation: 8n,
    type: "ack",
    payload: {}
  };
  assert.doesNotThrow(() => assertControlCorrelation(ack, 8n));
  assert.throws(() => assertControlCorrelation(ack, 7n), ControlCodecError);
});
