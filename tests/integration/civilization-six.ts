import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { blockPosition, type BlockPosition } from "@arena/core";
import type { CivilizationStatePayload } from "../../packages/arena-runner/src/control/types.js";

import {
  assertCivilizationRoster,
  assertSucceeded,
  civilizationActionLayout,
  civilizationMaterialBaseline,
  completeCivilizationFactionMaterialChain,
  civilizationClientForSeat,
  eliminateCivilizationWithSkillAttacks,
  recordCivilizationAction,
  runArenaSkill,
  waitForCivilizationPhase,
  runOwnedCivilizationAcceptanceScenario,
} from "../acceptance/civilization.js";
import {
  assertBothFactionsCompletedMaterialChain,
  assertCivilizationRoleContributions,
  assertCrossFactionCombat,
  type CivilizationActionEvidence,
  type CivilizationCombatEngagement,
} from "../acceptance/civilization-action-evidence.js";
import { assertCivilizationCaptureEvidence } from "../acceptance/civilization-capture-evidence.js";
import {
  assertCivilizationCargoDeaths,
  assertCivilizationOutpostsPresent,
  parseCivilizationMaterialLog,
  type CivilizationMaterialCheckpoint,
} from "../acceptance/civilization-material-evidence.js";
import type { AcceptanceRunContext } from "./support/owned-run.js";

const SCENARIO_PATH = "scenarios/civilization-six.toml";
const RUN_TIMEOUT_MS = 650_000;
const CAPTURE_TIMEOUT_MS = 300_000;

test("civilization-six", { timeout: RUN_TIMEOUT_MS }, async (t) => {
  const actions: CivilizationActionEvidence[] = [];
  const engagements: CivilizationCombatEngagement[] = [];
  let baseline: ReturnType<typeof civilizationMaterialBaseline> | undefined;
  let outpostPositions: BlockPosition[] = [];
  let captureSettings: { readonly graceTicks: bigint; readonly uncontestedCaptureTicks: bigint } | undefined;

  const run = await runOwnedCivilizationAcceptanceScenario(
    SCENARIO_PATH,
    "civilization-six",
    async (active, signal) => {
      const scenario = assertCivilizationRoster(active);
      const layout = civilizationActionLayout(scenario);
      baseline = civilizationMaterialBaseline(scenario);
      outpostPositions = [...layout.ember.outpostCells, ...layout.tide.outpostCells]
        .map(({ position }) => position);
      captureSettings = {
        graceTicks: scenario.matchSettings.graceTicks,
        uncontestedCaptureTicks: BigInt(scenario.civilization.captureZone.uncontestedTicks),
      };

      await active.start();
      await waitForCivilizationPhase(active, "grace", signal);
      await waitForCivilizationPhase(active, "active", signal);

      await Promise.all([
        completeCivilizationFactionMaterialChain(active, 0, 1, layout.ember, actions, signal),
        completeCivilizationFactionMaterialChain(active, 3, 4, layout.tide, actions, signal),
      ]);

      const captureTarget = centerOfCaptureZone(scenario.civilization.captureZone.min,
        scenario.civilization.captureZone.max);
      await navigateWithGoal(active, 2, captureTarget, { kind: "captureZone", target: captureTarget }, actions, signal);
      await waitForCaptureState(active, (state) => state.owner_faction === "ember"
        && state.occupants.includes(2), signal, "Ember must claim the capture zone with its defender present");

      const emberHome = scenario.map.spawns.find(({ seat }) => seat === 2);
      assert.ok(emberHome, "Ember defender must have its configured home spawn");
      await navigateWithGoal(active, 2, emberHome.position, { kind: "explore" }, actions, signal);
      await waitForCaptureState(active, (state) => !state.occupants.includes(2), signal,
        "Ember defender must leave the capture zone before the opponent's capture");

      await navigateWithGoal(active, 5, captureTarget, { kind: "captureZone", target: captureTarget }, actions, signal);
      await waitForCaptureState(active, (state) => state.owner_faction === "tide"
        && state.occupants.includes(5), signal, "Tide must recapture the zone with its defender present");

      await navigateWithGoal(active, 0, captureTarget, { kind: "explore" }, actions, signal);
      engagements.push(await eliminateCivilizationWithSkillAttacks(active, 5, 0, actions, signal));

      await Promise.all([
        navigateWithGoal(active, 2, captureTarget, { kind: "explore" }, actions, signal),
        navigateWithGoal(active, 3, captureTarget, { kind: "explore" }, actions, signal),
        navigateWithGoal(active, 4, captureTarget, { kind: "explore" }, actions, signal),
      ]);
      for (const victimSeat of [3, 4, 5]) {
        engagements.push(await eliminateCivilizationWithSkillAttacks(active, 2, victimSeat, actions, signal));
      }

      await active.waitForOutcome();
      assertCivilizationRoleContributions(actions, scenario.civilization.factions, layout);
      assertBothFactionsCompletedMaterialChain(actions, layout);
      assertCrossFactionCombat(engagements);
    },
    t.signal,
  );

  assert.ok(baseline, "the completed run must retain its prepared material baseline");
  assert.ok(captureSettings, "the completed run must retain its configured capture thresholds");
  assert.equal(run.competitors.length, 6, "completed evidence must retain all six connected competitors");
  assert.equal(run.outcome.kind, "faction_winner", "six-seat Civilization must finish with an ordinary faction winner");
  if (run.outcome.kind !== "faction_winner") throw new Error("civilization-six did not produce a faction winner");
  assert.equal(run.outcome.winner_faction_id, "ember");
  assert.equal(run.outcome.reason, "elimination");
  assert.deepStrictEqual(run.outcome.survivors, [1, 2]);
  assert.ok(run.events.some((event) => event.type === "outcome"
    && event.payload.kind === "faction_winner" && event.payload.winner_faction_id === "ember"),
  "the authenticated event stream must contain the ordinary Ember elimination outcome");

  const inspection = asObject(run.inspection.report, "arena inspect report must be an object");
  assert.equal(inspection.outcome_status, "reconstructed_from_authoritative_events");
  const inspectedOutcome = asObject(inspection.outcome, "arena inspect must contain the reconstructed outcome");
  assert.equal(inspectedOutcome.kind, "faction_winner");
  assert.equal(inspectedOutcome.winner_faction_id, "ember");
  assert.equal(inspectedOutcome.reason, "elimination");
  assert.deepStrictEqual(inspectedOutcome.survivors, [1, 2]);

  const records = parseCivilizationMaterialLog(run.materialLog, run.runId);
  const checkpoints = records.flatMap((record) => record.kind === "checkpoint" ? [record.checkpoint] : []);
  assertCivilizationCargoDeaths(records, run.events, baseline);
  const finalCheckpoint = checkpoints.at(-1);
  assert.ok(finalCheckpoint, "the completed run must retain a final authoritative material checkpoint");
  assertCivilizationOutpostsPresent(finalCheckpoint, outpostPositions);
  assertCivilizationCaptureEvidence(run.events, captureSettings);

  const cargoDeath = records.find((record) => record.kind === "death_cargo"
    && record.death.seat === 0);
  assert.ok(cargoDeath && cargoDeath.kind === "death_cargo", "seat zero must die carrying gathered wood");
  assert.ok(cargoDeath.death.oakLogs > 0 && cargoDeath.death.droppedOakLogs > 0,
    "the defeated gatherer must drop its observed oak log cargo");
});

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
  assertSucceeded(outcome, `seat ${seat} must navigate to ${positionString(target)}`);
}

async function waitForCaptureState(
  active: AcceptanceRunContext,
  condition: (state: CivilizationStatePayload) => boolean,
  signal: AbortSignal,
  description: string,
): Promise<void> {
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const latest = active.events().findLast((event) => event.type === "civilization_state");
    if (latest?.type === "civilization_state" && condition(latest.payload)) return;
    await delay(100, undefined, { signal });
  }
  throw new Error(`${description} within ${CAPTURE_TIMEOUT_MS} ms`);
}

function centerOfCaptureZone(min: BlockPosition, max: BlockPosition): BlockPosition {
  return blockPosition(Math.floor((min.x + max.x) / 2), min.y, Math.floor((min.z + max.z) / 2));
}

function asObject(value: unknown, description: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object", description);
  return value as Record<string, unknown>;
}

function positionString(position: BlockPosition): string {
  return `(${position.x}, ${position.y}, ${position.z})`;
}
