import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentObservation, agentState, blockPosition, currentKnowledge, emptyEquipment,
  inventorySlot, observationSequence, tick, unknownKnowledge, type SkillOutcome,
} from "@arena/core";

import { failureCleanup } from "../../../packages/arena-runner/src/runtime/failures.js";
import { eliminateOpponentWithSkillAttacks, runEvaluatorSkill, stageOpponentForCombat } from "./duel.js";
import type { AcceptanceRunContext } from "./owned-run.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

test("combat staging uses block navigation and verifies the exact arrival tile", async () => {
  const destination = blockPosition(40, 65, 32);
  const target = { position: { x: 52.5, y: 65, z: 32.5 } };
  let requestedIntent: unknown;
  const identity = { username: "bot_1", offlineUuid: "uuid-1" };
  const active = {
    prepare: { type: "prepare", payload: { roster: [{
      seat: 1, username: identity.username, offline_uuid: identity.offlineUuid,
    }] } },
    competitors: [{
      identity,
      client: {
        run: async (intent: unknown) => {
          requestedIntent = intent;
          target.position = { x: 40.5, y: 65, z: 32.5 };
          return { kind: "succeeded" } as const;
        },
      },
      bot: { entity: target },
    }],
  } as unknown as AcceptanceRunContext;

  await stageOpponentForCombat(active, 1, destination, new AbortController().signal);

  assert.deepStrictEqual(requestedIntent, { kind: "navigateToBlock", target: destination });
});

test("evaluator skill cancellation preserves the initiating run failure", async () => {
  const controller = new AbortController();
  const primary = new Error("run aborted");
  const started = deferred<void>();
  const skill = deferred<SkillOutcome>();
  const observation = agentObservation({
    tick: tick(0), sequence: observationSequence(1),
    agent: currentKnowledge(agentState({ position: blockPosition(0, 64, 0), healthHalfHearts: 40,
      hungerPoints: 20, foodStacks: [], equipped: emptyEquipment(),
      upgrades: [{ inventorySlot: inventorySlot(0), equipmentSlot: "weapon", rating: 1 }],
    })),
    border: unknownKnowledge(), opponents: unknownKnowledge(), loot: unknownKnowledge(),
  });
  const identity = (seat: number) => ({ username: `bot_${seat}`, offlineUuid: `uuid-${seat}` });
  const active = {
    prepare: { type: "prepare", payload: { roster: [0, 1].map((seat) => ({
      seat, username: identity(seat).username, offline_uuid: identity(seat).offlineUuid,
    })) } },
    competitors: [
      { identity: identity(0), gameplay: { mode: "hunger_games", client: { observe: () => observation } }, client: {
        observe: () => observation,
        run: () => { started.resolve(); return skill.promise; },
      } },
      { identity: identity(1) },
    ],
  } as unknown as AcceptanceRunContext;
  const task = eliminateOpponentWithSkillAttacks(active, 0, 1, controller.signal);
  const joined = assert.rejects(task, (error: unknown) => {
    assert.strictEqual(error, primary);
    assert.deepStrictEqual(failureCleanup(error, primary), { status: "succeeded", source: null });
    return true;
  });
  await started.promise;
  controller.abort(primary);
  skill.resolve({ kind: "cancelled", reason: "shutdown" });
  await joined;
});

test("evaluator skill refuses to start after its signal is aborted", async () => {
  const controller = new AbortController();
  const primary = new Error("run aborted");
  controller.abort(primary);
  let started = false;
  await assert.rejects(runEvaluatorSkill({ run: async () => {
    started = true;
    return { kind: "succeeded" };
  } }, { kind: "navigate", target: blockPosition(0, 64, 0) }, controller.signal), (error: unknown) => error === primary);
  assert.equal(started, false);
});

test("evaluator skill leaves an unaborted failed outcome subject to the caller assertion", async () => {
  const controller = new AbortController();
  const failed = { kind: "failed", cause: "serverRejected" } as const;
  const outcome = await runEvaluatorSkill({ run: async () => failed },
    { kind: "navigate", target: blockPosition(0, 64, 0) }, controller.signal);
  assert.strictEqual(outcome, failed);
  const primary = new Error("run aborted");
  assert.throws(() => assert.deepStrictEqual(outcome, { kind: "succeeded" }), (error: unknown) =>
    error instanceof assert.AssertionError && failureCleanup(error, primary).status === "failed");
});

test("evaluator skill preserves an independent operation rejection even after signal abortion", async () => {
  const controller = new AbortController();
  const primary = new Error("run aborted");
  const assertion = new assert.AssertionError({ message: "skill operation failed independently" });
  const started = deferred<void>();
  let reject!: (error: unknown) => void;
  const skill = new Promise<SkillOutcome>((_resolve, fail) => { reject = fail; });
  const task = runEvaluatorSkill({ run: () => { started.resolve(); return skill; } },
    { kind: "navigate", target: blockPosition(0, 64, 0) }, controller.signal);
  const joined = assert.rejects(task, (error: unknown) => {
    assert.strictEqual(error, assertion);
    assert.equal(failureCleanup(error, primary).status, "failed");
    return true;
  });
  await started.promise;
  controller.abort(primary);
  reject(assertion);
  await joined;
});
