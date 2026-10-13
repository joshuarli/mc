import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeAuthorityEvent } from "../../packages/arena-runner/src/runtime/types.js";
import { hasEliminatedSeatEvidence } from "./hunger-alive-state.js";

function aliveState(sequence: bigint, seats: readonly number[]): RuntimeAuthorityEvent {
  return {
    protocol: 1, run_id: "hunger-reconnect", sequence, type: "public_state",
    payload: { at: { domain: "match", value: 5221n }, alive_seats: seats },
  };
}

function clock(sequence: bigint, domain: "match" | "countdown" = "match"): RuntimeAuthorityEvent {
  return {
    protocol: 1, run_id: "hunger-reconnect", sequence, type: "public_clock",
    payload: { phase: domain === "match" ? "active" : "countdown", tick: { domain, value: 5222n }, border_diameter_blocks: 24 },
  };
}

const eliminated: readonly RuntimeAuthorityEvent[] = [
  {
    protocol: 1, run_id: "hunger-reconnect", sequence: 1n, type: "elimination",
    payload: { at: { domain: "match", value: 5221n }, eliminations: [{ seat: 5, cause: "death" }] },
  },
  aliveState(2n, [0, 1, 2, 3, 4]),
];

test("hunger reconnect observes retained eliminated state after a new match clock without a repeated state", () => {
  const eventCountAfterReconnect = eliminated.length;
  assert.equal(hasEliminatedSeatEvidence([...eliminated, clock(3n)], 5, eventCountAfterReconnect), true);
});

test("hunger initial elimination wait uses the latest authoritative state", () => {
  assert.equal(hasEliminatedSeatEvidence(eliminated, 5), true);
  const history = [aliveState(0n, [0, 1, 2, 3, 4, 5]), ...eliminated];
  assert.equal(hasEliminatedSeatEvidence(history, 5), true);
  assert.equal(hasEliminatedSeatEvidence([...history, clock(3n)], 5, history.length), true);
  assert.equal(hasEliminatedSeatEvidence([aliveState(1n, [0, 1, 2, 3, 4, 5])], 5), false);
});

test("hunger reconnect rejects resurrection after the reconnect boundary", () => {
  assert.equal(hasEliminatedSeatEvidence([
    ...eliminated, clock(3n), aliveState(4n, [0, 1, 2, 3, 4, 5]),
  ], 5, eliminated.length), false);
  assert.equal(hasEliminatedSeatEvidence([
    ...eliminated, clock(3n), aliveState(4n, [0, 1, 2, 3, 4, 5]), aliveState(5n, [0, 1, 2, 3, 4]),
  ], 5, eliminated.length), false, "a later elimination must not hide an observed resurrection");
});

test("hunger reconnect requires an earlier authoritative state and a clock after its boundary", () => {
  assert.equal(hasEliminatedSeatEvidence([clock(1n)], 5, 0), false);
  assert.equal(hasEliminatedSeatEvidence(eliminated, 5, eliminated.length), false);
  const oldClockOnly = [clock(1n), ...eliminated];
  assert.equal(hasEliminatedSeatEvidence(oldClockOnly, 5, oldClockOnly.length), false);
  assert.equal(hasEliminatedSeatEvidence([...eliminated, clock(3n, "countdown")], 5, eliminated.length), false);
  const nullClock: RuntimeAuthorityEvent = {
    protocol: 1, run_id: "hunger-reconnect", sequence: 3n, type: "public_clock",
    payload: { phase: "waiting", tick: null, border_diameter_blocks: 24 },
  };
  assert.equal(hasEliminatedSeatEvidence([...eliminated, nullClock], 5, eliminated.length), false);
  assert.equal(hasEliminatedSeatEvidence([...eliminated, aliveState(3n, [0, 1, 2, 3, 4])], 5, eliminated.length), false,
    "a repeated state alone cannot replace the required post-reconnect match clock");
});
