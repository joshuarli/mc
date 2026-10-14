import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PathDiagnosticRing } from "@arena/bots";
import { blockPosition, inventorySlot } from "@arena/core";
import type { Bot } from "mineflayer";
import { test } from "node:test";

import { stageOwnedFile } from "../../packages/arena-runner/src/owned-files/index.js";
import { RunnerError } from "../../packages/arena-runner/src/errors.js";
import {
  assertDeathWinner,
  competitorForSeat,
  eliminateOpponentWithSkillAttacks,
  runEvaluatorSkill,
  stageOpponentForCombat,
  waitForActivePhase,
} from "./support/duel.js";
import { observePlayerInventory } from "./support/mineflayer-world.js";
import {
  runOwnedAcceptanceScenario,
  type AcceptanceRunContext,
} from "./support/owned-run.js";
import {
  captureDuelCombatWindow,
  MAX_DUEL_COMBAT_DIAGNOSTIC_BYTES,
  serializeDuelCombatDiagnosticArtifact,
  type DuelCombatDiagnosticArtifact,
} from "./support/duel-diagnostics.js";
import {
  serializeRampPathDiagnosticArtifact,
  type RampArrivalReceipt,
  type RampPathDiagnosticArtifact,
} from "./support/ramp-path-diagnostics.js";
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
const RAMP_DIAGNOSTIC_MAX_BYTES = 32 * 1024 * 1024;

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

      const diagnostics = createRampPathDiagnostics(active, seatZero.bot);
      try {
        const initialFood = seatZero.bot.food;
        assert.equal(initialFood, 20, "prepared competitor must begin with full food and reset saturation");
        const jumpEvidence = await depleteFoodBySprintJump(seatZero.bot, signal, diagnostics);
        assert.ok(jumpEvidence.takeoffs >= 8, "food loss must follow repeated client-observed sprint-jumps");
        assert.ok(jumpEvidence.highestY > jumpEvidence.startingY + 0.4, "sprint-jumps must include a real upward movement");
        assert.ok(jumpEvidence.remainingFood < initialFood, "ordinary movement must lower the server-observed food level");
        const hungry = await waitForCurrentAgent(seatZero, signal);
        assert.equal(hungry.agent.kind, "current");
        if (hungry.agent.kind !== "current") throw new Error("hungry player observation did not become current");
        assert.ok(hungry.agent.value.hungerPoints < initialFood, "the permitted player observation must report the food loss");

        await navigateOverRamp(active, seatZero.bot, seatZero.client, seatOne.bot, ramp, signal, {
          beyond: {
            x: ramp.position.x + 9,
            y: ramp.position.y,
            z: ramp.position.z - 4,
          },
        }, diagnostics);
        diagnostics.snapshot();
      } finally {
        diagnostics.close();
      }
      assert.deepStrictEqual(
        await runEvaluatorSkill(seatZero.client, { kind: "navigate", target: chest.position }, signal),
        { kind: "succeeded" },
        "the Mineflayer pathfinder skill must reach the declared chest route",
      );
      assert.deepStrictEqual(
        await runEvaluatorSkill(seatZero.client, { kind: "containerOpen", position: chest.position }, signal),
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
        await runEvaluatorSkill(seatZero.client, { kind: "eat", inventorySlot: inventorySlot(bread.slot) }, signal),
        { kind: "succeeded" },
        "the ordinary eating skill must consume the looted bread after sprint-jump food loss",
      );
      const fed = await waitForCurrentAgent(seatZero, signal);
      assert.equal(fed.agent.kind, "current");
      if (fed.agent.kind !== "current") throw new Error("fed player observation did not become current");
      assert.ok(fed.agent.value.hungerPoints > foodBeforeEating, "the player observation must report food restored by eating");
      const inventoryAfterEating = observePlayerInventory(seatZero.bot);
      assert.ok(
        !inventoryAfterEating.items.some(({ item }) => item === "minecraft:bread"),
        "the client inventory must show the consumed bread was removed",
      );

      const observation = await waitForCurrentAgent(seatZero, signal);
      assert.equal(observation.agent.kind, "current");
      const weapon = observation.agent.value.upgrades.find((upgrade) => upgrade.equipmentSlot === "weapon");
      assert.ok(weapon, "the complete client observation must recognize the received sword as an upgrade");
      assert.deepStrictEqual(
        await runEvaluatorSkill(seatZero.client, {
          kind: "equip",
          inventorySlot: weapon.inventorySlot,
          equipmentSlot: "weapon",
          rating: weapon.rating,
        }, signal),
        { kind: "succeeded" },
        "the ordinary equip skill must place the received sword in the weapon slot",
      );
      const equipped = await waitForCurrentAgent(seatZero, signal);
      assert.equal(equipped.agent.kind, "current");
      assert.equal(equipped.agent.value.equipped.weapon, weapon.rating);

      await stageOpponentForCombat(active, 1, blockPosition(40, 65, 32), signal);
      const knockback = recordKnockbackReceipt(seatOne.bot, seatZero.bot.entity.id);
      await captureDuelCombatWindow(
        {
          active,
          attackerSeat: 0,
          targetSeat: 1,
          snapshotKnockback: () => knockback.snapshot(),
          closeKnockback: () => knockback.close(),
          stageArtifact: async (artifact) => { await stageDuelCombatDiagnostics(active, artifact); },
          runCombat: (diagnostics) => eliminateOpponentWithSkillAttacks(active, 0, 1, signal, diagnostics),
        },
      );
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

test("legal-player-ramp", { timeout: 300_000 }, async (t) => {
  const run = await runOwnedAcceptanceScenario(
    "tests/integration/fixtures/legal-player-ramp.toml",
    "legal-player-ramp",
    async (active, signal) => {
      const seatZero = competitorForSeat(active, 0);
      const seatOne = competitorForSeat(active, 1);
      const ramp = active.preparedRun.scenario.map.blocks.find(({ block, position }) =>
        block === "minecraft:cobblestone" && position.x === 31 && position.z === 21,
      );
      assert.ok(ramp, "duel map must provide the declared ramp");

      await active.start();
      await waitForActivePhase(active, signal);
      const approach = blockPosition(ramp.position.x - 1, ramp.position.y, ramp.position.z);
      await navigateOverRamp(active, seatZero.bot, seatZero.client, seatOne.bot, ramp, signal, { approach });
      await active.waitForOutcome();
    },
    t.signal,
    { competitorDriver: "evaluator" },
  );

  assert.equal(run.outcome.kind, "draw");
  if (run.outcome.kind !== "draw") throw new Error("ramp diagnostic run did not reach its natural tick-limit draw");
  assert.equal(run.outcome.reason, "tick_limit");
  assert.equal(run.outcome.at?.domain, "match");
  assert.equal(run.outcome.at?.value, 800n);
  assert.deepStrictEqual(run.outcome.survivors, [0, 1]);

  const report = record(run.inspection.report, "arena inspect must include the ramp run report");
  assert.equal(report.outcome_status, "reconstructed_from_authoritative_events");
  const outcome = record(report.outcome, "arena inspect must include the reconstructed tick-limit draw");
  assert.equal(outcome.kind, "draw");
  assert.equal(outcome.reason, "tick_limit");
  const at = record(outcome.at, "arena inspect draw must include its event time");
  assert.equal(at.domain, "match");
  assert.equal(at.value, "800");
});

async function waitForCurrentAgent(
  competitor: AcceptanceRunContext["competitors"][number],
  signal: AbortSignal,
) {
  const gameplay = competitor.gameplay;
  if (gameplay.mode !== "hunger_games") throw new Error("player observation evaluator requires Hunger Games");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const observation = gameplay.client.observe(0);
    if (observation.agent.kind === "current") return observation;
    await delay(50, undefined, { signal });
  }
  throw new Error("Mineflayer agent state did not become current within 20000 ms");
}

async function depleteFoodBySprintJump(
  bot: Bot,
  signal: AbortSignal,
  diagnostics: PathDiagnosticRing,
): Promise<{
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
  diagnostics.setExternalMovementOwner("sprintCourse");
  bot.on("physicsTick", onPhysicsTick);
  let course: ReturnType<typeof startSprintCourse> | undefined;

  const deadline = Date.now() + FOOD_DEPLETION_TIMEOUT_MS;
  try {
    course = startSprintCourse(bot);
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
    try {
      course?.stop();
    } finally {
      bot.removeListener("physicsTick", onPhysicsTick);
      diagnostics.setExternalMovementOwner(null);
    }
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
  active: AcceptanceRunContext,
  bot: Bot,
  client: AcceptanceRunContext["competitors"][number]["client"],
  observer: Bot,
  ramp: { readonly position: { readonly x: number; readonly y: number; readonly z: number } },
  signal: AbortSignal,
  route: Readonly<{
    approach?: ReturnType<typeof blockPosition>;
    beyond?: { readonly x: number; readonly y: number; readonly z: number };
  }> = {},
  suppliedDiagnostics?: PathDiagnosticRing,
): Promise<void> {
  const diagnostics = suppliedDiagnostics ?? createRampPathDiagnostics(active, bot);
  const closeDiagnostics = suppliedDiagnostics === undefined;
  const target = blockPosition(ramp.position.x, ramp.position.y + 1, ramp.position.z);
  let traversedRamp = false;
  let observerReceivedRampTop = false;
  let ownArrivalReceipt: RampArrivalReceipt | null = null;
  let observerArrivalReceipt: RampArrivalReceipt | null = null;
  const observePosition = (): void => {
    const position = bot.entity.position;
    if (!isAtRampTop(position, ramp.position)) return;
    traversedRamp = true;
    ownArrivalReceipt ??= rampArrivalReceipt(active, position);
  };
  const observeRemotePosition = (entity: Bot["entity"]): void => {
    if (entity.id === bot.entity.id && isAtRampTop(entity.position, ramp.position)) {
      observerReceivedRampTop = true;
      observerArrivalReceipt ??= rampArrivalReceipt(active, entity.position);
    }
  };
  let records: ReturnType<PathDiagnosticRing["snapshot"]>;
  try {
    if (route.approach !== undefined) {
      signal.throwIfAborted();
      assert.deepStrictEqual(
        await runEvaluatorSkill(client, { kind: "navigateToBlock", target: route.approach }, signal),
        { kind: "succeeded" },
        "the pathfinder skill must reach the west-adjacent floor block before the ramp",
      );
      assert.ok(
        isAtBlock(bot.entity.position, route.approach),
        "the client must reach the exact west-adjacent floor block before climbing",
      );
    }

    bot.on("move", observePosition);
    bot.on("physicsTick", observePosition);
    observer.on("entityMoved", observeRemotePosition);
    signal.throwIfAborted();
    assert.deepStrictEqual(
      await runEvaluatorSkill(client, { kind: "navigateToBlock", target }, signal),
      { kind: "succeeded" },
      "the pathfinder skill must climb onto the existing ramp",
    );
    if (isAtRampTop(bot.entity.position, ramp.position)) observePosition();
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
    if (route.beyond !== undefined) {
      signal.throwIfAborted();
      assert.deepStrictEqual(
        await runEvaluatorSkill(client, { kind: "navigate", target: route.beyond }, signal),
        { kind: "succeeded" },
        "the pathfinder skill must continue along the route beyond the existing ramp",
      );
    }
    records = diagnostics.snapshot();
  } catch (error) {
    diagnostics.close();
    let failureRecords: ReturnType<PathDiagnosticRing["snapshot"]>;
    try {
      failureRecords = diagnostics.snapshot();
    } catch (captureError) {
      throw new AggregateError(
        [error, captureError],
        `ramp route failed and path diagnostics could not be captured: ${truncateCodePoints(describeRunFailure(error), 160)}`,
      );
    }

    let artifactPath: string;
    try {
      artifactPath = await stageRampPathDiagnostics(active, {
        target,
        ownArrivalReceipt,
        observerArrivalReceipt,
        records: failureRecords,
      });
    } catch (stageError) {
      throw new AggregateError(
        [error, stageError],
        `ramp route failed and path diagnostics could not be staged: ${truncateCodePoints(describeRunFailure(error), 160)}`,
      );
    }
    const reason = `ramp route failed: ${truncateCodePoints(describeRunFailure(error), 160)}`
      + `; diagnostics=${summarizeRampDiagnostics(failureRecords, ramp.position)}`
      + `; artifact=${artifactPath}`;
    throw new Error(reason, { cause: error });
  } finally {
    if (closeDiagnostics) diagnostics.close();
    bot.removeListener("move", observePosition);
    bot.removeListener("physicsTick", observePosition);
    observer.removeListener("entityMoved", observeRemotePosition);
  }
  await stageRampPathDiagnostics(active, {
    target,
    ownArrivalReceipt,
    observerArrivalReceipt,
    records,
  });
  assert.ok(traversedRamp, "the client must observe its own position above the ramp while navigating over it");
}

function isAtRampTop(
  position: { readonly x: number; readonly y: number; readonly z: number },
  ramp: { readonly x: number; readonly y: number; readonly z: number },
): boolean {
  return Math.floor(position.x) === ramp.x
    && Math.floor(position.y) === ramp.y + 1
    && Math.floor(position.z) === ramp.z;
}

function isAtBlock(
  position: { readonly x: number; readonly y: number; readonly z: number },
  target: ReturnType<typeof blockPosition>,
): boolean {
  return Math.floor(position.x) === target.x
    && Math.floor(position.y) === target.y
    && Math.floor(position.z) === target.z;
}

function createRampPathDiagnostics(active: AcceptanceRunContext, bot: Bot): PathDiagnosticRing {
  return new PathDiagnosticRing(bot, {
    clientLabel: "seat-0",
    clock: () => ({
      clientMs: performance.now(),
      authorityTick: latestMatchTick(active),
    }),
  });
}

function rampArrivalReceipt(
  active: AcceptanceRunContext,
  position: { readonly x: number; readonly y: number; readonly z: number },
): RampArrivalReceipt {
  return {
    clientMs: performance.now(),
    authorityTick: latestMatchTick(active),
    position: { x: position.x, y: position.y, z: position.z },
  };
}

function latestMatchTick(active: AcceptanceRunContext): number | null {
  const clock = active.events().findLast((event) =>
    event.type === "public_clock" && event.payload.tick?.domain === "match",
  );
  if (clock?.type !== "public_clock" || clock.payload.tick?.domain !== "match") return null;
  const tick = Number(clock.payload.tick.value);
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new RangeError(`match diagnostic tick must be a non-negative safe integer: ${clock.payload.tick.value}`);
  }
  return tick;
}

async function stageRampPathDiagnostics(
  active: AcceptanceRunContext,
  artifact: RampPathDiagnosticArtifact,
): Promise<string> {
  const repositoryRoot = process.cwd();
  const helperPath = process.env.ARENA_FS_HELPER ?? resolve(repositoryRoot, ".work/arena-fs/arena-fs");
  const relativePath = Buffer.concat([
    active.preparedRun.runDirectoryPath,
    Buffer.from("/ramp-path-diagnostics.json", "ascii"),
  ]);
  const contents = serializeRampPathDiagnosticArtifact(artifact);
  if (contents.byteLength > RAMP_DIAGNOSTIC_MAX_BYTES) {
    throw new RangeError(`ramp path diagnostics exceeded ${RAMP_DIAGNOSTIC_MAX_BYTES} bytes`);
  }
  await stageOwnedFile({
    helperPath,
    ownedRoot: Buffer.from(repositoryRoot, "utf8"),
    relativePath,
    contents,
    maxBytes: RAMP_DIAGNOSTIC_MAX_BYTES,
  });
  return relativePath.toString("utf8");
}

async function stageDuelCombatDiagnostics(
  active: AcceptanceRunContext,
  artifact: DuelCombatDiagnosticArtifact,
): Promise<void> {
  const repositoryRoot = process.cwd();
  const helperPath = process.env.ARENA_FS_HELPER ?? resolve(repositoryRoot, ".work/arena-fs/arena-fs");
  const relativePath = Buffer.concat([
    active.preparedRun.runDirectoryPath,
    Buffer.from("/duel-combat-diagnostics.json", "ascii"),
  ]);
  const contents = serializeDuelCombatDiagnosticArtifact(artifact);
  await stageOwnedFile({
    helperPath,
    ownedRoot: Buffer.from(repositoryRoot, "utf8"),
    relativePath,
    contents,
    maxBytes: MAX_DUEL_COMBAT_DIAGNOSTIC_BYTES,
  });
}

function summarizeRampDiagnostics(
  records: ReturnType<PathDiagnosticRing["snapshot"]>,
  ramp: { readonly x: number; readonly y: number; readonly z: number },
): string {
  const kinds: Record<string, number> = {};
  for (const record of records) kinds[record.kind] = (kinds[record.kind] ?? 0) + 1;
  const physics = records.findLast((record) => record.kind === "physicsTick");
  const path = records.findLast((record) => record.kind === "pathUpdate");
  const correction = records.findLast((record) => record.kind === "positionCorrection");
  const summary = {
    count: records.length,
    kinds,
    last: records.at(-1)?.kind ?? null,
    physics: physics === undefined ? null : {
      tick: physics.authorityTick,
      owner: physics.owner,
      navigation: physics.navigationActive,
      position: physics.position,
      velocity: physics.velocity,
      onGround: physics.onGround,
      collision: [physics.collidedHorizontally, physics.collidedVertically],
      control: physics.control,
      goal: physics.goal,
      path: physics.path === null ? null : {
        status: physics.path.status,
        contextTimeMs: physics.path.contextTimeMs,
        nodeCount: physics.path.nodeCount,
        visitedNodes: physics.path.visitedNodes,
      },
      rampBlocks: physics.blocks.filter(({ position }) =>
        (position.x === ramp.x && position.y === ramp.y && position.z === ramp.z)
        || (position.x === ramp.x - 1 && position.y === ramp.y && position.z === ramp.z),
      ).map(({ position, loaded, name, stateId, shapes }) => ({
        position,
        loaded,
        name,
        stateId,
        shapes: shapes.slice(0, 2),
      })),
    },
    pathUpdate: path === undefined ? null : {
      tick: path.authorityTick,
      status: path.path.status,
      cost: path.path.cost,
      contextTimeMs: path.path.contextTimeMs,
      visitedNodes: path.path.visitedNodes,
      nodes: path.path.nodes.slice(0, 3),
    },
    correction: correction === undefined ? null : {
      tick: correction.authorityTick,
      packet: correction.packet,
      position: correction.resultingPosition,
      velocity: correction.resultingVelocity,
    },
  };
  return truncateCodePoints(JSON.stringify(summary), 520);
}

function describeRunFailure(error: unknown): string {
  if (error instanceof RunnerError) {
    const reason = error.source.reason === undefined ? "" : `: ${error.source.reason}`;
    return `${error.category}/${error.source.kind}${reason}`;
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function truncateCodePoints(value: string, maximum: number): string {
  let result = "";
  let count = 0;
  for (const character of value) {
    if (count === maximum) return `${result}…`;
    result += character;
    count += 1;
  }
  return result;
}

function record(value: unknown, message: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object", message);
  return value as Record<string, unknown>;
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
