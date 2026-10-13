import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import {
  assertDeathWinner,
  competitorForSeat,
  eliminateOpponentWithSkillAttacks,
  waitForActivePhase,
} from "./support/duel.js";
import { observePlayerInventory } from "./support/mineflayer-world.js";
import { runOwnedAcceptanceScenario, type AcceptanceRunContext } from "./support/owned-run.js";

test("legal-player", { timeout: 300_000 }, async (t) => {
  const run = await runOwnedAcceptanceScenario(
    "scenarios/duel.toml",
    "legal-player",
    async (active, signal) => {
      const seatZero = competitorForSeat(active, 0);
      const chest = active.preparedRun.scenario.map.lootContainers[0];
      assert.ok(chest, "duel map must provide ordinary loot for the legal player route");

      await active.start();
      await waitForActivePhase(active, signal);
      assert.deepStrictEqual(
        await seatZero.client.run({ kind: "navigate", target: chest.position }),
        { kind: "succeeded" },
        "the Mineflayer pathfinder skill must reach the declared chest route",
      );
      assert.deepStrictEqual(
        await seatZero.client.run({ kind: "containerOpen", position: chest.position }),
        { kind: "succeeded" },
        "the ordinary container skill must collect the declared chest contents",
      );

      const inventory = observePlayerInventory(seatZero.bot);
      assert.ok(
        inventory.items.some(({ item }) => item === "minecraft:stone_sword"),
        "the client must receive the declared stone sword through its chest interaction",
      );
      assert.ok(
        inventory.items.some(({ item }) => item === "minecraft:bread"),
        "the client must receive the declared bread through its chest interaction",
      );

      const observation = await waitForCurrentAgent(seatZero.client, signal);
      assert.equal(observation.agent.kind, "current");
      const weapon = observation.agent.value.upgrades.find((upgrade) => upgrade.equipmentSlot === "weapon");
      assert.ok(weapon, "the complete client observation must recognize the received sword as an upgrade");
      assert.deepStrictEqual(
        await seatZero.client.run({
          kind: "equip",
          inventorySlot: weapon.inventorySlot,
          equipmentSlot: "weapon",
          rating: weapon.rating,
        }),
        { kind: "succeeded" },
        "the ordinary equip skill must place the received sword in the weapon slot",
      );
      const equipped = await waitForCurrentAgent(seatZero.client, signal);
      assert.equal(equipped.agent.kind, "current");
      assert.equal(equipped.agent.value.equipped.weapon, weapon.rating);

      await eliminateOpponentWithSkillAttacks(active, 0, 1, signal);
      await active.waitForOutcome();
    },
    t.signal,
  );

  assertDeathWinner(run, 0, 1, 2);
});

async function waitForCurrentAgent(
  client: AcceptanceRunContext["competitors"][number]["client"],
  signal: AbortSignal,
) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const observation = client.observe(0);
    if (observation.agent.kind === "current") return observation;
    await delay(50, undefined, { signal });
  }
  throw new Error("Mineflayer agent state did not become current within 20000 ms");
}
