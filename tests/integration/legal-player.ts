import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { blockPosition, inventorySlot } from "@arena/core";
import type { Bot } from "mineflayer";
import { test } from "node:test";

import {
  assertDeathWinner,
  competitorForSeat,
  eliminateOpponentWithSkillAttacks,
  waitForActivePhase,
} from "./support/duel.js";
import { observePlayerInventory } from "./support/mineflayer-world.js";
import { runOwnedAcceptanceScenario, type AcceptanceRunContext } from "./support/owned-run.js";
import { startSprintCourse } from "./support/sprint-course.js";

const FOOD_DEPLETION_TIMEOUT_MS = 60_000;
const SPRINT_LEG_MS = 750;
const SPRINT_HEADINGS = [Math.PI, -Math.PI / 2, 0, Math.PI / 2] as const;
const COURSE_MIN_COORDINATE = 8;
const COURSE_MAX_COORDINATE = 54;
const COURSE_CENTER_COORDINATE = 31.5;
const COURSE_EDGE_MARGIN = 2;
const REQUIRED_SPRINT_TAKEOFFS = 8;
const RAMP_RECEIPT_TIMEOUT_MS = 5_000;

test("legal-player", { timeout: 300_000 }, async (t) => {
  const run = await runOwnedAcceptanceScenario(
    "scenarios/duel.toml",
    "legal-player",
    async (active, signal) => {
      const seatZero = competitorForSeat(active, 0);
      const seatOne = competitorForSeat(active, 1);
      const map = active.preparedRun.scenario.map;
      const chest = map.lootContainers[0];
      assert.ok(chest, "duel map must provide ordinary loot for the legal player route");
      const ramp = map.blocks.find(({ block, position }) =>
        block === "minecraft:cobblestone" && position.x === 31 && position.z === 21,
      );
      assert.ok(ramp, "duel map must provide the declared ramp on the legal route");

      await active.start();
      await waitForActivePhase(active, signal);

      const initialFood = seatZero.bot.food;
      assert.equal(initialFood, 20, "prepared competitor must begin with full food and reset saturation");
      const jumpEvidence = await depleteFoodBySprintJump(seatZero.bot, signal);
      assert.ok(jumpEvidence.takeoffs >= 8, "food loss must follow repeated client-observed sprint-jumps");
      assert.ok(jumpEvidence.highestY > jumpEvidence.startingY + 0.4, "sprint-jumps must include a real upward movement");
      assert.ok(jumpEvidence.remainingFood < initialFood, "ordinary movement must lower the server-observed food level");
      const hungry = await waitForCurrentAgent(seatZero.client, signal);
      assert.equal(hungry.agent.kind, "current");
      if (hungry.agent.kind !== "current") throw new Error("hungry player observation did not become current");
      assert.ok(hungry.agent.value.hungerPoints < initialFood, "the permitted player observation must report the food loss");

      await navigateOverRamp(seatZero.bot, seatZero.client, seatOne.bot, ramp, signal);
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

      const bread = inventory.items.find(({ item }) => item === "minecraft:bread");
      assert.ok(bread, "the player inventory must identify a bread slot for the ordinary eating skill");
      const foodBeforeEating = seatZero.bot.food;
      assert.deepStrictEqual(
        await seatZero.client.run({ kind: "eat", inventorySlot: inventorySlot(bread.slot) }),
        { kind: "succeeded" },
        "the ordinary eating skill must consume the looted bread after sprint-jump food loss",
      );
      const fed = await waitForCurrentAgent(seatZero.client, signal);
      assert.equal(fed.agent.kind, "current");
      if (fed.agent.kind !== "current") throw new Error("fed player observation did not become current");
      assert.ok(fed.agent.value.hungerPoints > foodBeforeEating, "the player observation must report food restored by eating");
      const inventoryAfterEating = observePlayerInventory(seatZero.bot);
      assert.ok(
        !inventoryAfterEating.items.some(({ item }) => item === "minecraft:bread"),
        "the client inventory must show the consumed bread was removed",
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

      const knockback = recordKnockbackReceipt(seatOne.bot, seatZero.bot.entity.id);
      try {
        await eliminateOpponentWithSkillAttacks(active, 0, 1, signal);
      } finally {
        knockback.close();
      }
      const knockbackEvidence = knockback.snapshot();
      assert.ok(knockbackEvidence.damageEvents > 0, "the target client must receive a player-caused damage event");
      assert.ok(
        knockbackEvidence.minimumHealth < knockbackEvidence.healthBefore,
        "the target client must receive a lower health value after the attack",
      );
      assert.ok(
        knockbackEvidence.maximumVelocityAway > 0.1,
        "the target client must receive outward velocity from ordinary sword knockback",
      );
      assert.ok(
        knockbackEvidence.maximumDisplacementAway > 0.1,
        "the target client must observe movement away from the attacker after the hit",
      );
      await active.waitForOutcome();
    },
    t.signal,
    { competitorDriver: "evaluator" },
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

async function depleteFoodBySprintJump(bot: Bot, signal: AbortSignal): Promise<{
  readonly startingY: number;
  readonly highestY: number;
  readonly takeoffs: number;
  readonly remainingFood: number;
}> {
  const startingFood = bot.food;
  const startingY = bot.entity.position.y;
  let highestY = startingY;
  let takeoffs = 0;
  let wasOnGround = bot.entity.onGround;
  const onPhysicsTick = (): void => {
    const { onGround, position } = bot.entity;
    if (wasOnGround && !onGround) takeoffs += 1;
    wasOnGround = onGround;
    highestY = Math.max(highestY, position.y);
  };
  bot.on("physicsTick", onPhysicsTick);
  const course = startSprintCourse(bot);

  const deadline = Date.now() + FOOD_DEPLETION_TIMEOUT_MS;
  try {
    while (bot.food >= startingFood && Date.now() < deadline) {
      for (const preferredYaw of SPRINT_HEADINGS) {
        signal.throwIfAborted();
        if (bot.food < startingFood || Date.now() >= deadline) break;
        await course.turn(sprintCourseHeading(bot, preferredYaw), takeoffs < REQUIRED_SPRINT_TAKEOFFS);
        const remainingMs = Math.max(1, Math.min(SPRINT_LEG_MS, deadline - Date.now()));
        await delay(remainingMs, undefined, { signal });
      }
    }
  } finally {
    course.stop();
    bot.removeListener("physicsTick", onPhysicsTick);
  }

  if (bot.food >= startingFood) {
    throw new Error(`sprint-jumps did not lower food within ${FOOD_DEPLETION_TIMEOUT_MS} ms`);
  }
  return { startingY, highestY, takeoffs, remainingFood: bot.food };
}

function sprintCourseHeading(bot: Bot, preferredYaw: number): number {
  const { x, z } = bot.entity.position;
  const nearWestEdge = x <= COURSE_MIN_COORDINATE + COURSE_EDGE_MARGIN;
  const nearEastEdge = x >= COURSE_MAX_COORDINATE - COURSE_EDGE_MARGIN;
  const nearNorthEdge = z <= COURSE_MIN_COORDINATE + COURSE_EDGE_MARGIN;
  const nearSouthEdge = z >= COURSE_MAX_COORDINATE - COURSE_EDGE_MARGIN;
  if (!nearWestEdge && !nearEastEdge && !nearNorthEdge && !nearSouthEdge) return preferredYaw;

  const towardCenterX = COURSE_CENTER_COORDINATE - x;
  const towardCenterZ = COURSE_CENTER_COORDINATE - z;
  if (Math.abs(towardCenterX) >= Math.abs(towardCenterZ)) {
    return towardCenterX > 0 ? -Math.PI / 2 : Math.PI / 2;
  }
  return towardCenterZ > 0 ? Math.PI : 0;
}

async function navigateOverRamp(
  bot: Bot,
  client: AcceptanceRunContext["competitors"][number]["client"],
  observer: Bot,
  ramp: { readonly position: { readonly x: number; readonly y: number; readonly z: number } },
  signal: AbortSignal,
): Promise<void> {
  let traversedRamp = false;
  let observerReceivedRampTop = false;
  const observePosition = (): void => {
    if (isAtRampTop(bot.entity.position, ramp.position)) traversedRamp = true;
  };
  const observeRemotePosition = (entity: Bot["entity"]): void => {
    if (entity.id === bot.entity.id && isAtRampTop(entity.position, ramp.position)) {
      observerReceivedRampTop = true;
    }
  };
  bot.on("move", observePosition);
  bot.on("physicsTick", observePosition);
  observer.on("entityMoved", observeRemotePosition);
  try {
    const rampTop = blockPosition(ramp.position.x, ramp.position.y + 1, ramp.position.z);
    const beyondRamp = {
      x: ramp.position.x + 9,
      y: ramp.position.y,
      z: ramp.position.z - 4,
    };
    signal.throwIfAborted();
    assert.deepStrictEqual(
      await client.run({ kind: "navigateToBlock", target: rampTop }),
      { kind: "succeeded" },
      "the pathfinder skill must climb onto the existing ramp",
    );
    assert.ok(traversedRamp, "the client must observe its own position on top of the ramp");
    const receiptDeadline = Date.now() + RAMP_RECEIPT_TIMEOUT_MS;
    while (!observerReceivedRampTop && Date.now() < receiptDeadline) {
      signal.throwIfAborted();
      await delay(50, undefined, { signal });
    }
    assert.ok(
      observerReceivedRampTop,
      "the opponent client must receive seat zero at the ramp top from the server",
    );
    signal.throwIfAborted();
    assert.deepStrictEqual(
      await client.run({ kind: "navigate", target: beyondRamp }),
      { kind: "succeeded" },
      "the pathfinder skill must continue along the route beyond the existing ramp",
    );
  } finally {
    bot.removeListener("move", observePosition);
    bot.removeListener("physicsTick", observePosition);
    observer.removeListener("entityMoved", observeRemotePosition);
  }
  assert.ok(traversedRamp, "the client must observe its own position above the ramp while navigating over it");
}

function isAtRampTop(
  position: { readonly x: number; readonly y: number; readonly z: number },
  ramp: { readonly x: number; readonly y: number; readonly z: number },
): boolean {
  return Math.floor(position.x) === ramp.x
    && Math.floor(position.z) === ramp.z
    && position.y >= ramp.y + 1;
}

function recordKnockbackReceipt(victim: Bot, attackerEntityId: number) {
  interface HitOrigin {
    readonly victimX: number;
    readonly victimZ: number;
    readonly directionX: number;
    readonly directionZ: number;
  }

  const healthBefore = victim.health;
  let minimumHealth = healthBefore;
  let damageEvents = 0;
  let origin: HitOrigin | undefined;
  let maximumVelocityAway = 0;
  let maximumDisplacementAway = 0;

  const onHurt = (entity: Bot["entity"] | undefined, source: Bot["entity"] | undefined): void => {
    if (entity?.id !== victim.entity.id || source?.id !== attackerEntityId) return;
    damageEvents += 1;
    if (origin !== undefined) return;
    const { x: victimX, z: victimZ } = victim.entity.position;
    const { x: attackerX, z: attackerZ } = source.position;
    const distance = Math.hypot(victimX - attackerX, victimZ - attackerZ);
    if (distance === 0) return;
    origin = {
      victimX,
      victimZ,
      directionX: (victimX - attackerX) / distance,
      directionZ: (victimZ - attackerZ) / distance,
    };
  };
  const onHealth = (): void => {
    minimumHealth = Math.min(minimumHealth, victim.health);
  };
  const observeMotion = (): void => {
    if (origin === undefined) return;
    const velocity = victim.entity.velocity;
    const velocityAway = velocity.x * origin.directionX + velocity.z * origin.directionZ;
    maximumVelocityAway = Math.max(maximumVelocityAway, velocityAway);
    const displacementAway =
      (victim.entity.position.x - origin.victimX) * origin.directionX
      + (victim.entity.position.z - origin.victimZ) * origin.directionZ;
    maximumDisplacementAway = Math.max(maximumDisplacementAway, displacementAway);
  };

  victim.on("entityHurt", onHurt);
  victim.on("health", onHealth);
  victim.on("physicsTick", observeMotion);
  victim.on("move", observeMotion);
  return {
    snapshot: () => ({ damageEvents, healthBefore, minimumHealth, maximumVelocityAway, maximumDisplacementAway }),
    close: () => {
      victim.removeListener("entityHurt", onHurt);
      victim.removeListener("health", onHealth);
      victim.removeListener("physicsTick", observeMotion);
      victim.removeListener("move", observeMotion);
    },
  };
}
