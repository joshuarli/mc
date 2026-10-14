import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createMineflayerArenaClient, type MineflayerArenaClient } from "@arena/bots";
import { blockPosition, entityId, type SkillOutcome } from "@arena/core";
import { createBot, type Bot } from "mineflayer";

const JOIN_TIMEOUT_MS = 60_000;
const ATTACK_COOLDOWN_MS = 700;
const MAX_ATTACKS = 25;

export interface GameAddress {
  readonly host: string;
  readonly port: number;
  readonly version: string;
  readonly viewDistance: number;
}

export interface ConnectionAttempt {
  readonly bot: Bot;
  readonly ended: Promise<{ readonly reason: string }>;
  readonly spawned: Promise<void>;
  close(): void;
}

export function attemptConnection(address: GameAddress, username: string): ConnectionAttempt {
  const bot = createBot({
    host: address.host,
    port: address.port,
    username,
    auth: "offline",
    version: address.version,
    viewDistance: address.viewDistance,
    logErrors: false,
  });
  let kickReason = "connection ended";
  bot.on("error", () => undefined);
  bot.on("kicked", (reason) => { kickReason = String(reason); });
  const ended = new Promise<{ readonly reason: string }>((resolve) => {
    bot.once("end", (reason) => resolve({ reason: kickReason === "connection ended" ? String(reason) : kickReason }));
  });
  const spawned = new Promise<void>((resolve) => { bot.once("spawn", () => resolve()); });
  void spawned.catch(() => undefined);
  return {
    bot,
    ended,
    spawned,
    close: () => {
      if (!bot._client.ended) bot.end("external surrogate cleanup");
      bot._client.socket.destroy();
    },
  };
}

export class ExternalSurrogate {
  readonly bot: Bot;
  readonly client: MineflayerArenaClient;
  readonly username: string;
  readonly #attempt: ConnectionAttempt;
  #minimumHealth = 20;

  private constructor(attempt: ConnectionAttempt, client: MineflayerArenaClient, username: string) {
    this.#attempt = attempt;
    this.bot = attempt.bot;
    this.client = client;
    this.username = username;
    this.bot.on("health", () => { this.#minimumHealth = Math.min(this.#minimumHealth, this.bot.health); });
  }

  static async join(address: GameAddress, username: string, signal: AbortSignal): Promise<ExternalSurrogate> {
    const attempt = attemptConnection(address, username);
    try {
      const injected = once(attempt.bot, "inject_allowed");
      await withDeadline(Promise.race([
        injected,
        attempt.ended.then(({ reason }) => { throw new Error(`surrogate ${username} ended before injection: ${reason}`); }),
      ]), signal, `surrogate ${username} did not reach injection`);
      const client = createMineflayerArenaClient(attempt.bot);
      await withDeadline(Promise.race([
        attempt.spawned,
        attempt.ended.then(({ reason }) => { throw new Error(`surrogate ${username} was disconnected: ${reason}`); }),
      ]), signal, `surrogate ${username} did not spawn`);
      return new ExternalSurrogate(attempt, client, username);
    } catch (error) {
      attempt.close();
      throw error;
    }
  }

  get gameMode(): string {
    return this.bot.game.gameMode;
  }

  get minimumHealth(): number {
    return this.#minimumHealth;
  }

  get ended(): Promise<{ readonly reason: string }> {
    return this.#attempt.ended;
  }

  async lootNearestChest(signal: AbortSignal): Promise<readonly string[]> {
    const before = inventoryNames(this.bot);
    const chest = this.bot.findBlock({ matching: (block) => block.name === "chest", maxDistance: 96 });
    assert.ok(chest, `surrogate ${this.username} has no chest in its loaded world`);
    const standing = standableNear(this.bot, chest.position.x, chest.position.y, chest.position.z);
    await this.run({
      kind: "navigateToBlock",
      target: blockPosition(standing.x, standing.y, standing.z),
    }, signal, "navigate beside the chest");
    await this.run({
      kind: "containerOpen",
      position: blockPosition(chest.position.x, chest.position.y, chest.position.z),
    }, signal, "open the chest");
    await delay(500, undefined, { signal });
    const gained = inventoryNames(this.bot).filter((name) => !before.includes(name));
    assert.ok(gained.length > 0, "opening the chest must add an item to the surrogate inventory");
    return gained;
  }

  async strike(targetUsername: string, signal: AbortSignal, eliminated: () => boolean): Promise<number> {
    return await engage(this.client, this.bot, targetUsername, signal, eliminated);
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
    this.#attempt.close();
    await this.#attempt.ended;
  }

  async run(intent: Parameters<MineflayerArenaClient["run"]>[0], signal: AbortSignal, description: string): Promise<void> {
    signal.throwIfAborted();
    const outcome: SkillOutcome = await this.client.run(intent);
    assert.deepStrictEqual(outcome, { kind: "succeeded" }, `surrogate must ${description}`);
  }
}

export async function engage(
  client: Pick<MineflayerArenaClient, "run">,
  bot: Bot,
  targetUsername: string,
  signal: AbortSignal,
  eliminated: () => boolean,
): Promise<number> {
  let attacks = 0;
  while (attacks < MAX_ATTACKS) {
    signal.throwIfAborted();
    if (eliminated()) return attacks;
    const entity = bot.players[targetUsername]?.entity;
    assert.ok(entity, `${bot.username} has not received entity ${targetUsername}`);
    const standing = standableNear(bot, entity.position.x, entity.position.y, entity.position.z);
    await runIntent(client, {
      kind: "navigateToBlock",
      target: blockPosition(standing.x, standing.y, standing.z),
    }, signal, `${bot.username} must stage beside ${targetUsername}`);
    await runIntent(client, { kind: "approach", target: entityId(entity.id) }, signal, `${bot.username} must approach ${targetUsername}`);
    await bot.lookAt(entity.position.offset(0, entity.height * 0.6, 0), true);
    await runIntent(client, { kind: "attack", target: entityId(entity.id) }, signal, `${bot.username} must attack ${targetUsername}`);
    attacks += 1;
    await delay(ATTACK_COOLDOWN_MS, undefined, { signal });
  }
  throw new Error(`${targetUsername} survived ${MAX_ATTACKS} ordinary attacks`);
}

async function runIntent(
  client: Pick<MineflayerArenaClient, "run">,
  intent: Parameters<MineflayerArenaClient["run"]>[0],
  signal: AbortSignal,
  description: string,
): Promise<void> {
  signal.throwIfAborted();
  const outcome: SkillOutcome = await client.run(intent);
  assert.deepStrictEqual(outcome, { kind: "succeeded" }, description);
}

function at(bot: Bot, x: number, y: number, z: number) {
  const origin = bot.entity.position;
  return origin.offset(x - origin.x, y - origin.y, z - origin.z);
}

function standableNear(bot: Bot, x: number, y: number, z: number): { x: number; y: number; z: number } {
  const centerX = Math.floor(x);
  const centerY = Math.floor(y);
  const centerZ = Math.floor(z);
  let best: { x: number; y: number; z: number; score: number } | undefined;
  for (let dx = -4; dx <= 4; dx += 1) {
    for (let dz = -4; dz <= 4; dz += 1) {
      const span = Math.max(Math.abs(dx), Math.abs(dz));
      if (span < 2) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        const candidateX = centerX + dx;
        const candidateY = centerY + dy;
        const candidateZ = centerZ + dz;
        const feet = bot.blockAt(at(bot, candidateX, candidateY, candidateZ));
        const head = bot.blockAt(at(bot, candidateX, candidateY + 1, candidateZ));
        const floor = bot.blockAt(at(bot, candidateX, candidateY - 1, candidateZ));
        if (feet?.name !== "air" || head?.name !== "air" || floor?.boundingBox !== "block") continue;
        const score = bot.entity.position.distanceTo(at(bot, candidateX + 0.5, candidateY, candidateZ + 0.5)) + span;
        if (best === undefined || score < best.score) best = { x: candidateX, y: candidateY, z: candidateZ, score };
      }
    }
  }
  assert.ok(best, `no standable block within four blocks of ${centerX},${centerY},${centerZ}`);
  return { x: best.x, y: best.y, z: best.z };
}

export async function waitUntil(
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

function inventoryNames(bot: Bot): string[] {
  return bot.inventory.items().map((item) => item.name);
}

async function withDeadline<T>(operation: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), JOIN_TIMEOUT_MS);
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        deadline.signal.addEventListener("abort", () => reject(new Error(message)), { once: true });
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
