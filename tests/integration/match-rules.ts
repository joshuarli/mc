import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertDeathWinner,
  eliminateOpponentWithSkillAttacks,
  waitForActivePhase,
} from "./support/duel.js";
import { runOwnedAcceptanceScenario } from "./support/owned-run.js";

test("match-rules", { timeout: 300_000 }, async (t) => {
  const run = await runOwnedAcceptanceScenario(
    "scenarios/duel.toml",
    "match-rules",
    async (active, signal) => {
      await active.start();
      await waitForActivePhase(active, signal);
      await eliminateOpponentWithSkillAttacks(active, 0, 1, signal);
      await active.waitForOutcome();
    },
    t.signal,
  );

  assert.equal(run.inspection.run_id, run.runId);
  assertDeathWinner(run, 0, 1, 2);
  assert.ok(
    !run.events.some((event) => event.type === "elimination"
      && event.payload.eliminations.some(({ seat, cause }) => seat === 1 && cause === "disconnect")),
    "a death result must not be reconstructed from a disconnect",
  );
});
