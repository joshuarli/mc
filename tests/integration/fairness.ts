import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  decide,
  DeterministicRandom,
  emptyPolicyMemory,
  PolicyParams,
  RandomStream,
  seatId,
  type AgentObservation,
} from "@arena/core";
import { test } from "node:test";

import { createMineflayerSemanticWorldReader } from "./support/mineflayer-world.js";
import { runOwnedAcceptanceScenario, type AcceptanceRunContext } from "./support/owned-run.js";

const variants = [
  {
    scenarioPath: "tests/acceptance/fixtures/fairness-scenario.toml",
    runId: "fairness-baseline",
  },
  {
    scenarioPath: "tests/acceptance/fixtures/fairness-perturbed-scenario.toml",
    runId: "fairness-perturbed",
  },
] as const;

test("fairness", { timeout: 300_000 }, async (t) => {
  const baseline = await runFairnessVariant(variants[0], t.signal);
  const perturbed = await runFairnessVariant(variants[1], t.signal);

  assert.notDeepStrictEqual(
    baseline.seatOneChest,
    perturbed.seatOneChest,
    "the second run must change the chest contents received by seat one",
  );
  assert.deepStrictEqual(
    baseline.seatZeroReceipts,
    perturbed.seatZeroReceipts,
    "seat zero must receive the same chunk history in both runs",
  );
  assert.deepStrictEqual(
    permittedObservation(baseline.seatZeroObservation),
    permittedObservation(perturbed.seatZeroObservation),
    "seat zero's complete permitted observation must not expose seat one's changed chest contents",
  );
  assert.deepStrictEqual(
    baseline.seatZeroDecision,
    perturbed.seatZeroDecision,
    "the deterministic policy decision must be unchanged at the same tick and RNG state",
  );
  assert.equal(
    baseline.policyRandomState,
    perturbed.policyRandomState,
    "the deterministic policy must start from the same RNG state in both runs",
  );
});

async function runFairnessVariant(
  variant: (typeof variants)[number],
  signal: AbortSignal,
): Promise<{
  readonly seatZeroReceipts: ReturnType<AcceptanceRunContext["competitors"][number]["chunkReceipts"]>["chunkColumns"];
  readonly seatOneChest: Awaited<ReturnType<ReturnType<typeof createMineflayerSemanticWorldReader>["readContainer"]>>;
  readonly seatZeroObservation: AgentObservation;
  readonly seatZeroDecision: ReturnType<typeof decide>;
  readonly policyRandomState: bigint;
}> {
  let capture: Awaited<ReturnType<typeof captureFairnessRun>> | undefined;
  const completed = await runOwnedAcceptanceScenario(
    variant.scenarioPath,
    variant.runId,
    async (active, runSignal) => {
      capture = await captureFairnessRun(active, runSignal);
      await active.start();
      await active.waitForOutcome();
    },
    signal,
  );
  assert.equal(completed.outcome.kind, "draw", "fairness fixture must finish its bounded observation run");
  assert.ok(capture, "fairness evaluator must capture observations before the match starts");
  return capture;
}

async function captureFairnessRun(active: AcceptanceRunContext, signal: AbortSignal) {
  const seatZero = competitorForSeat(active, 0);
  const seatOne = competitorForSeat(active, 1);
  const map = active.preparedRun.scenario.map;
  const chest = map.lootContainers[0];
  assert.ok(chest, "fairness fixture must declare the hidden chest");

  const chestColumn = {
    x: Math.floor(chest.position.x / 16) * 16,
    z: Math.floor(chest.position.z / 16) * 16,
  };
  const seatZeroReceipts = seatZero.chunkReceipts();
  const seatOneReceipts = seatOne.chunkReceipts();
  assert.ok(
    seatOneReceipts.chunkColumns.some(({ x, z }) => x === chestColumn.x && z === chestColumn.z),
    "seat one must receive the chunk column containing its chest",
  );
  assert.ok(
    !seatZeroReceipts.chunkColumns.some(({ x, z }) => x === chestColumn.x && z === chestColumn.z),
    "seat zero must not receive the chunk column containing seat one's chest",
  );
  assert.notDeepStrictEqual(
    seatZeroReceipts.chunkColumns,
    seatOneReceipts.chunkColumns,
    "each competitor must retain its own distinct received chunk history",
  );

  const seatZeroReader = createMineflayerSemanticWorldReader(seatZero.bot, competitorUsernamesBySeat(active));
  const seatOneReader = createMineflayerSemanticWorldReader(seatOne.bot, competitorUsernamesBySeat(active));
  assert.equal(
    seatZeroReader.readBlock(chest.position),
    null,
    "seat zero's client world must not contain the far chest block",
  );
  const seatOneChest = await seatOneReader.readContainer(chest.position, signal);
  assert.equal(seatOneChest.slots.length, 27, "seat one's real chest window must expose every slot");
  assert.ok(seatOneChest.slots.some((item) => item !== null), "seat one's chest must contain configured items");

  const seatZeroObservation = await waitForCompleteObservation(seatZero.client, signal);
  const random = DeterministicRandom.forStream(
    active.preparedRun.scenario.seed,
    RandomStream.policy(seatId(0)),
  );
  const policyRandomState = random.snapshotState();
  const seatZeroDecision = decide(
    seatZeroObservation,
    emptyPolicyMemory(),
    PolicyParams.baseline(),
    random,
  );

  return {
    seatZeroReceipts: seatZeroReceipts.chunkColumns,
    seatOneChest,
    seatZeroObservation,
    seatZeroDecision,
    policyRandomState,
  };
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

function competitorUsernamesBySeat(active: AcceptanceRunContext): ReadonlyMap<number, string> {
  assert.equal(active.prepare.type, "prepare");
  return new Map(active.prepare.payload.roster.map(({ seat, username }) => [seat, username] as const));
}

async function waitForCompleteObservation(
  client: AcceptanceRunContext["competitors"][number]["client"],
  signal: AbortSignal,
): Promise<AgentObservation> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const observation = client.observe(0);
    if (observation.agent.kind === "current"
        && observation.border.kind === "current"
        && observation.opponents.kind === "current"
        && observation.loot.kind === "current") {
      return observation;
    }
    await delay(50, undefined, { signal });
  }
  throw new Error("seat zero did not receive complete current perception within 20000 ms");
}

function permittedObservation(observation: AgentObservation) {
  return {
    tick: observation.tick,
    agent: observation.agent,
    border: observation.border,
    opponents: observation.opponents,
    loot: observation.loot,
  };
}
