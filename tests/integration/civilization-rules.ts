import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { BotEvents } from "mineflayer";

import { PathDiagnosticRing } from "@arena/bots";
import { blockPosition, type BlockPosition } from "@arena/core";

import {
  assertCivilizationRoster,
  assertRouteAvoidsOutpost,
  assertInitialRouteUsesOutpostFootprint,
  assertSucceeded,
  civilizationActionLayout,
  civilizationClientForSeat,
  civilizationMaterialBaseline,
  eliminateCivilizationWithSkillAttacks,
  prepareCivilizationFactionMaterials,
  placeCivilizationFactionOutpost,
  recordCivilizationAction,
  runArenaSkill,
  runCivilizationSkill,
  waitForCivilizationObservation,
  waitForCivilizationPhase,
  withdrawCivilizationOutpostMaterials,
  runOwnedCivilizationAcceptanceScenario,
} from "../acceptance/civilization.js";
import {
  assertCrossFactionCombat,
  type CivilizationActionEvidence,
  type CivilizationCombatEngagement,
  type CivilizationFactionActionLayout,
} from "../acceptance/civilization-action-evidence.js";
import {
  assertCivilizationCargoDeaths,
  assertCivilizationPlacedPositionsPresent,
  parseCivilizationMaterialLog,
} from "../acceptance/civilization-material-evidence.js";
import type { AcceptanceRunContext } from "./support/owned-run.js";

const SCENARIO_PATH = "scenarios/civilization-six.toml";
const TEST_TIMEOUT_MS = 1_200_000 + 60_000;
const CANCELLATION_TIMEOUT_MS = 15_000;

test("civilization-rules", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const actions: CivilizationActionEvidence[] = [];
  const engagements: CivilizationCombatEngagement[] = [];
  let baseline: ReturnType<typeof civilizationMaterialBaseline> | undefined;
  let outpostCells: readonly BlockPosition[] = [];

  const run = await runOwnedCivilizationAcceptanceScenario(
    SCENARIO_PATH,
    "civilization-rules",
    async (active, signal) => {
      const scenario = assertCivilizationRoster(active);
      const layout = civilizationActionLayout(scenario);
      baseline = civilizationMaterialBaseline(scenario);
      outpostCells = layout.ember.outpostCells.map(({ position }) => position);
      await active.start();
      await waitForCivilizationPhase(active, "grace", signal);
      await waitForCivilizationPhase(active, "active", signal);

      const captureTarget = centerOfCaptureZone(scenario.civilization.captureZone.min,
        scenario.civilization.captureZone.max);
      await assertClientSkillCancellation(active, 2, captureTarget, actions, signal);

      await prepareCivilizationFactionMaterials(active, 0, layout.ember, actions, signal);
      const stalePosition = layout.ember.naturalOakLogSources[5];
      assert.ok(stalePosition, "Ember base must expose an unused source for the stale-target check");
      await assertStaleNaturalLogTarget(active, stalePosition, actions, signal);

      const home = scenario.map.spawns.find(({ seat }) => seat === 0);
      assert.ok(home, "Ember gatherer must have its configured home spawn");
      await navigateWithGoal(active, 0, home.position, { kind: "explore" }, actions, signal);

      const routeTarget = beyondOutpostTarget(layout.ember);
      const routeActor = civilizationClientForSeat(active, 0);
      const diagnostics = new PathDiagnosticRing(active.competitors.find(({ seat }) => seat === 0)!.bot, {
        clientLabel: "civilization-rules-seat-0",
        clock: () => ({ clientMs: performance.now(), authorityTick: currentMatchTick(active) }),
      });
      try {
        await navigateWithGoal(active, 0, routeTarget, { kind: "explore" }, actions, signal);
        const beforeBuild = diagnostics.snapshot();
        assertInitialRouteUsesOutpostFootprint(beforeBuild, layout.ember);

        await withdrawCivilizationOutpostMaterials(active, 1, layout.ember, actions, signal);
        await assertContendedMaterialWithdrawal(active, layout.ember, actions, signal);
        await placeCivilizationFactionOutpost(active, 1, layout.ember, actions, signal);
        await waitForPlacedOutpostObservation(active, routeActor, layout.ember, signal);

        const beforeReroute = diagnostics.snapshot().length;
        await navigateWithGoal(active, 0, home.position, { kind: "explore" }, actions, signal);
        assertRouteAvoidsOutpost(diagnostics.snapshot(), beforeReroute, layout.ember);
      } finally {
        diagnostics.close();
      }

      await Promise.all([
        navigateWithGoal(active, 2, captureTarget, { kind: "explore" }, actions, signal),
        navigateWithGoal(active, 3, captureTarget, { kind: "explore" }, actions, signal),
        navigateWithGoal(active, 4, captureTarget, { kind: "explore" }, actions, signal),
        navigateWithGoal(active, 5, captureTarget, { kind: "explore" }, actions, signal),
      ]);
      for (const victimSeat of [3, 4, 5]) {
        engagements.push(await eliminateCivilizationWithSkillAttacks(active, 2, victimSeat, actions, signal));
      }
      await active.waitForOutcome();
    },
    t.signal,
  );

  assert.ok(baseline, "the completed run must retain its prepared material baseline");
  assert.ok(run.outcome.kind === "faction_winner", "civilization-rules must reach an ordinary faction outcome");
  if (run.outcome.kind !== "faction_winner") throw new Error("civilization-rules did not produce a faction winner");
  assert.equal(run.outcome.winner_faction_id, "ember");
  assert.equal(run.outcome.reason, "elimination");
  assert.deepStrictEqual(run.outcome.survivors, [0, 1, 2]);
  assertCrossFactionCombat(engagements);

  const records = parseCivilizationMaterialLog(run.materialLog, run.runId);
  const checkpoints = records.flatMap((record) => record.kind === "checkpoint" ? [record.checkpoint] : []);
  assertCivilizationCargoDeaths(records, run.events, baseline);
  const finalCheckpoint = checkpoints.at(-1);
  assert.ok(finalCheckpoint, "the completed rules run must retain a final material checkpoint");
  assertCivilizationPlacedPositionsPresent(finalCheckpoint, outpostCells, "the Ember outpost");
  assert.ok(actions.some((action) => action.outcome.kind === "cancelled"
    && action.outcome.reason === "replaced"), "the cancellation case must retain its completed cancelled outcome");
  assert.ok(actions.some((action) => action.intent.kind === "mineBlock"
    && action.outcome.kind === "failed" && action.outcome.cause === "preconditionsNotMet"),
  "the stale natural-log plan must fail against the changed world block");
});

async function assertClientSkillCancellation(
  active: AcceptanceRunContext,
  seat: number,
  target: BlockPosition,
  actions: CivilizationActionEvidence[],
  signal: AbortSignal,
): Promise<void> {
  const client = civilizationClientForSeat(active, seat);
  const competitor = active.competitors.find((candidate) => candidate.seat === seat);
  assert.ok(competitor, `civilization runtime must contain seat ${seat}`);
  const ring = new PathDiagnosticRing(competitor.bot, {
    clientLabel: `civilization-cancel-seat-${seat}`,
    clock: () => ({ clientMs: performance.now(), authorityTick: currentMatchTick(active) }),
  });
  try {
    const intent = { kind: "navigate" as const, target };
    const pending = recordCivilizationAction(actions, seat, { kind: "explore" }, intent,
      () => runArenaSkill(client, intent, signal));
    await waitForNavigationStart(ring, signal);
    await client.cancel("replaced");
    const outcome = await pending;
    assert.deepStrictEqual(outcome, { kind: "cancelled", reason: "replaced" },
      "client cancellation must settle the owned navigation skill with its cancellation reason");
  } finally {
    ring.close();
  }
}

async function waitForNavigationStart(ring: PathDiagnosticRing, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + CANCELLATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (ring.snapshot().some((record) => record.kind === "navigation" && record.active)) return;
    await delay(20, undefined, { signal });
  }
  throw new Error(`civilization cancellation navigation did not start within ${CANCELLATION_TIMEOUT_MS} ms`);
}

async function assertStaleNaturalLogTarget(
  active: AcceptanceRunContext,
  position: BlockPosition,
  actions: CivilizationActionEvidence[],
  signal: AbortSignal,
): Promise<void> {
  const miner = civilizationClientForSeat(active, 0);
  const planner = civilizationClientForSeat(active, 1);
  const sourceBaseY = Math.min(...active.preparedRun.scenario.map.blocks
    .filter(({ block, position: candidate }) => block === "minecraft:oak_log"
      && candidate.x === position.x && candidate.z === position.z)
    .map(({ position: candidate }) => candidate.y));
  assert.ok(Number.isSafeInteger(sourceBaseY), "the stale natural log must have a reachable base block");
  const sourceBase = blockPosition(position.x, sourceBaseY, position.z);

  await navigateWithGoal(active, 1, sourceBase, { kind: "explore" }, actions, signal);
  await navigateWithGoal(active, 0, sourceBase, { kind: "explore" }, actions, signal);
  const plannedObservation = await waitForCivilizationObservation(active, planner, signal,
    `seat 1 to observe shared natural oak log ${position.x},${position.y},${position.z}`,
    (observation) =>
    observation.observedResources.kind === "current"
    && observation.observedResources.value.some((resource) => resource.kind === "logBlock"
      && samePosition(resource.position, position)));
  assert.equal(plannedObservation.observedResources.kind, "current");
  if (plannedObservation.observedResources.kind !== "current") throw new Error("planned log observation is unavailable");

  const plannerCompetitor = active.competitors.find(({ seat }) => seat === 1);
  assert.ok(plannerCompetitor, "the stale-plan client must be in the live roster");
  const plannerBot = plannerCompetitor.bot;
  let singleBlockChangePackets = 0;
  let multiBlockChangePackets = 0;
  let targetBlockUpdates = 0;
  const onSingleBlockChange = (): void => { singleBlockChangePackets += 1; };
  const onMultiBlockChange = (): void => { multiBlockChangePackets += 1; };
  const onBlockUpdate: BotEvents["blockUpdate"] = (_oldBlock, newBlock) => {
    if (samePosition(newBlock.position, position)) targetBlockUpdates += 1;
  };
  plannerBot._client.on("block_change", onSingleBlockChange);
  plannerBot._client.on("multi_block_change", onMultiBlockChange);
  plannerBot.on("blockUpdate", onBlockUpdate);

  const mineIntent = { kind: "mineBlock" as const, position, expectedBlock: "oak_log" as const };
  try {
    const mined = await recordCivilizationAction(actions, 0,
      { kind: "gatherMaterial", item: "oak_log", target: position }, mineIntent,
      () => runCivilizationSkill(miner, mineIntent, signal));
    assertSucceeded(mined, "the first client must mine the shared natural oak log");

    try {
      await waitForCivilizationObservation(active, planner, signal,
        `seat 1 to observe removal of shared natural oak log ${position.x},${position.y},${position.z}`,
        (observation) =>
        observation.observedResources.kind === "current"
        && !observation.observedResources.value.some((resource) => resource.kind === "logBlock"
          && samePosition(resource.position, position)));
    } catch (error) {
      const oakLogId = plannerBot.registry.blocksByName.oak_log?.id;
      const targetStillLoaded = oakLogId !== undefined && plannerBot.findBlocks({
        matching: oakLogId,
        maxDistance: 40,
        count: 64,
      }).some((candidate) => samePosition(candidate, position));
      throw new Error(
        `seat 1 did not observe the mined log removal; single_block_change_packets=${singleBlockChangePackets}; `
        + `multi_block_change_packets=${multiBlockChangePackets}; target_block_updates=${targetBlockUpdates}; `
        + `target_still_loaded=${targetStillLoaded}`,
        { cause: error },
      );
    }
    const stale = await recordCivilizationAction(actions, 1,
      { kind: "gatherMaterial", item: "oak_log", target: position }, mineIntent,
      () => runCivilizationSkill(planner, mineIntent, signal));
    assert.deepStrictEqual(stale, { kind: "failed", cause: "preconditionsNotMet" },
      "a previously observed log target must fail once the server removes it");
  } finally {
    plannerBot._client.removeListener("block_change", onSingleBlockChange);
    plannerBot._client.removeListener("multi_block_change", onMultiBlockChange);
    plannerBot.removeListener("blockUpdate", onBlockUpdate);
  }
}

async function assertContendedMaterialWithdrawal(
  active: AcceptanceRunContext,
  layout: CivilizationFactionActionLayout,
  actions: CivilizationActionEvidence[],
  signal: AbortSignal,
): Promise<void> {
  const contenders = [1, 2] as const;
  const intent = {
    kind: "containerTransfer" as const, position: layout.chest,
    direction: "withdraw" as const, item: "oak_planks" as const, count: 1,
  };
  const outcomes = await Promise.all(contenders.map((seat) => recordCivilizationAction(actions, seat,
    { kind: "transferMaterial", item: "oak_planks", count: 1, direction: "withdraw", container: layout.chest },
    intent, () => runCivilizationSkill(civilizationClientForSeat(active, seat), intent, signal))));
  assert.equal(outcomes.filter((outcome) => outcome.kind === "succeeded").length, 1,
    "two simultaneous clients must not both withdraw the same final plank");
  assert.equal(outcomes.filter((outcome) => outcome.kind === "failed").length, 1,
    "the competing withdrawal must settle as an unavailable-material failure");
}

async function waitForPlacedOutpostObservation(
  active: AcceptanceRunContext,
  client: ReturnType<typeof civilizationClientForSeat>,
  layout: CivilizationFactionActionLayout,
  signal: AbortSignal,
): Promise<void> {
  await waitForCivilizationObservation(active, client, signal, "builder to observe all placed outpost cells", (observation) => {
    if (observation.observedResources.kind !== "current") return false;
    const placed = new Set(observation.observedResources.value
      .filter((resource) => resource.kind === "outpostCell" && resource.state === "oak_planks")
      .map((resource) => positionKey(resource.position)));
    return layout.outpostCells.every(({ position }) => placed.has(positionKey(position)));
  });
}

async function navigateWithGoal(
  active: AcceptanceRunContext,
  seat: number,
  target: BlockPosition,
  goal: CivilizationActionEvidence["goal"],
  actions: CivilizationActionEvidence[],
  signal: AbortSignal,
): Promise<void> {
  const client = civilizationClientForSeat(active, seat);
  const intent = { kind: "navigate" as const, target };
  const outcome = await recordCivilizationAction(actions, seat, goal, intent,
    () => runArenaSkill(client, intent, signal));
  assertSucceeded(outcome, `seat ${seat} must navigate to ${target.x},${target.y},${target.z}`);
}

function beyondOutpostTarget(layout: CivilizationFactionActionLayout): BlockPosition {
  const minX = Math.min(...layout.outpostCells.map(({ position }) => position.x));
  const minZ = Math.min(...layout.outpostCells.map(({ position }) => position.z));
  const y = layout.outpostCells[0]?.position.y;
  assert.ok(y !== undefined, "Ember outpost must have a configured blueprint cell");
  return blockPosition(minX + 10, y, minZ + 1);
}

function centerOfCaptureZone(min: BlockPosition, max: BlockPosition): BlockPosition {
  return blockPosition(Math.floor((min.x + max.x) / 2), min.y, Math.floor((min.z + max.z) / 2));
}

function currentMatchTick(active: AcceptanceRunContext): number {
  const clock = active.events().findLast((event) => event.type === "public_clock"
    && event.payload.tick?.domain === "match");
  assert.ok(clock && clock.type === "public_clock" && clock.payload.tick?.domain === "match",
    "civilization path diagnostics require the authenticated match clock");
  const tick = Number(clock.payload.tick.value);
  if (!Number.isSafeInteger(tick)) throw new RangeError("civilization match tick exceeds the safe observation range");
  return tick;
}

function samePosition(first: BlockPosition, second: BlockPosition): boolean {
  return first.x === second.x && first.y === second.y && first.z === second.z;
}

function positionKey(position: BlockPosition): string {
  return `${position.x},${position.y},${position.z}`;
}
