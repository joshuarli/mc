import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import type { BlockPosition, CivilizationRole } from "@arena/core";
import type { PolicyActivityEvent } from "../../packages/arena-runner/src/runtime/live-policy-loop.js";
import type { RuntimeAuthorityEvent } from "../../packages/arena-runner/src/runtime/types.js";
import { MAX_TRACE_SEGMENT_BYTES, parseSegment } from "../../packages/arena-runner/src/trace.js";
import { readOwnedFile } from "../../packages/arena-runner/src/owned-files/index.js";
import {
  assertCivilizationMaterialConservation,
  assertCivilizationCargoDeaths,
  assertCivilizationPlacedPositionsPresent,
  parseCivilizationMaterialLog,
} from "./civilization-material-evidence.js";
import { createHungerRunMeasurements, type HungerResourcePhaseEvidence } from "./hunger-measurements.js";
import {
  assertCivilizationRoster,
  civilizationActionLayout,
  civilizationMaterialBaseline,
  runOwnedCivilizationAcceptanceScenario,
} from "./civilization.js";
import type { AcceptanceRunContext } from "../integration/support/owned-run.js";

const SCENARIO_PATH = "scenarios/civilization-six.toml";
const RUN_TIMEOUT_MS = 1_200_000;
const TEST_TIMEOUT_MS = RUN_TIMEOUT_MS + 60_000;
const MAX_POLICY_RECORDS = 100_000;

interface MutableSeatActivity {
  decisionCount: number;
  actionCount: number;
  successfulActionCount: number;
  failedActionCount: number;
  readonly goalCounts: Map<string, number>;
  readonly intentCounts: Map<string, number>;
  readonly successfulIntentCounts: Map<string, number>;
  readonly minedNaturalLogPositions: Set<string>;
  craftedOakPlanks: number;
  depositedOakPlanks: number;
  withdrawnOakPlanks: number;
  readonly placedOutpostPositions: Set<string>;
  successfulNavigations: number;
  readonly actionSequences: Set<string>;
}

interface SeatActivitySnapshot {
  readonly decisionCount: number;
  readonly actionCount: number;
  readonly successfulActionCount: number;
  readonly failedActionCount: number;
  readonly goalCounts: Readonly<Record<string, number>>;
  readonly intentCounts: Readonly<Record<string, number>>;
  readonly successfulIntentCounts: Readonly<Record<string, number>>;
  readonly minedNaturalLogPositions: readonly string[];
  readonly craftedOakPlanks: number;
  readonly depositedOakPlanks: number;
  readonly withdrawnOakPlanks: number;
  readonly placedOutpostPositions: readonly string[];
  readonly successfulNavigations: number;
  readonly actionSequences: ReadonlySet<string>;
}

interface TraceSeatActivity {
  decisionCount: number;
  readonly actionSequences: Set<string>;
}

interface CivilizationPolicyTraceEvidence {
  readonly decisionsBySeat: ReadonlyMap<number, number>;
  readonly actionSequencesBySeat: ReadonlyMap<number, ReadonlySet<string>>;
  readonly decisionRecordCount: number;
  readonly effectRecordCount: number;
}

test("civilization-baseline", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const activity = createCivilizationSeatActivity();
  const measurements = createHungerRunMeasurements([0, 1, 2, 3, 4, 5]);
  let scenario: ReturnType<typeof assertCivilizationRoster> | undefined;
  let layout: ReturnType<typeof civilizationActionLayout> | undefined;
  let materialBaseline: ReturnType<typeof civilizationMaterialBaseline> | undefined;

  const run = await runOwnedCivilizationAcceptanceScenario(
    SCENARIO_PATH,
    "civilization-baseline",
    async (active, signal) => {
      scenario = assertCivilizationRoster(active);
      layout = civilizationActionLayout(scenario);
      materialBaseline = civilizationMaterialBaseline(scenario);
      activity.setScenarioPositions(scenario.map.blocks
        .filter(({ block }) => block === "minecraft:oak_log")
        .map(({ position }) => position),
      layout.ember.outpostCells.concat(layout.tide.outpostCells).map(({ position }) => position));

      await active.start();
      await waitForCivilizationActive(active, signal);
      measurements.markActiveBoundary(process.hrtime.bigint());
      await active.waitForOutcome();
    },
    t.signal,
    {
      competitorDriver: "baselinePolicy",
      onPolicyActivity: (event) => {
        measurements.onPolicyActivity(event);
        activity.record(event);
      },
      onResourceSample: measurements.onResourceSample,
    },
  );

  assert.ok(scenario, "the baseline run must retain its prepared Civilization scenario");
  assert.ok(layout, "the baseline run must retain its configured faction layout");
  assert.ok(materialBaseline, "the baseline run must retain its exact prepared material stock");
  assert.equal(run.competitors.length, 6, "the autonomous baseline must retain all six connected seats");
  assert.ok(run.outcome.kind === "faction_winner" || run.outcome.kind === "draw",
    "the autonomous baseline must end with an ordinary Civilization outcome");
  const outcomeEvent = run.events.findLast((event) => event.type === "outcome");
  if (outcomeEvent?.type !== "outcome") throw new Error("the authenticated authority stream has no terminal outcome");
  assert.equal(outcomeEvent.payload.kind, run.outcome.kind,
    "the returned terminal result must match the authenticated authority event");

  const inspectReport = asObject(run.inspection.report, "arena inspect report must be an object");
  assert.equal(inspectReport.outcome_status, "reconstructed_from_authoritative_events");
  const inspectedOutcome = asObject(inspectReport.outcome, "arena inspect must contain the reconstructed outcome");
  assert.equal(inspectedOutcome.kind, run.outcome.kind);

  const roleActivity = activity.snapshot();
  const traceEvidence = await readCivilizationPolicyTrace(run, t.signal);
  assertTraceMatchesLiveActivity(traceEvidence, roleActivity);

  const materialRecords = parseCivilizationMaterialLog(run.materialLog, run.runId);
  const checkpoints = materialRecords.flatMap((record) => record.kind === "checkpoint" ? [record.checkpoint] : []);
  const deathCargoMarkers = materialRecords.filter((record) => record.kind === "death_cargo");
  const deathEliminations = run.events.flatMap((event) => event.type === "elimination"
    ? event.payload.eliminations.filter(({ cause }) => cause === "death")
    : []);
  assert.equal(deathCargoMarkers.length, deathEliminations.length,
    "the evaluator census must include cargo evidence for every ordinary death");
  if (deathCargoMarkers.length > 0) assertCivilizationCargoDeaths(materialRecords, run.events, materialBaseline);
  else assertCivilizationMaterialConservation(checkpoints, materialBaseline);
  const finalCheckpoint = checkpoints.at(-1);
  assert.ok(finalCheckpoint, "the autonomous baseline must retain a final authoritative material census");
  assertCivilizationBaselineRoleContributions(roleActivity, scenario, layout, run.events, finalCheckpoint);

  const resourceEvidence = measurements.snapshot();
  assert.equal(resourceEvidence.activeBoundary.status, "available");
  assertResourceSamples(resourceEvidence.resources.startup, "startup");
  assertResourceSamples(resourceEvidence.resources.active, "active");
  const activeResources = resourceEvidence.resources.active;
  assert.ok(activeResources.sampleCount > 0, "active resource phase must contain owned process samples");
  const peakNodeRss = requireAvailable(activeResources.peakNodeRssBytes, "active Node RSS peak");
  const peakJavaRss = BigInt(requireAvailable(activeResources.peakJavaRssBytes, "active Paper RSS peak"));
  assert.ok(Number.isFinite(peakNodeRss) && peakNodeRss > 0, "active Node RSS must be an observed positive value");
  assert.ok(peakJavaRss > 0n, "active Paper RSS must be an observed positive value");

  t.diagnostic(JSON.stringify({
    run_id: run.runId,
    driver: "baselinePolicy",
    outcome: summarizeOutcome(run.outcome),
    policy_replay: {
      decision_records: traceEvidence.decisionRecordCount,
      effect_records: traceEvidence.effectRecordCount,
      decisions_by_seat: Object.fromEntries(traceEvidence.decisionsBySeat),
    },
    roles: Object.fromEntries([...roleActivity].map(([seat, evidence]) => [seat, {
      decisions: evidence.decisionCount,
      goals: evidence.goalCounts,
      intents: evidence.intentCounts,
      actions: evidence.actionCount,
      successful_actions: evidence.successfulActionCount,
      failed_actions: evidence.failedActionCount,
      successful_intents: evidence.successfulIntentCounts,
      mined_natural_oak_logs: evidence.minedNaturalLogPositions.length,
      crafted_oak_planks: evidence.craftedOakPlanks,
      deposited_oak_planks: evidence.depositedOakPlanks,
      withdrawn_oak_planks: evidence.withdrawnOakPlanks,
      placed_outpost_positions: evidence.placedOutpostPositions.length,
      successful_navigations: evidence.successfulNavigations,
    }])),
    material_census: {
      checkpoints: checkpoints.length,
      natural_log_sources: materialBaseline.naturalOakLogSources.length,
      initial_stock: materialBaseline.initialStock,
      final_placed_planks: finalCheckpoint.placedOakPlanks.length,
    },
    resources: {
      startup: resourceEvidence.resources.startup,
      active: activeResources,
    },
  }));
});

function createCivilizationSeatActivity(): {
  setScenarioPositions(naturalLogs: readonly BlockPosition[], outpostCells: readonly BlockPosition[]): void;
  record(event: PolicyActivityEvent): void;
  snapshot(): ReadonlyMap<number, SeatActivitySnapshot>;
} {
  const seats = new Map<number, MutableSeatActivity>(
    [0, 1, 2, 3, 4, 5].map((seat) => [seat, {
      decisionCount: 0,
      actionCount: 0,
      successfulActionCount: 0,
      failedActionCount: 0,
      goalCounts: new Map(),
      intentCounts: new Map(),
      successfulIntentCounts: new Map(),
      minedNaturalLogPositions: new Set(),
      craftedOakPlanks: 0,
      depositedOakPlanks: 0,
      withdrawnOakPlanks: 0,
      placedOutpostPositions: new Set(),
      successfulNavigations: 0,
      actionSequences: new Set(),
    }] as const),
  );
  let naturalLogSources = new Set<string>();
  let outpostPositions = new Set<string>();
  let totalActions = 0;

  return {
    setScenarioPositions(naturalLogs, outpostCells) {
      naturalLogSources = new Set(naturalLogs.map(positionKey));
      outpostPositions = new Set(outpostCells.map(positionKey));
    },
    record(event) {
      const seat = seats.get(event.seat);
      assert.ok(seat, `policy activity must reference configured seat ${event.seat}`);
      if (event.kind === "decision") {
        seat.decisionCount += 1;
        increment(seat.goalCounts, event.goal.kind);
        increment(seat.intentCounts, event.intent.kind);
        return;
      }

      totalActions += 1;
      assert.ok(totalActions <= MAX_POLICY_RECORDS, "per-seat policy activity must stay within its fixed record bound");
      const sequence = event.actionSequence;
      for (const activity of seats.values()) {
        assert.ok(!activity.actionSequences.has(sequence), "policy action sequence must be unique across seats");
      }
      seat.actionSequences.add(sequence);
      seat.actionCount += 1;
      if (event.kind === "actionFailed") {
        seat.failedActionCount += 1;
        return;
      }
      if (event.outcome.kind !== "succeeded") return;

      seat.successfulActionCount += 1;
      increment(seat.successfulIntentCounts, event.intent.kind);
      switch (event.intent.kind) {
        case "mineBlock":
          if (event.intent.expectedBlock === "oak_log" && naturalLogSources.has(positionKey(event.intent.position))) {
            seat.minedNaturalLogPositions.add(positionKey(event.intent.position));
          }
          break;
        case "craft":
          if (event.intent.output === "oak_planks") seat.craftedOakPlanks += event.intent.resultCount;
          break;
        case "containerTransfer":
          if (event.intent.item !== "oak_planks") break;
          if (event.intent.direction === "deposit") seat.depositedOakPlanks += event.intent.count;
          else seat.withdrawnOakPlanks += event.intent.count;
          break;
        case "placeBlock":
          if (event.intent.item === "oak_planks" && outpostPositions.has(positionKey(event.intent.target))) {
            seat.placedOutpostPositions.add(positionKey(event.intent.target));
          }
          break;
        case "navigate":
          seat.successfulNavigations += 1;
          break;
        default:
          break;
      }
    },
    snapshot() {
      return new Map([...seats].map(([seat, activity]) => [seat, Object.freeze({
        decisionCount: activity.decisionCount,
        actionCount: activity.actionCount,
        successfulActionCount: activity.successfulActionCount,
        failedActionCount: activity.failedActionCount,
        goalCounts: countRecord(activity.goalCounts),
        intentCounts: countRecord(activity.intentCounts),
        successfulIntentCounts: countRecord(activity.successfulIntentCounts),
        minedNaturalLogPositions: Object.freeze([...activity.minedNaturalLogPositions]),
        craftedOakPlanks: activity.craftedOakPlanks,
        depositedOakPlanks: activity.depositedOakPlanks,
        withdrawnOakPlanks: activity.withdrawnOakPlanks,
        placedOutpostPositions: Object.freeze([...activity.placedOutpostPositions]),
        successfulNavigations: activity.successfulNavigations,
        actionSequences: new Set(activity.actionSequences),
      })] as const));
    },
  };
}

function assertCivilizationBaselineRoleContributions(
  activity: ReadonlyMap<number, SeatActivitySnapshot>,
  scenario: ReturnType<typeof assertCivilizationRoster>,
  layout: ReturnType<typeof civilizationActionLayout>,
  events: readonly RuntimeAuthorityEvent[],
  finalCheckpoint: import("./civilization-material-evidence.js").CivilizationMaterialCheckpoint,
): void {
  const states = events.flatMap((event) => event.type === "civilization_state" ? [event.payload] : []);
  assert.ok(states.length > 0, "the public authority stream must include Civilization capture-state evidence");

  for (const faction of scenario.civilization.factions) {
    const byRole = new Map<CivilizationRole, number>(faction.members.map(({ seat, role }) => [role, seat] as const));
    const gathererSeat = byRole.get("gatherer_crafter");
    const builderSeat = byRole.get("builder");
    const defenderSeat = byRole.get("defender_scout");
    assert.ok(gathererSeat !== undefined && builderSeat !== undefined && defenderSeat !== undefined,
      `${faction.id} must contain every configured Civilization role`);

    const gatherer = requiredSeat(activity, gathererSeat);
    assert.ok(gatherer.decisionCount > 0 && (gatherer.goalCounts.gatherMaterial ?? 0) > 0,
      `${faction.id} gatherer must receive live resource-gathering policy decisions`);
    assert.ok(gatherer.minedNaturalLogPositions.length > 0,
      `${faction.id} gatherer must successfully mine a compiled natural oak log`);
    assert.ok(gatherer.minedNaturalLogPositions.some((position) =>
      !finalCheckpoint.remainingNaturalOakLogs.some((source) => positionKey(source) === position)),
    `${faction.id} gatherer mining must agree with the final server-side natural-log census`);
    assert.ok(gatherer.craftedOakPlanks > 0,
      `${faction.id} gatherer must complete an ordinary oak-plank crafting action`);
    assert.ok(gatherer.depositedOakPlanks > 0,
      `${faction.id} gatherer must transfer oak planks into faction storage`);

    const builder = requiredSeat(activity, builderSeat);
    assert.ok(builder.decisionCount > 0 && (builder.goalCounts.buildOutpost ?? 0) > 0,
      `${faction.id} builder must receive live outpost policy decisions`);
    assert.ok(builder.withdrawnOakPlanks > 0,
      `${faction.id} builder must withdraw real planks from faction storage`);
    const expectedCells = new Set(layout[faction.id].outpostCells.map(({ position }) => positionKey(position)));
    const placedCells = builder.placedOutpostPositions.filter((position) => expectedCells.has(position));
    assert.ok(placedCells.length > 0, `${faction.id} builder must complete a configured outpost placement`);
    assertCivilizationPlacedPositionsPresent(finalCheckpoint, placedCells.map(parsePositionKey),
      `${faction.id} builder's policy-driven outpost placements`);

    const defender = requiredSeat(activity, defenderSeat);
    assert.ok(defender.decisionCount > 0
      && ((defender.goalCounts.captureZone ?? 0) > 0 || (defender.goalCounts.holdCaptureZone ?? 0) > 0),
    `${faction.id} defender must receive live capture-zone policy decisions`);
    assert.ok(defender.successfulNavigations > 0,
      `${faction.id} defender must complete ordinary movement toward its capture objective`);
    assert.ok(states.some(({ occupants }) => occupants.includes(defenderSeat)),
      `${faction.id} defender must appear in authoritative capture-zone occupancy`);
  }
}

async function readCivilizationPolicyTrace(
  run: Awaited<ReturnType<typeof runOwnedCivilizationAcceptanceScenario>>,
  signal: AbortSignal,
): Promise<CivilizationPolicyTraceEvidence> {
  const helperPath = process.env.ARENA_FS_HELPER ?? resolve(process.cwd(), ".work/arena-fs/arena-fs");
  const ownedRoot = Buffer.from(process.cwd(), "utf8");
  const seats = new Map<number, TraceSeatActivity>(
    [0, 1, 2, 3, 4, 5].map((seat) => [seat, { decisionCount: 0, actionSequences: new Set() }] as const),
  );
  const decisionSeats = new Map<string, number>();
  let decisionRecordCount = 0;
  let effectRecordCount = 0;

  for (const segment of run.trace.segments) {
    const bytes = await readOwnedFile({
      helperPath,
      ownedRoot,
      relativePath: segment.relativePath,
      maxBytes: MAX_TRACE_SEGMENT_BYTES,
      signal,
    });
    const parsed = parseSegment(bytes);
    assert.equal(parsed.runId, run.runId, "policy replay segments must belong to the owned baseline run");
    assert.equal(parsed.byteLength, segment.byteLength, "policy replay segment length must match the finalized trace");
    for (const record of parsed.records) {
      if (record.schema === "civilization-policy-replay-v1") {
        const seatNumber = record.seat;
        const sequence = record.sequence;
        assert.ok(typeof seatNumber === "number" && Number.isSafeInteger(seatNumber)
          && seatNumber >= 0 && seatNumber <= 5,
        "Civilization replay decisions must identify one configured seat");
        assert.ok(typeof sequence === "string" && sequence.length > 0,
          "Civilization replay decisions must include their action sequence");
        assert.ok(!decisionSeats.has(sequence), "Civilization replay decision sequences must be unique");
        decisionRecordCount += 1;
        assert.ok(decisionRecordCount <= MAX_POLICY_RECORDS, "policy replay decisions must stay within their fixed record bound");
        decisionSeats.set(sequence, seatNumber);
        const seat = seats.get(seatNumber);
        assert.ok(seat, `Civilization trace must reference configured seat ${seatNumber}`);
        seat.decisionCount += 1;
      } else if (record.schema === "civilization-policy-effect-v1") {
        const sequence = record.decision_sequence;
        assert.ok(typeof sequence === "string" && sequence.length > 0,
          "Civilization replay effects must identify their decision sequence");
        const seatNumber = decisionSeats.get(sequence);
        assert.ok(seatNumber !== undefined, "every Civilization replay effect must match a prior decision");
        const seat = seats.get(seatNumber);
        assert.ok(seat, `Civilization replay effects must reference configured seat ${seatNumber}`);
        const skill = asObject(record.skill, "Civilization replay effect must contain its settled skill outcome");
        assert.notEqual(skill.kind, "pending", "a completed Civilization replay effect cannot remain pending");
        assert.ok(!seat.actionSequences.has(sequence), "Civilization replay effects must be unique per action");
        seat.actionSequences.add(sequence);
        effectRecordCount += 1;
        assert.ok(effectRecordCount <= MAX_POLICY_RECORDS, "policy replay effects must stay within their fixed record bound");
      } else if (record.schema === "policy-replay-v1" || record.schema === "policy-replay-v2"
        || record.schema === "policy-effect-v1") {
        throw new Error("Civilization baseline trace must not contain Hunger Games policy records");
      }
    }
  }

  return {
    decisionsBySeat: new Map([...seats].map(([seat, evidence]) => [seat, evidence.decisionCount] as const)),
    actionSequencesBySeat: new Map([...seats].map(([seat, evidence]) => [seat, evidence.actionSequences] as const)),
    decisionRecordCount,
    effectRecordCount,
  };
}

function assertTraceMatchesLiveActivity(
  trace: CivilizationPolicyTraceEvidence,
  activity: ReadonlyMap<number, SeatActivitySnapshot>,
): void {
  for (const seat of [0, 1, 2, 3, 4, 5]) {
    const live = requiredSeat(activity, seat);
    assert.equal(trace.decisionsBySeat.get(seat), live.decisionCount,
      `seat ${seat} live decisions must match its serialized Civilization replay records`);
    const replayActions = trace.actionSequencesBySeat.get(seat);
    assert.ok(replayActions, `seat ${seat} must have a Civilization replay action set`);
    assert.deepStrictEqual([...replayActions].sort(), [...live.actionSequences].sort(),
      `seat ${seat} live action receipts must match its serialized Civilization replay effects`);
    assert.ok(live.decisionCount > 0, `seat ${seat} must receive at least one ordinary policy decision`);
    assert.ok(live.actionCount > 0, `seat ${seat} must complete or settle at least one ordinary policy action`);
  }
  assert.ok(trace.effectRecordCount > 0, "the Civilization policy trace must record completed action effects");
}

async function waitForCivilizationActive(active: AcceptanceRunContext, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (active.events().some((event) => event.type === "public_clock" && event.payload.phase === "active")) return;
    await delay(50, undefined, { signal });
  }
  throw new Error("Civilization baseline did not reach its active phase within 30 seconds");
}

function assertResourceSamples(resource: HungerResourcePhaseEvidence, phase: string): void {
  assert.equal(resource.failedSampleCount, 0, `${phase} resource samples must not fail`);
  assert.equal(Object.values(resource.failureKinds).reduce((total, count) => total + count, 0), 0,
    `${phase} resource sampling must not report failure kinds`);
}

function requiredSeat(activity: ReadonlyMap<number, SeatActivitySnapshot>, seat: number): SeatActivitySnapshot {
  const evidence = activity.get(seat);
  assert.ok(evidence, `policy evidence must contain configured seat ${seat}`);
  return evidence;
}

function requireAvailable<T>(
  value: { readonly status: "available"; readonly value: T } | { readonly status: "unavailable"; readonly reason: string },
  description: string,
): T {
  if (value.status !== "available") throw new Error(`${description} is unavailable: ${value.reason}`);
  return value.value;
}

function parsePositionKey(key: string): BlockPosition {
  const match = /^(-?\d+),(-?\d+),(-?\d+)$/.exec(key);
  assert.ok(match, `recorded position ${key} must be a canonical block coordinate`);
  return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
}

function positionKey(position: BlockPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function countRecord(counts: ReadonlyMap<string, number>): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(counts));
}

function asObject(value: unknown, description: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object", description);
  return value as Record<string, unknown>;
}

function summarizeOutcome(outcome: { readonly kind: string; readonly reason?: string; readonly winner_faction_id?: string }): Readonly<Record<string, string>> {
  return Object.freeze({
    kind: outcome.kind,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    ...(outcome.winner_faction_id === undefined ? {} : { winner_faction_id: outcome.winner_faction_id }),
  });
}
