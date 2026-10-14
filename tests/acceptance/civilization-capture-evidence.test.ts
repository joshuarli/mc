import assert from "node:assert/strict";
import test from "node:test";

import { assertCivilizationCaptureEvidence } from "./civilization-capture-evidence.js";

test("civilization capture evidence follows occupants through a claim and opponent recapture", () => {
  const events = [
    stateEvent(1n, 0n, [0], null, "ember", 1n, 0n, 0n),
    stateEvent(2n, 1n, [0], null, "ember", 2n, 0n, 0n),
    stateEvent(3n, 2n, [0], "ember", null, 0n, 1n, 0n),
    stateEvent(4n, 3n, [0, 3], "ember", null, 0n, 2n, 0n),
    stateEvent(5n, 4n, [3], "ember", "tide", 1n, 3n, 0n),
    stateEvent(6n, 5n, [3], "ember", "tide", 2n, 4n, 0n),
    stateEvent(7n, 6n, [3], "tide", null, 0n, 4n, 1n),
  ];

  assertCivilizationCaptureEvidence(events, { graceTicks: 0n, uncontestedCaptureTicks: 3n });
});

test("civilization capture evidence rejects early ownership, fabricated scores, and incomplete ticks", () => {
  const earlyOwner = [stateEvent(1n, 0n, [0], "ember", null, 0n, 1n, 0n)];
  assert.throws(
    () => assertCivilizationCaptureEvidence(earlyOwner, { graceTicks: 0n, uncontestedCaptureTicks: 3n }),
    /does not match occupants and capture rules/,
  );

  const fabricatedScore = [
    stateEvent(1n, 0n, [0], null, "ember", 1n, 1n, 0n),
  ];
  assert.throws(
    () => assertCivilizationCaptureEvidence(fabricatedScore, { graceTicks: 0n, uncontestedCaptureTicks: 3n }),
    /scores inconsistent with actual ownership/,
  );

  const incompleteTicks = [
    stateEvent(1n, 0n, [0], null, "ember", 1n, 0n, 0n),
    stateEvent(2n, 2n, [0], null, "ember", 2n, 0n, 0n),
  ];
  assert.throws(
    () => assertCivilizationCaptureEvidence(incompleteTicks, { graceTicks: 0n, uncontestedCaptureTicks: 3n }),
    /tick sequence is incomplete/,
  );
});

test("civilization capture evidence rejects occupants eliminated earlier in the event stream", () => {
  const events = [
    {
      protocol: 1 as const,
      run_id: "run-1",
      sequence: 1n,
      type: "elimination" as const,
      payload: { at: { domain: "match" as const, value: 0n }, eliminations: [{ seat: 0, cause: "death" as const }] },
    },
    stateEvent(2n, 0n, [0], null, null, 0n, 0n, 0n),
  ];

  assert.throws(
    () => assertCivilizationCaptureEvidence(events, { graceTicks: 1n, uncontestedCaptureTicks: 3n }),
    /eliminated occupants/,
  );
});

function stateEvent(
  sequence: bigint,
  tick: bigint,
  occupants: readonly number[],
  owner: "ember" | "tide" | null,
  challenger: "ember" | "tide" | null,
  progress: bigint,
  emberPoints: bigint,
  tidePoints: bigint,
) {
  return {
    protocol: 1 as const,
    run_id: "run-1",
    sequence,
    type: "civilization_state" as const,
    payload: {
      at: { domain: "match" as const, value: tick },
      occupants,
      owner_faction: owner,
      challenger_faction: challenger,
      capture_progress_ticks: progress,
      scores: [
        { faction_id: "ember" as const, points: emberPoints },
        { faction_id: "tide" as const, points: tidePoints },
      ] as const,
    },
  };
}
