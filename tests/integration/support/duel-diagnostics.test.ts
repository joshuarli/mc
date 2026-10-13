import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Bot } from "mineflayer";

import type { AcceptanceRunContext } from "./owned-run.js";
import {
  captureDuelCombatWindow,
  MAX_DUEL_COMBAT_DIAGNOSTIC_BYTES,
  serializeDuelCombatDiagnosticArtifact,
} from "./duel-diagnostics.js";
import type { DuelCombatDiagnosticArtifact } from "./duel-diagnostics.js";

test("duel combat diagnostics preserve abort and operation failures after successful cleanup and staging", async () => {
  const active = duelContext().active;
  const abortReason = new Error("resource monitor abort");
  const controller = new AbortController();
  controller.abort(abortReason);
  const operationFailure = new Error("independent combat operation rejection");
  let closeCalls = 0;
  let stageCalls = 0;

  for (const primary of [controller.signal.reason, operationFailure]) {
    await assert.rejects(
      captureDuelCombatWindow({
        active,
        attackerSeat: 0,
        targetSeat: 1,
        snapshotKnockback: () => ({ damageEvents: 0 }),
        closeKnockback: () => { closeCalls += 1; },
        stageArtifact: async (artifact) => {
          stageCalls += 1;
          assert.ok(artifact.records.some((record) => record.kind === "captureStarted"));
        },
        runCombat: async (diagnostics) => {
          diagnostics.mark("attackStarted");
          throw primary;
        },
      }),
      (error) => error === primary,
    );
  }
  assert.equal(closeCalls, 2);
  assert.equal(stageCalls, 2);
});

test("duel combat diagnostics aggregate cleanup and staging failures without losing the combat failure", async () => {
  const active = duelContext().active;
  const primary = new Error("initiating combat failure");
  const closeFailure = new Error("knockback cleanup failure");
  const stageFailure = new Error("artifact staging failure");

  await assert.rejects(
    captureDuelCombatWindow({
      active,
      attackerSeat: 0,
      targetSeat: 1,
      snapshotKnockback: () => ({}),
      closeKnockback: () => { throw closeFailure; },
      stageArtifact: async () => { throw stageFailure; },
      runCombat: async () => { throw primary; },
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepStrictEqual(error.errors, [primary, closeFailure, stageFailure]);
      return true;
    },
  );
});

test("duel combat diagnostics capture poses, border, damage, and combat packets, then release owned hooks", async () => {
  const { active, writeCalls } = duelContext();
  const attacker = active.competitors[0]!.bot as Bot;
  const target = active.competitors[1]!.bot as Bot;
  const originalWrite = attacker._client.write;
  const attackPacket = { target: target.entity.id, mouse: 1 };
  let artifact: DuelCombatDiagnosticArtifact | undefined;
  await captureDuelCombatWindow({
    active,
    attackerSeat: 0,
    targetSeat: 1,
    snapshotKnockback: () => ({ damageEvents: 1 }),
    closeKnockback: () => {},
    stageArtifact: async (captured) => { artifact = captured; },
    runCombat: async (diagnostics) => {
      attacker.emit("physicsTick");
      target.emit("entityHurt", target.entity, attacker.entity);
      attacker._client.emit("packet", { entityId: target.entity.id, velocityX: 1 }, { name: "entity_velocity" });
      target._client.emit("packet", { x: 40.5, y: 65, z: 32.5 }, { name: "position" });
      attacker._client.write("use_entity", attackPacket);
      diagnostics.mark("attackStarted");
    },
  });

  assert.ok(artifact);
  assert.equal(writeCalls.length, 1, "the wrapper must call the original packet writer once");
  assert.equal(writeCalls[0]?.name, "use_entity");
  assert.equal(writeCalls[0]?.packet, attackPacket, "the wrapper must pass through the original packet object");
  assert.equal(artifact.records[0]?.latestObservedMatchTick, 900);
  assert.ok(artifact.records.some((record) => record.kind === "pose" && record.seat === 0));
  assert.ok(artifact.records.some((record) => record.kind === "entityHurt" && record.seat === 1));
  assert.ok(artifact.records.some((record) => record.kind === "packet_in"
    && record.data.name === "entity_velocity"));
  assert.ok(artifact.records.some((record) => record.kind === "packet_in" && record.data.name === "position"));
  assert.ok(artifact.records.some((record) => record.kind === "packet_out" && record.data.name === "use_entity"));
  assert.deepStrictEqual(artifact.records[0]?.border, { centerX: 32, centerZ: 32, diameterBlocks: 56 });

  assert.equal(attacker._client.write, originalWrite);
  assert.equal(attacker.listenerCount("physicsTick"), 0);
  assert.equal(target.listenerCount("entityHurt"), 0);
  assert.equal(attacker._client.listenerCount("packet"), 0);
  const capturedCount = artifact.records.length;
  attacker.emit("physicsTick");
  attacker._client.write("use_entity", attackPacket);
  assert.equal(writeCalls.length, 2, "the restored writer must continue sending after capture closes");
  assert.equal(artifact.records.length, capturedCount);
});

test("duel combat diagnostics retain a byte-bounded recent window and serialize within the cap", async () => {
  const { active } = duelContext();
  let artifact: DuelCombatDiagnosticArtifact | undefined;
  await captureDuelCombatWindow({
    active,
    attackerSeat: 0,
    targetSeat: 1,
    snapshotKnockback: () => ({}),
    closeKnockback: () => {},
    stageArtifact: async (captured) => { artifact = captured; },
    runCombat: async (diagnostics) => {
      for (let index = 0; index < 4_500; index += 1) {
        diagnostics.mark("combatEvent", { detail: "x".repeat(1_000), index });
      }
    },
  });
  assert.ok(artifact);
  const serialized = serializeDuelCombatDiagnosticArtifact(artifact);
  assert.ok(artifact.droppedRecords > 0);
  assert.ok(artifact.records.length < 4_096, "the byte budget must evict records before reaching the count cap");
  assert.ok(serialized.byteLength <= MAX_DUEL_COMBAT_DIAGNOSTIC_BYTES);
  assert.equal(artifact.records.at(-1)?.data.index, 4_499);

  let countLimitedArtifact: DuelCombatDiagnosticArtifact | undefined;
  await captureDuelCombatWindow({
    active,
    attackerSeat: 0,
    targetSeat: 1,
    snapshotKnockback: () => ({}),
    closeKnockback: () => {},
    stageArtifact: async (captured) => { countLimitedArtifact = captured; },
    runCombat: async (diagnostics) => {
      for (let index = 0; index < 4_500; index += 1) diagnostics.mark("combatEvent", { index });
    },
  });
  assert.ok(countLimitedArtifact);
  assert.equal(countLimitedArtifact.records.length, 4_096);
  assert.ok(countLimitedArtifact.droppedRecords > 0);
});

function duelContext() {
  const writeCalls: Array<{ readonly name: string; readonly packet: unknown }> = [];
  const makeBot = (id: number, username: string) => {
    const bot = new EventEmitter() as EventEmitter & {
      entity: Record<string, unknown>;
      players: Record<string, { entity: Record<string, unknown> }>;
      _client: EventEmitter & { write: (name: string, packet: unknown) => void };
      entityAtCursor: () => Record<string, unknown>;
      blockAtCursor: () => { name: string; position: { x: number; y: number; z: number } };
      health: number;
      food: number;
    };
    bot.entity = {
      id,
      username,
      position: { x: 40 + id, y: 65, z: 32 },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      onGround: true,
      height: 1.8,
    };
    bot.players = {};
    bot._client = new EventEmitter() as EventEmitter & { write: (name: string, packet: unknown) => void };
    bot._client.write = (name, packet) => writeCalls.push({ name, packet });
    bot.entityAtCursor = () => bot.entity;
    bot.blockAtCursor = () => ({ name: "air", position: { x: 0, y: 0, z: 0 } });
    bot.health = 20;
    bot.food = 20;
    return bot;
  };
  const attacker = makeBot(1, "bot_0");
  const target = makeBot(2, "bot_1");
  attacker.players.bot_1 = { entity: target.entity };
  target.players.bot_0 = { entity: attacker.entity };
  const competitors = [attacker, target].map((bot, seat) => ({
    identity: { username: `bot_${seat}`, offlineUuid: `uuid-${seat}` },
    bot,
    client: {},
  }));
  const events = [{
    type: "public_clock",
    payload: { tick: { domain: "match", value: 900n }, border_diameter_blocks: 56 },
  }];
  const active = {
    prepare: { type: "prepare", payload: { roster: competitors.map(({ identity }, seat) => ({
      seat,
      username: identity.username,
      offline_uuid: identity.offlineUuid,
    })) } },
    competitors,
    preparedRun: { scenario: { map: { dimensions: { width: 64, depth: 64 } } } },
    events: () => events,
  } as unknown as AcceptanceRunContext;
  return { active, writeCalls };
}
