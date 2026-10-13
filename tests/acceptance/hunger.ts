import assert from "node:assert/strict";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { runCli } from "../../packages/arena-runner/src/cli.js";
import { readOwnedFile, stageOwnedFile } from "../../packages/arena-runner/src/owned-files/index.js";
import { parseSegment, MAX_TRACE_SEGMENT_BYTES } from "../../packages/arena-runner/src/trace.js";
import { archiveDirectoryPath } from "../../packages/arena-runner/src/runtime/inspect.js";
import { readStoppedPlayerStatsFile } from "../../packages/arena-runner/src/runtime/observations.js";
import { runPreparedRun } from "../../packages/arena-runner/src/runtime/run.js";
import { recordHungerGameplayEvidence, type HungerGameplayEvidence } from "./hunger-gameplay.js";
import { createHungerRunMeasurements, type HungerRunMeasurementEvidence } from "./hunger-measurements.js";
import { withHungerResourceDiagnostic } from "./hunger-resource-diagnostic.js";
import { hasEliminatedSeatEvidence } from "./hunger-alive-state.js";
import { prepareOwnedAcceptanceRun, inspectOwnedAcceptanceRun, type runOwnedAcceptanceScenario, type AcceptanceRunContext } from "../integration/support/owned-run.js";

const SCENARIOS = [
  { path: "tests/acceptance/fixtures/hunger-six-seed-481516.toml", seed: 481516n },
  { path: "tests/acceptance/fixtures/hunger-six-seed-481517.toml", seed: 481517n },
  { path: "tests/acceptance/fixtures/hunger-six-seed-481518.toml", seed: 481518n },
  { path: "tests/acceptance/fixtures/hunger-six-seed-481519.toml", seed: 481519n },
  { path: "tests/acceptance/fixtures/hunger-six-seed-481520.toml", seed: 481520n },
  { path: "tests/acceptance/fixtures/hunger-six-seed-481521.toml", seed: 481521n },
] as const;

const DEATH_TIMEOUT_MS = 420_000;
const ELIMINATION_TIMEOUT_MS = 10_000;
const HUNGER_REPORT_FILENAME = "hunger-acceptance-v1.json";
const HUNGER_REPORT_MAX_BYTES = 256 * 1024;

test("hunger-six", { timeout: 2_700_000 }, async (t) => {
  let hasWinnerWithTwoPvpEngagements = false;

  for (const [index, scenario] of SCENARIOS.entries()) {
    let gameplayEvidence: HungerGameplayEvidence | undefined;
    let measurementEvidence: HungerRunMeasurementEvidence | undefined;
    const measurements = createHungerRunMeasurements([0, 1, 2, 3, 4, 5]);
    const observedPolicyTick = { value: null as number | null };
    const prepared = await prepareOwnedAcceptanceRun(
      scenario.path,
      `hunger-six-seed-${scenario.seed}`,
      t.signal,
    );
    const completed = await withHungerResourceDiagnostic(
      { ...prepared, seed: scenario.seed },
      async (onResourceSample) => await runPreparedRun({
        ...prepared,
        competitorDriver: "baselinePolicy",
        evaluate: async (active, signal) => {
          assertCanonicalHungerScenario(active, scenario.seed);
          prepareSixBotRoster(active);
          const recorder = recordHungerGameplayEvidence(active, () => observedPolicyTick.value);
          try {
            await active.start();
            measurements.markActiveBoundary(await waitForActivePhase(active, signal));
            recorder.markActiveBoundary();

            if (index === 0) {
              const eliminatedSeat = await waitForDeathElimination(active, signal);
              const victim = competitorForSeat(active, eliminatedSeat);
              await waitForEliminatedState(active, eliminatedSeat, signal);

              const identityBeforeReconnect = victim.identity;
              const reconnected = await active.reconnectCompetitor(eliminatedSeat);
              assert.equal(reconnected.identity.username, identityBeforeReconnect.username);
              assert.equal(reconnected.identity.offlineUuid, identityBeforeReconnect.offlineUuid);
              assert.equal(reconnected.bot.username, identityBeforeReconnect.username);
              const eventCountAfterReconnect = active.events().length;
              await waitForGameMode(reconnected.bot, "spectator", signal);
              assert.equal(
                reconnected.bot.game.gameMode,
                "spectator",
                "a reconnect after death must join in actual spectator mode",
              );
              await waitForEliminatedState(active, eliminatedSeat, signal, eventCountAfterReconnect);
            }

            await active.waitForOutcome();
            gameplayEvidence = recorder.snapshot();
          } finally {
            recorder.close();
          }
        },
        onPolicyActivity: (event) => {
          if (event.kind === "decision") observedPolicyTick.value = event.tick;
          measurements.onPolicyActivity(event);
        },
        onResourceSample: (event) => {
          onResourceSample(event);
          measurements.onResourceSample(event);
        },
      }),
      stageOwnedFile,
    );
    const run = { ...completed, inspection: await inspectOwnedAcceptanceRun(completed.runId) };
    // Runtime shutdown settles owned actions and emits the final resource sample before returning.
    measurementEvidence = measurements.snapshot();

    assert.equal(run.inspection.run_id, run.runId);
    assert.ok(run.outcome.kind === "winner" || run.outcome.kind === "draw", "seeded run must reach an ordinary outcome");
    assert.ok(gameplayEvidence, "the clients must retain live gameplay observations for each seed");
    assert.ok(measurementEvidence, "the runner must retain bounded policy and resource observations for each seed");
    assert.ok(
      run.events.some((event) => event.type === "outcome" && event.payload.kind === run.outcome.kind),
      "the completed outcome must come from the authenticated event stream",
    );
    const inspectReport = object(run.inspection.report, "arena inspect report must be an object");
    assert.equal(inspectReport.outcome_status, "reconstructed_from_authoritative_events");
    const inspectedOutcome = object(inspectReport.outcome, "arena inspect must include the reconstructed outcome");
    assert.equal(inspectedOutcome.kind, run.outcome.kind);
    assert.equal(run.competitors.length, 6, "completed evidence must retain all six competitor identities");
    for (const competitor of run.competitors) {
      const stats = run.inspection.stats.find(({ offlineUuid }) => offlineUuid === competitor.offlineUuid);
      assert.ok(stats, `stopped inspection must include competitor ${competitor.username}`);
      assert.equal(stats.status, "present", `stopped stats must be present for competitor ${competitor.username}`);
    }

    const deathSeats = new Set(run.events.flatMap((event) => event.type === "elimination"
      ? event.payload.eliminations.filter(({ cause }) => cause === "death").map(({ seat }) => seat)
      : []));
    for (const seat of [0, 1, 2, 3, 4, 5]) {
      const movement = gameplayEvidence.maximumMovementBySeat.get(seat) ?? 0;
      assert.ok(
        movement >= 2 || deathSeats.has(seat),
        `seat ${seat} must make useful movement or be legitimately eliminated in seed ${scenario.seed}`,
      );
    }
    assert.ok(gameplayEvidence.lootedSeats.size > 0, `seed ${scenario.seed} must include a legal chest transfer`);
    assert.ok(gameplayEvidence.pvpEngagements.size > 0, `seed ${scenario.seed} must include an ordinary PvP hit`);
    if (run.outcome.kind === "winner" && gameplayEvidence.pvpEngagements.size >= 2) {
      hasWinnerWithTwoPvpEngagements = true;
    }

    if (index === 0) {
      const deathEventIndex = run.events.findIndex((event) => event.type === "elimination"
        && event.payload.eliminations.some(({ cause }) => cause === "death"));
      assert.notEqual(deathEventIndex, -1, "the automated competitor must be eliminated by ordinary death");
      const death = run.events[deathEventIndex];
      if (death?.type !== "elimination") throw new Error("ordinary death event is unavailable in the completed run");
      const deadSeat = death.payload.eliminations.find(({ cause }) => cause === "death")!.seat;
      const laterStates = run.events.slice(deathEventIndex + 1).filter((event) => event.type === "public_state");
      assert.ok(laterStates.length > 0, "the event stream must include public state after the death");
      assert.ok(
        laterStates.every((event) => !event.payload.alive_seats.includes(deadSeat)),
        "reconnecting must not restore the eliminated seat to the active roster",
      );
      assert.ok(
        !run.outcome.survivors.includes(deadSeat),
        "an eliminated reconnecting competitor must not become a match survivor",
      );
    }

    const acceptanceReport = await createHungerAcceptanceReport({
      run,
      seed: scenario.seed,
      gameplay: gameplayEvidence,
      measurements: measurementEvidence,
    });
    await archiveHungerAcceptanceReport(acceptanceReport, run.runId);
    t.diagnostic(JSON.stringify(hungerTapSummary(acceptanceReport)));
  }

  assert.ok(
    hasWinnerWithTwoPvpEngagements,
    "at least one seeded run must have one survivor and two distinct ordinary PvP engagements",
  );
});

function prepareSixBotRoster(active: AcceptanceRunContext): void {
  assert.equal(active.prepare.type, "prepare");
  const roster = active.prepare.payload.roster;
  assert.equal(roster.length, 6, "the prepared match must contain six bot competitors");
  assert.deepStrictEqual(roster.map(({ seat }) => seat), [0, 1, 2, 3, 4, 5]);
  assert.equal(active.competitors.length, 6, "the runner must connect all six bot competitors");
  const spectatorCapacity = Number(active.preparedRun.scenario.roster.spectatorCapacity);
  assert.equal(active.spectators.length, spectatorCapacity, "the runner must connect every configured automated spectator");

  const usernames = new Set<string>();
  const offlineUuids = new Set<string>();
  for (const planned of roster) {
    const handle = competitorForSeat(active, planned.seat);
    assert.equal(handle.identity.username, planned.username);
    assert.equal(handle.identity.offlineUuid, planned.offline_uuid);
    assert.equal(handle.bot.username, planned.username);
    assert.ok(!usernames.has(handle.identity.username), "competitor usernames must be unique");
    assert.ok(!offlineUuids.has(handle.identity.offlineUuid), "competitor UUIDs must be unique");
    usernames.add(handle.identity.username);
    offlineUuids.add(handle.identity.offlineUuid);
  }

  const spectatorUsernames = new Set<string>();
  const spectatorUuids = new Set<string>();
  for (const spectator of active.spectators) {
    assert.ok(!usernames.has(spectator.identity.username), "automated spectators must not occupy competitor seats");
    assert.ok(!offlineUuids.has(spectator.identity.offlineUuid), "automated spectators must have their own offline UUIDs");
    assert.ok(!spectatorUsernames.has(spectator.identity.username), "automated spectator usernames must be unique");
    assert.ok(!spectatorUuids.has(spectator.identity.offlineUuid), "automated spectator UUIDs must be unique");
    assert.equal(spectator.bot.username, spectator.identity.username);
    assert.equal(spectator.bot.game.gameMode, "spectator", "each noncompetitor client must receive spectator game mode");
    spectatorUsernames.add(spectator.identity.username);
    spectatorUuids.add(spectator.identity.offlineUuid);
  }
}

function assertCanonicalHungerScenario(active: AcceptanceRunContext, seed: bigint): void {
  const scenario = active.preparedRun.scenario;
  assert.equal(scenario.seed, seed, "each match must use its declared distinct seed");
  assert.equal(scenario.roster.competitors, 6);
  assert.equal(scenario.roster.spectatorCapacity, 4n);
  assert.equal(scenario.matchSettings.countdownTicks, 100n);
  assert.equal(scenario.matchSettings.graceTicks, 200n);
  assert.equal(scenario.matchSettings.authoritativeMaxTicks, 7200n);
  assert.equal(scenario.border.shrinkStartTick, 1200n);
  assert.equal(scenario.border.shrinkEndTick, 6000n);
}

function competitorForSeat(active: AcceptanceRunContext, seat: number) {
  assert.equal(active.prepare.type, "prepare");
  const planned = active.prepare.payload.roster.find((competitor) => competitor.seat === seat);
  assert.ok(planned, `prepared roster must contain competitor seat ${seat}`);
  const handle = active.competitors.find(({ identity }) => identity.username === planned.username);
  assert.ok(handle, `runtime must connect prepared competitor ${planned.username}`);
  assert.equal(handle.identity.offlineUuid, planned.offline_uuid);
  return handle;
}

async function waitForActivePhase(active: AcceptanceRunContext, signal: AbortSignal): Promise<bigint> {
  await waitForCondition(
    () => active.events().some((event) => event.type === "public_clock" && event.payload.phase === "active"),
    "match did not reach the active phase",
    30_000,
    signal,
  );
  return process.hrtime.bigint();
}

async function waitForEliminatedState(
  active: AcceptanceRunContext,
  seat: number,
  signal: AbortSignal,
  afterEventCount?: number,
): Promise<void> {
  await waitForCondition(
    () => hasEliminatedSeatEvidence(active.events(), seat, afterEventCount),
    afterEventCount === undefined
      ? `seat ${seat} remained alive after elimination`
      : `seat ${seat} lacked authoritative eliminated-state evidence after reconnect`,
    ELIMINATION_TIMEOUT_MS,
    signal,
  );
}

async function waitForGameMode(
  bot: AcceptanceRunContext["competitors"][number]["bot"],
  mode: "spectator",
  signal: AbortSignal,
): Promise<void> {
  await waitForCondition(
    () => bot.game.gameMode === mode,
    `reconnected bot did not enter ${mode} mode`,
    10_000,
    signal,
  );
}

async function waitForDeathElimination(active: AcceptanceRunContext, signal: AbortSignal): Promise<number> {
  const deadline = Date.now() + DEATH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const death = active.events().find((event) => event.type === "elimination"
      && event.payload.eliminations.some(({ cause }) => cause === "death"));
    if (death?.type === "elimination") {
      const elimination = death.payload.eliminations.find(({ cause }) => cause === "death");
      assert.ok(elimination);
      return elimination.seat;
    }
    if (active.events().some((event) => event.type === "outcome")) {
      throw new Error("hunger-six seed 1 reached an outcome before any competitor died");
    }
    await delay(50, undefined, { signal });
  }
  throw new Error(`hunger-six did not record an ordinary death within ${DEATH_TIMEOUT_MS} ms`);
}

async function waitForCondition(
  condition: () => boolean,
  description: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (condition()) return;
    await delay(50, undefined, { signal });
  }
  throw new Error(`${description} within ${timeoutMs} ms`);
}

function object(value: unknown, description: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object", description);
  return value as Record<string, unknown>;
}

type CompletedAcceptanceRun = Awaited<ReturnType<typeof runOwnedAcceptanceScenario>>;

interface HungerAcceptanceReport {
  readonly schema: 1;
  readonly run_id: string;
  readonly seed: string;
  readonly outcome: Readonly<{ kind: string; survivors: readonly number[] }>;
  readonly death_causes: readonly Readonly<{ seat: number; cause: string; count: number }>[];
  readonly pvp_engagements: readonly string[];
  readonly looted_seats: readonly number[];
  readonly seats: Readonly<Record<string, unknown>>;
  readonly measurements: Readonly<Record<string, unknown>>;
  readonly trace: Readonly<Record<string, unknown>>;
}

async function createHungerAcceptanceReport(input: Readonly<{
  run: CompletedAcceptanceRun;
  seed: bigint;
  gameplay: HungerGameplayEvidence;
  measurements: HungerRunMeasurementEvidence;
}>): Promise<HungerAcceptanceReport> {
  const repositoryRoot = process.cwd();
  const helperPath = process.env.ARENA_FS_HELPER ?? resolve(repositoryRoot, ".work/arena-fs/arena-fs");
  const ownedRoot = Buffer.from(repositoryRoot, "utf8");
  const runDirectoryPath = Buffer.from(`.work/arena/runs/${input.run.runId}`, "ascii");
  const counters = [
    "minecraft:walk_one_cm",
    "minecraft:sprint_one_cm",
    "minecraft:damage_dealt",
    "minecraft:damage_taken",
    "minecraft:open_chest",
    "minecraft:player_kills",
    "minecraft:deaths",
  ] as const;
  const deathCauseCounts = new Map<string, number>();
  for (const event of input.run.events) {
    if (event.type !== "elimination") continue;
    for (const elimination of event.payload.eliminations) {
      const key = `${elimination.seat}:${elimination.cause}`;
      deathCauseCounts.set(key, (deathCauseCounts.get(key) ?? 0) + 1);
    }
  }
  const seats: Record<string, unknown> = {};
  for (const [seat, identity] of input.run.competitors.entries()) {
    const gameplay = input.gameplay.seats.get(seat);
    const policy = input.measurements.policyBySeat.get(seat);
    assert.ok(gameplay, `gameplay observations must include seat ${seat}`);
    assert.ok(policy, `policy observations must include seat ${seat}`);
    const statsFile = await readStoppedPlayerStatsFile({
      helperPath,
      ownedRoot,
      runDirectoryPath,
      player: identity,
    });
    const stats = statsFile.contents === null
      ? undefined
      : object(JSON.parse(statsFile.contents.toString("utf8")), "Minecraft stats must be an object");
    const statsSections = stats === undefined ? undefined : object(stats.stats, "Minecraft stats must include a stats object");
    const customStatsValue = statsSections?.["minecraft:custom"];
    const customStats = customStatsValue === undefined
      ? Object.create(null) as Record<string, unknown>
      : object(customStatsValue, "Minecraft custom stats must be an object");
    const minecraftCounters = Object.fromEntries(counters.map((counter) => [
      counter,
      statsFile.contents === null
        ? unavailableMetric("the stopped stats file is absent")
        : availableMetric(readStatCounter(customStats, counter)),
    ]));
    const inspectedStats = input.run.inspection.stats.find(({ offlineUuid }) => offlineUuid === identity.offlineUuid);
    assert.ok(inspectedStats, `stopped inspection must include ${identity.username}`);
    assert.equal(statsFile.stats.status, inspectedStats.status, "raw and inspected Minecraft stats must share presence status");
    if (statsFile.contents !== null) {
      assert.equal(readStatCounter(customStats, "minecraft:deaths"), inspectedStats.deaths);
      assert.equal(readStatCounter(customStats, "minecraft:player_kills"), inspectedStats.playerKills);
    }
    seats[String(seat)] = Object.freeze({
      identity: Object.freeze({ username: identity.username, offline_uuid: identity.offlineUuid }),
      survived_at_outcome: input.run.outcome.survivors.includes(seat),
      elimination_causes: Object.freeze({
        death: deathCauseCounts.get(`${seat}:death`) ?? 0,
        disconnect: deathCauseCounts.get(`${seat}:disconnect`) ?? 0,
      }),
      stats: Object.freeze({
        status: statsFile.stats.status,
        inspectedDeaths: inspectedStats.deaths,
        inspectedPlayerKills: inspectedStats.playerKills,
        minecraftCounters: Object.freeze(minecraftCounters),
      }),
      gameplay,
      policy,
    });
  }

  const trace = await readCompactTraceEvidence(input.run);

  return Object.freeze({
    schema: 1,
    run_id: input.run.runId,
    seed: input.seed.toString(10),
    outcome: Object.freeze({ kind: input.run.outcome.kind, survivors: Object.freeze([...input.run.outcome.survivors]) }),
    death_causes: Object.freeze([...deathCauseCounts].map(([key, count]) => {
      const [seat, cause] = key.split(":");
      return Object.freeze({ seat: Number(seat), cause: cause!, count });
    }).sort((first, second) => first.seat - second.seat || first.cause.localeCompare(second.cause))),
    pvp_engagements: Object.freeze([...input.gameplay.pvpEngagements].sort()),
    looted_seats: Object.freeze([...input.gameplay.lootedSeats].sort((first, second) => first - second)),
    seats: Object.freeze(seats),
    measurements: Object.freeze({
      active_boundary: input.measurements.activeBoundary,
      resource_phase_assignment: "sample_start_time_relative_to_first_observed_active_clock",
      resource_phase_scope: input.measurements.resourcePhaseScope,
      timing_metrics: input.measurements.timingMetrics,
      policy_by_seat: Object.freeze(Object.fromEntries(input.measurements.policyBySeat)),
      resources: input.measurements.resources,
    }),
    trace,
  });
}

async function readCompactTraceEvidence(run: CompletedAcceptanceRun): Promise<Readonly<Record<string, unknown>>> {
  const helperPath = process.env.ARENA_FS_HELPER ?? resolve(process.cwd(), ".work/arena-fs/arena-fs");
  const ownedRoot = Buffer.from(process.cwd(), "utf8");
  const segmentSummaries: Array<Readonly<Record<string, unknown>>> = [];
  const samples = new Map<string, Readonly<Record<string, unknown>>>();
  let attackSequence: string | undefined;
  let firstPolicyEffect: Readonly<Record<string, unknown>> | undefined;

  for (const [segmentIndex, segment] of run.trace.segments.entries()) {
    const bytes = await readOwnedFile({
      helperPath,
      ownedRoot,
      relativePath: segment.relativePath,
      maxBytes: MAX_TRACE_SEGMENT_BYTES,
    });
    const parsed = parseSegment(bytes);
    assert.equal(parsed.runId, run.runId, "authenticated trace segment must belong to the completed run");
    assert.equal(parsed.byteLength, segment.byteLength, "authenticated trace segment length must match the runtime identity");
    segmentSummaries.push(Object.freeze({
      filename: segment.relativePath.subarray(segment.relativePath.lastIndexOf(47) + 1).toString("ascii"),
      byte_length: parsed.byteLength,
      first_sequence: parsed.firstSequence.toString(10),
      last_sequence: parsed.lastSequence.toString(10),
    }));

    for (const [recordIndex, record] of parsed.records.entries()) {
      const sequence = (parsed.firstSequence + BigInt(recordIndex)).toString(10);
      if (record.schema === "policy-replay-v1" || record.schema === "policy-replay-v2") {
        const decision = optionalObject(record.decision);
        const intent = optionalObject(decision?.intent);
        if (intent?.kind === "attack" && samples.get("attack_decision") === undefined) {
          if (typeof record.sequence !== "string") throw new TypeError("policy trace sequence must be a string");
          attackSequence = record.sequence;
          samples.set("attack_decision", Object.freeze({
            source: traceSource(segmentIndex, sequence),
            record: Object.freeze({
              schema: record.schema,
              sequence: record.sequence,
              seat: record.seat,
              intent,
              ...(record.schema === "policy-replay-v2" ? { disposition: record.disposition } : {}),
            }),
          }));
        }
        continue;
      }
      if (record.schema === "policy-effect-v1") {
        const skill = optionalObject(record.skill);
        const pathUpdates = Array.isArray(record.path_updates) ? record.path_updates : [];
        const compactEffect = Object.freeze({
          source: traceSource(segmentIndex, sequence),
          record: Object.freeze({
            schema: record.schema,
            decision_sequence: record.decision_sequence,
            skill,
            path_update_statuses: Object.freeze(pathUpdates.flatMap((update) => {
              const pathUpdate = optionalObject(update);
              return typeof pathUpdate?.status === "string" ? [pathUpdate.status] : [];
            })),
          }),
        });
        firstPolicyEffect ??= compactEffect;
        if (record.decision_sequence === attackSequence) samples.set("attack_effect", compactEffect);
        continue;
      }

      const type = record.type;
      const payload = optionalObject(record.payload);
      if (type === "public_clock" && payload?.phase === "active" && samples.get("active_clock") === undefined) {
        samples.set("active_clock", compactAuthoritySample(segmentIndex, sequence, record, {
          phase: payload.phase,
          tick: payload.tick,
        }));
      } else if (type === "elimination" && samples.get("elimination") === undefined) {
        samples.set("elimination", compactAuthoritySample(segmentIndex, sequence, record, {
          eliminations: payload?.eliminations,
        }));
      } else if (type === "outcome" && samples.get("outcome") === undefined) {
        samples.set("outcome", compactAuthoritySample(segmentIndex, sequence, record, {
          kind: payload?.kind,
          survivors: payload?.survivors,
        }));
      }
    }
  }

  if (samples.get("attack_effect") === undefined && firstPolicyEffect !== undefined) {
    samples.set("policy_effect", firstPolicyEffect);
  }
  assert.ok(samples.has("active_clock"), "the authenticated trace must include an active-clock sample");
  assert.ok(samples.has("outcome"), "the authenticated trace must include its terminal outcome sample");
  return Object.freeze({
    total_byte_length: run.trace.totalByteLength,
    segments: Object.freeze(segmentSummaries),
    samples: Object.freeze(Object.fromEntries(samples)),
  });
}

function compactAuthoritySample(
  segmentIndex: number,
  sequence: string,
  record: Readonly<Record<string, unknown>>,
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    source: traceSource(segmentIndex, sequence),
    record: Object.freeze({
      direction: record.direction,
      type: record.type,
      sequence: record.sequence,
      payload: Object.freeze(payload),
    }),
  });
}

function traceSource(segmentIndex: number, sequence: string): Readonly<{ segment: number; record_sequence: string }> {
  return Object.freeze({ segment: segmentIndex + 1, record_sequence: sequence });
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readStatCounter(stats: Readonly<Record<string, unknown>>, counter: string): number {
  const value = stats[counter];
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Minecraft stats counter ${counter} must be a non-negative safe integer`);
  }
  return value;
}

async function archiveHungerAcceptanceReport(report: HungerAcceptanceReport, runId: string): Promise<void> {
  const helperPath = process.env.ARENA_FS_HELPER ?? resolve(process.cwd(), ".work/arena-fs/arena-fs");
  const ownedRoot = Buffer.from(process.cwd(), "utf8");
  const contents = Buffer.from(`${JSON.stringify(report)}\n`, "utf8");
  assert.ok(contents.length <= HUNGER_REPORT_MAX_BYTES, "bounded hunger evidence report must fit its byte limit");
  const liveRunDirectory = Buffer.from(`.work/arena/runs/${runId}`, "ascii");
  const reportFilename = Buffer.from(`/${HUNGER_REPORT_FILENAME}`, "ascii");
  const liveReportPath = Buffer.concat([liveRunDirectory, reportFilename]);
  await stageOwnedFile({
    helperPath,
    ownedRoot,
    relativePath: liveReportPath,
    contents,
    maxBytes: HUNGER_REPORT_MAX_BYTES,
  });

  const dryRun = await runGcWithHelper(helperPath, "--dry-run", runId);
  assertGcStatus(dryRun, runId, "eligible", "dry-run");
  const applied = await runGcWithHelper(helperPath, "--apply", runId);
  assertGcStatus(applied, runId, "removed", "apply");

  const archivedReportPath = Buffer.concat([archiveDirectoryPath(runId), reportFilename]);
  await stageOwnedFile({
    helperPath,
    ownedRoot,
    relativePath: archivedReportPath,
    contents,
    maxBytes: HUNGER_REPORT_MAX_BYTES,
  });
  const archivedContents = await readOwnedFile({
    helperPath,
    ownedRoot,
    relativePath: archivedReportPath,
    maxBytes: HUNGER_REPORT_MAX_BYTES,
  });
  assert.deepEqual(archivedContents, contents, "the bounded report must remain beside the archived trace evidence");
}

async function runGcWithHelper(
  helperPath: string,
  mode: "--dry-run" | "--apply",
  runId: string,
): Promise<Record<string, unknown>> {
  const previousHelperPath = process.env.ARENA_FS_HELPER;
  process.env.ARENA_FS_HELPER = helperPath;
  let result: Awaited<ReturnType<typeof runCli>>;
  try {
    result = await runCli(["gc", mode, "--run-id", runId]);
  } finally {
    if (previousHelperPath === undefined) delete process.env.ARENA_FS_HELPER;
    else process.env.ARENA_FS_HELPER = previousHelperPath;
  }
  if (result.kind !== "success") throw new Error(`arena gc ${mode} failed: ${result.stderr}`);
  return object(JSON.parse(result.stdout), `arena gc ${mode} must return a JSON object`);
}

function assertGcStatus(
  result: Readonly<Record<string, unknown>>,
  runId: string,
  status: "eligible" | "removed",
  mode: string,
): void {
  assert.equal(result.mode, mode === "dry-run" ? "dry_run" : "apply");
  assert.ok(Array.isArray(result.runs), "arena gc must return run decisions");
  const decision = result.runs.find((entry) => optionalObject(entry)?.run_id === runId);
  assert.ok(decision, `arena gc ${mode} must report selected run ${runId}`);
  assert.equal(object(decision, "arena gc decision must be an object").status, status);
}

function hungerTapSummary(report: HungerAcceptanceReport): Readonly<Record<string, unknown>> {
  const seats = Object.fromEntries(Object.entries(report.seats).map(([seat, value]) => {
    const evidence = object(value, `seat ${seat} report must be an object`);
    const gameplay = object(evidence.gameplay, `seat ${seat} gameplay evidence must be an object`);
    const movement = object(gameplay.movement, `seat ${seat} movement evidence must be an object`);
    const loot = object(gameplay.loot, `seat ${seat} loot evidence must be an object`);
    const inventory = object(gameplay.inventory, `seat ${seat} inventory evidence must be an object`);
    const combat = object(gameplay.combat, `seat ${seat} combat evidence must be an object`);
    const path = object(gameplay.path, `seat ${seat} path evidence must be an object`);
    const pathQueue = object(path.searchQueue, `seat ${seat} path queue evidence must be an object`);
    const pathSearch = object(path.search, `seat ${seat} path search evidence must be an object`);
    const movementDiagnostics = object(path.movementDiagnostics, `seat ${seat} movement diagnostics must be an object`);
    const policy = object(evidence.policy, `seat ${seat} policy evidence must be an object`);
    const actionDuration = object(policy.actionDuration, `seat ${seat} action duration must be an object`);
    return [seat, Object.freeze({
      distance_blocks: movement.distanceBlocks,
      maximum_movement_silence_ms: movement.maximumIntervalBetweenMoveEventsMs,
      maximum_active_movement_silence_ms: movement.maximumActiveIntervalBetweenMoveEventsMs,
      loot_transfers: loot.confirmedTransferCount,
      changed_item_names: inventory.changedItems,
      equipment_changes: inventory.equipmentChangeCount,
      dealt_hits: combat.dealtHitCount,
      received_hits: combat.receivedHitCount,
      health_lost: combat.healthLost,
      health_restored: combat.healthRestored,
      policy_decisions: policy.decisionCount,
      policy_action_count: policy.actionCount,
      maximum_action_duration_ms: actionDuration.maximumMilliseconds,
      attack_timeout_count: policy.attackNoObservedDamageTimeoutCount,
      path_queue_wait_count: pathQueue.queueWaitCount,
      maximum_path_queue_wait_ms: pathQueue.queueWaitMaximumMs,
      path_update_statuses: pathSearch.statusCounts,
      maximum_path_context_time_ms: pathSearch.maximumContextTimeMs,
      stationary_navigation_samples: movementDiagnostics.stationaryNavigationSampleCount,
    })];
  }));
  const measurements = object(report.measurements, "run measurements must be an object");
  const resources = object(measurements.resources, "resource evidence must be an object");
  const startup = object(resources.startup, "startup resource evidence must be an object");
  const active = object(resources.active, "active resource evidence must be an object");
  const timingMetrics = object(measurements.timing_metrics, "timing metrics must be an object");
  return Object.freeze({
    schema: "hunger-acceptance-v1",
    run_id: report.run_id,
    seed: report.seed,
    outcome: report.outcome.kind,
    death_causes: report.death_causes,
    pvp_engagements: report.pvp_engagements,
    looted_seats: report.looted_seats,
    seats: Object.freeze(seats),
    startup_resource_samples: startup.sampleCount,
    active_resource_samples: active.sampleCount,
    startup_peak_summed_rss_bytes: startup.peakSummedRssBytes,
    active_peak_summed_rss_bytes: active.peakSummedRssBytes,
    startup_resource_poll_interval_overshoot: startup.maximumResourcePollIntervalOvershoot,
    active_resource_poll_interval_overshoot: active.maximumResourcePollIntervalOvershoot,
    resource_phase_scope: measurements.resource_phase_scope,
    timing_metrics: timingMetrics,
  });
}

function availableMetric<T>(value: T): Readonly<{ status: "available"; value: T }> {
  return Object.freeze({ status: "available", value });
}

function unavailableMetric<T = never>(reason: string): Readonly<{ status: "unavailable"; reason: string }> {
  return Object.freeze({ status: "unavailable", reason });
}
