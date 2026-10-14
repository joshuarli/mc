import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  attachActionFunnelSink,
  type ArenaSkillIntent,
} from "@arena/bots";
import {
  createPolicyFeedback,
  decide,
  DeterministicRandom,
  emptyPolicyMemory,
  PolicyParams,
  RandomStream,
  seatId,
  type ActionFunnelRecord,
  type Decision,
  type PolicyFeedback,
  type PolicyMemory,
  type SkillOutcome,
} from "@arena/core";
import type { Bot } from "mineflayer";

import { competitorForSeat } from "./duel.js";
import type { AcceptanceRunContext } from "./owned-run.js";

export type CurriculumSeat = ReturnType<typeof competitorForSeat>;

export interface AgentStep {
  readonly decision: Decision;
  readonly outcome: SkillOutcome | null;
  readonly funnel: ActionFunnelRecord | null;
  readonly ticks: number;
}

export interface AgentTally {
  attacks: number;
  attackRejections: number;
  funnel: ActionFunnelRecord[];
}

export function seatFor(active: AcceptanceRunContext, seat: number): CurriculumSeat {
  return competitorForSeat(active, seat);
}

export class CurriculumAgent {
  readonly tally: AgentTally = { attacks: 0, attackRejections: 0, funnel: [] };
  readonly #seat: CurriculumSeat;
  readonly #random: DeterministicRandom;
  readonly #params = PolicyParams.baseline();
  #memory: PolicyMemory = emptyPolicyMemory();
  #feedback: PolicyFeedback[] = [];
  #tick = 0;
  #lastRecord: ActionFunnelRecord | null = null;

  constructor(seat: CurriculumSeat, seatNumber: number, seed: bigint) {
    this.#seat = seat;
    this.#random = DeterministicRandom.forStream(seed, RandomStream.policy(seatId(seatNumber)));
    const gameplay = seat.gameplay;
    if (gameplay.mode !== "hunger_games") throw new Error("curriculum cases require Hunger Games");
    attachActionFunnelSink(gameplay.client, (record) => {
      this.#lastRecord = record;
      this.tally.funnel.push(record);
    });
  }

  get bot(): Bot {
    return this.#seat.bot;
  }

  observe() {
    const gameplay = this.#seat.gameplay;
    if (gameplay.mode !== "hunger_games") throw new Error("curriculum cases require Hunger Games");
    this.#tick += 1;
    return gameplay.client.observe(this.#tick);
  }

  decideOnly(): Decision {
    const observation = this.observe();
    const decision = decide(observation, this.#memory, this.#params, this.#random, this.#feedback);
    this.#feedback = [];
    this.#memory = decision.memory;
    return decision;
  }

  async step(signal: AbortSignal): Promise<AgentStep> {
    signal.throwIfAborted();
    const observation = this.observe();
    const decision = decide(observation, this.#memory, this.#params, this.#random, this.#feedback);
    this.#feedback = [];
    this.#memory = decision.memory;
    if (decision.intent.kind === "hold") {
      await delay(50, undefined, { signal });
      return { decision, outcome: null, funnel: null, ticks: 0 };
    }
    return await this.#execute(decision, observation, signal);
  }

  async #execute(
    decision: Decision,
    observation: ReturnType<CurriculumAgent["observe"]>,
    signal: AbortSignal,
    recordFeedback = true,
  ): Promise<AgentStep> {
    this.#lastRecord = null;
    const started = performanceTicks(this.#seat.bot);
    const outcome = await this.#seat.client.run(decision.intent as ArenaSkillIntent);
    signal.throwIfAborted();
    if (decision.intent.kind === "attack") {
      this.tally.attacks += 1;
      if (outcome.kind === "failed" && outcome.cause === "preconditionsNotMet") this.tally.attackRejections += 1;
    }
    if (recordFeedback && (outcome.kind === "succeeded" || outcome.kind === "failed")) {
      const feedback = createPolicyFeedback({
        initiatingObservation: observation,
        goal: decision.goal,
        intent: decision.intent,
        outcome,
      });
      if (feedback !== null) this.#feedback.push(feedback);
    }
    return { decision, outcome, funnel: this.#lastRecord, ticks: performanceTicks(this.#seat.bot) - started };
  }

  async runIntent(intent: ArenaSkillIntent, signal: AbortSignal): Promise<AgentStep> {
    const observation = this.observe();
    const decision: Decision = {
      goal: { kind: "explore" },
      intent: intent as Decision["intent"],
      memory: this.#memory,
    };
    return await this.#execute(decision, observation, signal, false);
  }
}

const tickCounters = new WeakMap<Bot, { ticks: number }>();

function performanceTicks(bot: Bot): number {
  let counter = tickCounters.get(bot);
  if (counter === undefined) {
    const created = { ticks: 0 };
    counter = created;
    tickCounters.set(bot, created);
    bot.on("physicsTick", () => {
      created.ticks += 1;
    });
  }
  return counter.ticks;
}

export function watchTicks(bot: Bot): () => number {
  performanceTicks(bot);
  return () => performanceTicks(bot);
}

export async function waitForHealth(bot: Bot, minimum: number, signal: AbortSignal, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (bot.health < minimum) {
    signal.throwIfAborted();
    if (Date.now() > deadline) throw new Error(`health stayed below ${minimum}: ${bot.health}`);
    await delay(250, undefined, { signal });
  }
}

export async function fineMove(
  bot: Bot,
  axis: "x" | "z",
  delta: number,
  signal: AbortSignal,
): Promise<void> {
  const yaw = axis === "z" ? (delta < 0 ? 0 : Math.PI) : (delta < 0 ? Math.PI / 2 : -Math.PI / 2);
  await bot.look(yaw, 0, true);
  const start = bot.entity.position[axis];
  bot.setControlState("sneak", true);
  bot.setControlState("forward", true);
  try {
    const deadline = Date.now() + 5_000;
    while (Math.abs(bot.entity.position[axis] - start) < Math.abs(delta) - 0.03) {
      signal.throwIfAborted();
      if (Date.now() > deadline) throw new Error("fine movement did not reach its displacement");
      await delay(20, undefined, { signal });
    }
  } finally {
    bot.setControlState("forward", false);
    bot.setControlState("sneak", false);
  }
  await delay(150, undefined, { signal });
}

export async function stageSeat(
  seat: CurriculumSeat,
  target: { readonly x: number; readonly y: number; readonly z: number },
  signal: AbortSignal,
): Promise<void> {
  const outcome = await seat.client.run({ kind: "navigateToBlock", target: { x: target.x, y: target.y, z: target.z } as never });
  signal.throwIfAborted();
  assert.deepStrictEqual(outcome, { kind: "succeeded" }, `staging at ${target.x},${target.y},${target.z}`);
}

export interface ServerDamageEvent {
  readonly attacker: string;
  readonly victim: string;
  readonly amount: number;
}

export function serverDamageEvents(runId: string): readonly ServerDamageEvent[] {
  const log = readFileSync(join(process.cwd(), ".work/arena/runs", runId, "server/logs/latest.log"), "utf8");
  const events: ServerDamageEvent[] = [];
  for (const line of log.split(/\r?\n/)) {
    const match = /ARENA_DAMAGE\|([^|]+)\|([^|]+)\|amount=([0-9.]+)/.exec(line);
    if (match !== null) events.push({ attacker: match[1]!, victim: match[2]!, amount: Number(match[3]) });
  }
  return events;
}

export function countItem(bot: Bot, name: string): number {
  return bot.inventory.items().filter((item) => item.name === name).reduce((total, item) => total + item.count, 0);
}

export async function takeFromChest(
  seat: CurriculumSeat,
  chest: { readonly x: number; readonly y: number; readonly z: number },
  signal: AbortSignal,
): Promise<SkillOutcome> {
  const navigate = await seat.client.run({ kind: "navigate", target: { x: chest.x, y: chest.y, z: chest.z } as never });
  signal.throwIfAborted();
  assert.deepStrictEqual(navigate, { kind: "succeeded" }, "navigation to the chest must succeed");
  const outcome = await seat.client.run({ kind: "containerOpen", position: { x: chest.x, y: chest.y, z: chest.z } as never });
  signal.throwIfAborted();
  return outcome;
}

export function strafeUntilAborted(bot: Bot, signal: AbortSignal, periodMs = 900): Promise<void> {
  return (async () => {
    let left = true;
    try {
      while (!signal.aborted) {
        bot.setControlState("left", left);
        bot.setControlState("right", !left);
        left = !left;
        await delay(periodMs, undefined, { signal });
      }
    } catch {
      // aborted
    } finally {
      bot.setControlState("left", false);
      bot.setControlState("right", false);
    }
  })();
}

export async function concludeByDisconnect(
  active: AcceptanceRunContext,
  seats: readonly number[],
  signal: AbortSignal,
): Promise<void> {
  for (const seat of seats) {
    signal.throwIfAborted();
    try {
      seatFor(active, seat).bot.quit("curriculum case complete");
    } catch {
      // seat already gone
    }
    await delay(200, undefined, { signal });
  }
}

export interface ArrowFlightSample {
  readonly speeds: number[];
  readonly verticalAccelerations: number[];
}

export function trackArrow(bot: Bot): { stop(): ArrowFlightSample[] } {
  const flights = new Map<number, { positions: { x: number; y: number; z: number }[] }>();
  const onMove = (entity: Bot["entity"]): void => {
    if (entity.name !== "arrow") return;
    const flight = flights.get(entity.id) ?? { positions: [] };
    flights.set(entity.id, flight);
    flight.positions.push({ x: entity.position.x, y: entity.position.y, z: entity.position.z });
  };
  bot.on("entitySpawn", onMove);
  bot.on("entityMoved", onMove);
  return {
    stop: () => {
      bot.removeListener("entitySpawn", onMove);
      bot.removeListener("entityMoved", onMove);
      return [...flights.values()].map(({ positions }) => {
        const speeds: number[] = [];
        const verticalAccelerations: number[] = [];
        for (let index = 1; index < positions.length; index += 1) {
          const a = positions[index - 1]!;
          const b = positions[index]!;
          speeds.push(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
        }
        for (let index = 2; index < positions.length; index += 1) {
          const a = positions[index - 2]!;
          const b = positions[index - 1]!;
          const c = positions[index]!;
          verticalAccelerations.push(c.y - 2 * b.y + a.y);
        }
        return { speeds, verticalAccelerations };
      });
    },
  };
}

export async function swingAndMeasure(
  attacker: Bot,
  victim: Bot,
  signal: AbortSignal,
): Promise<number> {
  const before = victim.health;
  attacker.attack(victim.entity);
  await delay(450, undefined, { signal });
  return before - victim.health;
}
