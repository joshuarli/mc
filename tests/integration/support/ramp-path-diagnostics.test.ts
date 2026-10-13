import assert from "node:assert/strict";
import { test } from "node:test";
import { blockPosition } from "@arena/core";

import {
  serializeRampPathDiagnosticArtifact,
  type RampPathDiagnosticArtifact,
} from "./ramp-path-diagnostics.js";

test("ramp diagnostics retain exact own and observer arrival receipts", () => {
  const artifact: RampPathDiagnosticArtifact = {
    target: blockPosition(31, 66, 21),
    ownArrivalReceipt: {
      clientMs: 123.5,
      authorityTick: 245,
      position: { x: 31.42, y: 66, z: 21.37 },
    },
    observerArrivalReceipt: {
      clientMs: 124.25,
      authorityTick: 245,
      position: { x: 31.39, y: 66.02, z: 21.41 },
    },
    records: [],
  };

  assert.deepStrictEqual(
    JSON.parse(serializeRampPathDiagnosticArtifact(artifact).toString("utf8")),
    artifact,
  );
});

test("ramp diagnostics retain null receipts when a client never observes the target", () => {
  const artifact: RampPathDiagnosticArtifact = {
    target: blockPosition(31, 66, 21),
    ownArrivalReceipt: null,
    observerArrivalReceipt: null,
    records: [],
  };

  assert.deepStrictEqual(
    JSON.parse(serializeRampPathDiagnosticArtifact(artifact).toString("utf8")),
    artifact,
  );
});
