import { performance } from "node:perf_hooks";
import type { Bot } from "mineflayer";

import { competitorForSeat } from "./duel.js";
import type { AcceptanceRunContext } from "./owned-run.js";

type Entity = Bot["entity"];

const MAX_DUEL_COMBAT_DIAGNOSTIC_RECORDS = 4_096;
const ARTIFACT_WRAPPER_RESERVE_BYTES = 8_192;
export const MAX_DUEL_COMBAT_DIAGNOSTIC_BYTES = 4 * 1024 * 1024;

const TRACKED_INCOMING_PACKETS = new Set([
  "entity_look",
  "entity_move",
  "entity_move_look",
  "entity_status",
  "entity_teleport",
  "entity_velocity",
  "initialize_world_border",
  "position",
  "rel_entity_move",
  "sync_entity_position",
  "update_health",
  "world_border_center",
  "world_border_lerp_size",
  "world_border_size",
]);

interface DiagnosticRecord {
  readonly clientMs: number;
  /** Latest received public clock; it can precede the authoritative tick that processes an outgoing swing. */
  readonly latestObservedMatchTick: number | null;
  readonly border: Readonly<{
    readonly centerX: number;
    readonly centerZ: number;
    readonly diameterBlocks: number;
  }> | null;
  readonly kind: string;
  readonly seat: number | null;
  readonly data: Readonly<Record<string, unknown>>;
  readonly knockback: Readonly<Record<string, number>>;
}

export interface DuelCombatDiagnosticArtifact {
  readonly schema: 1;
  readonly attackerSeat: number;
  readonly targetSeat: number;
  readonly droppedRecords: number;
  readonly records: readonly DiagnosticRecord[];
}

interface DuelCombatDiagnosticSession {
  mark(kind: string, data?: Readonly<Record<string, unknown>>): void;
  snapshot(): DuelCombatDiagnosticArtifact;
  close(): void;
}

/** Closes every combat observer, stages its bounded record, and preserves the original combat error. */
export async function captureDuelCombatWindow(
  options: Readonly<{
    active: AcceptanceRunContext;
    attackerSeat: number;
    targetSeat: number;
    snapshotKnockback: () => Readonly<Record<string, number>>;
    closeKnockback: () => void;
    stageArtifact: (artifact: DuelCombatDiagnosticArtifact) => Promise<void>;
    runCombat: (diagnostics: DuelCombatDiagnosticSession) => Promise<void>;
  }>,
): Promise<void> {
  let diagnostics: DuelCombatDiagnosticSession | undefined;
  let combatFailed = false;
  let combatFailure: unknown;
  try {
    diagnostics = createDuelCombatDiagnostics({
      active: options.active,
      attackerSeat: options.attackerSeat,
      targetSeat: options.targetSeat,
      snapshotKnockback: options.snapshotKnockback,
    });
    await options.runCombat(diagnostics);
  } catch (error) {
    combatFailed = true;
    combatFailure = error;
  }

  const cleanupErrors: unknown[] = [];
  if (diagnostics !== undefined) {
    try {
      diagnostics.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    options.closeKnockback();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (diagnostics !== undefined) {
    try {
      await options.stageArtifact(diagnostics.snapshot());
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (combatFailed) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError([combatFailure, ...cleanupErrors], "combat and diagnostic finalization both failed");
    }
    throw combatFailure;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "duel diagnostic finalization failed");
  }
}

/** Captures only a bounded combat window and owns every listener and packet wrapper it installs. */
function createDuelCombatDiagnostics(
  options: Readonly<{
    active: AcceptanceRunContext;
    attackerSeat: number;
    targetSeat: number;
    snapshotKnockback: () => Readonly<Record<string, number>>;
  }>,
): DuelCombatDiagnosticSession {
  const { active, attackerSeat, targetSeat, snapshotKnockback } = options;
  const attacker = competitorForSeat(active, attackerSeat);
  const target = competitorForSeat(active, targetSeat);
  const records: DiagnosticRecord[] = [];
  const cleanup: Array<() => void> = [];
  let droppedRecords = 0;
  let recordBytes = 0;
  let closed = false;

  const append = (kind: string, seat: number | null, data: Readonly<Record<string, unknown>> = {}): void => {
    if (closed) throw new Error("duel combat diagnostics are closed");
    const clock = latestPublicClock(active);
    const dimensions = active.preparedRun.scenario.map.dimensions;
    const record: DiagnosticRecord = {
      clientMs: performance.now(),
      latestObservedMatchTick: clock?.payload.tick?.domain === "match"
        ? safeMatchTick(clock.payload.tick.value)
        : null,
      border: clock === undefined ? null : {
        centerX: dimensions.width / 2,
        centerZ: dimensions.depth / 2,
        diameterBlocks: clock.payload.border_diameter_blocks,
      },
      kind,
      seat,
      data: projectRecord(data),
      knockback: { ...snapshotKnockback() },
    };
    const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
    const recordBudget = MAX_DUEL_COMBAT_DIAGNOSTIC_BYTES - ARTIFACT_WRAPPER_RESERVE_BYTES;
    if (bytes > recordBudget) throw new RangeError(`duel diagnostic record exceeded ${recordBudget} bytes`);
    while (records.length === MAX_DUEL_COMBAT_DIAGNOSTIC_RECORDS || recordBytes + bytes > recordBudget) {
      const removed = records.shift();
      if (removed === undefined) throw new Error("duel diagnostic record budget accounting is inconsistent");
      recordBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
      droppedRecords += 1;
    }
    records.push(record);
    recordBytes += bytes;
  };

  const participants = [
    { seat: attackerSeat, bot: attacker.bot, remote: target.bot, remoteUsername: target.identity.username },
    { seat: targetSeat, bot: target.bot, remote: attacker.bot, remoteUsername: attacker.identity.username },
  ] as const;

  try {
    for (const participant of participants) {
      const { bot, remote, remoteUsername, seat } = participant;
      const onPhysicsTick = (): void => {
        const self = bot.entity;
        const remoteEntity = bot.players[remoteUsername]?.entity ?? undefined;
        const aimEntity = seat === attackerSeat ? bot.entityAtCursor(3.5) : undefined;
        const blockingBlock = seat === attackerSeat ? bot.blockAtCursor(3.5) : null;
        append("pose", seat, {
          self: entityPose(self),
          target: remoteEntity === undefined ? null : entityPose(remoteEntity),
          distanceBlocks: remoteEntity === undefined ? null : distance(self.position, remoteEntity.position),
          aimEntityId: aimEntity?.id ?? null,
          blockingBlock: blockingBlock === null ? null : {
            name: blockingBlock.name,
            position: vector(blockingBlock.position),
          },
        });
      };
      const onEntityHurt = (victim?: Entity, source?: Entity): void => {
        if (victim?.id !== bot.entity.id && source?.id !== bot.entity.id) return;
        append("entityHurt", seat, {
          victim: victim === undefined ? null : entityPose(victim),
          source: source === undefined ? null : entityPose(source),
        });
      };
      const onHealth = (): void => {
        append("health", seat, { health: bot.health, food: bot.food });
      };
      const onPacket = (data: unknown, metadata: { readonly name?: string }): void => {
        const name = metadata.name;
        if (name === undefined || !TRACKED_INCOMING_PACKETS.has(name)) return;
        const fields = projectPacket(data);
        if (name === "entity_velocity" && fields.entityId !== bot.entity.id && fields.entityId !== remote.entity.id) return;
        if (name === "entity_status" && fields.entityId !== bot.entity.id && fields.entityId !== remote.entity.id) return;
        append("packet_in", seat, { name, fields });
      };

      bot.on("physicsTick", onPhysicsTick);
      cleanup.push(() => bot.removeListener("physicsTick", onPhysicsTick));
      bot.on("entityHurt", onEntityHurt);
      cleanup.push(() => bot.removeListener("entityHurt", onEntityHurt));
      bot.on("health", onHealth);
      cleanup.push(() => bot.removeListener("health", onHealth));
      bot._client.on("packet", onPacket);
      cleanup.push(() => bot._client.removeListener("packet", onPacket));
    }

    const transport = attacker.bot._client;
    const originalWrite = transport.write;
    const wrappedWrite: typeof transport.write = (name, packet) => {
      const result = originalWrite.call(transport, name, packet);
      if (name === "use_entity") append("packet_out", attackerSeat, { name, fields: projectPacket(packet) });
      return result;
    };
    transport.write = wrappedWrite;
    cleanup.push(() => {
      if (transport.write !== wrappedWrite) throw new Error("attacker packet writer changed while duel diagnostics were active");
      transport.write = originalWrite;
    });
    append("captureStarted", null, { attackerSeat, targetSeat });
  } catch (error) {
    try {
      closeResources(cleanup);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "duel diagnostic setup and cleanup both failed");
    }
    throw error;
  }
  return {
    mark: (kind, data) => append(kind, null, data),
    snapshot: () => ({ schema: 1, attackerSeat, targetSeat, droppedRecords, records: [...records] }),
    close: () => {
      if (closed) return;
      closed = true;
      closeResources(cleanup);
    },
  };
}

export function serializeDuelCombatDiagnosticArtifact(artifact: DuelCombatDiagnosticArtifact): Buffer {
  const contents = Buffer.from(JSON.stringify(artifact), "utf8");
  if (contents.byteLength > MAX_DUEL_COMBAT_DIAGNOSTIC_BYTES) {
    throw new RangeError(`duel combat diagnostics exceeded ${MAX_DUEL_COMBAT_DIAGNOSTIC_BYTES} bytes`);
  }
  return contents;
}

function closeResources(cleanup: readonly (() => void)[]): void {
  const errors: unknown[] = [];
  for (const dispose of cleanup.toReversed()) {
    try {
      dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "duel diagnostic cleanup failed");
}

type PublicClockEvent = Extract<ReturnType<AcceptanceRunContext["events"]>[number], { readonly type: "public_clock" }>;

function latestPublicClock(active: AcceptanceRunContext): PublicClockEvent | undefined {
  return active.events().findLast((event): event is PublicClockEvent => event.type === "public_clock");
}

function safeMatchTick(value: bigint): number {
  const tick = Number(value);
  if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError(`combat diagnostic tick is invalid: ${value}`);
  return tick;
}

function entityPose(entity: Entity): Readonly<Record<string, unknown>> {
  return {
    id: entity.id,
    username: entity.username ?? null,
    position: vector(entity.position),
    velocity: vector(entity.velocity),
    yawRad: entity.yaw,
    pitchRad: entity.pitch,
    onGround: entity.onGround,
  };
}

function vector(value: { readonly x: number; readonly y: number; readonly z: number }): Readonly<{ x: number; y: number; z: number }> {
  return { x: value.x, y: value.y, z: value.z };
}

function distance(first: { readonly x: number; readonly y: number; readonly z: number }, second: { readonly x: number; readonly y: number; readonly z: number }): number {
  return Math.hypot(first.x - second.x, first.y - second.y, first.z - second.z);
}

function projectPacket(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const fields: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value).slice(0, 24)) {
    if (field === null || typeof field === "boolean" || typeof field === "number") {
      fields[key] = field;
    } else if (typeof field === "string") {
      fields[key] = field.slice(0, 80);
    } else if (Array.isArray(field) && field.length <= 4
        && field.every((element) => element === null || ["boolean", "number", "string"].includes(typeof element))) {
      fields[key] = field.map((element) => typeof element === "string" ? element.slice(0, 80) : element);
    } else if (field !== null && typeof field === "object") {
      const record = field as Record<string, unknown>;
      if (["x", "y", "z"].every((axis) => typeof record[axis] === "number")) {
        fields[key] = { x: record.x, y: record.y, z: record.z };
      }
    }
  }
  return fields;
}

function projectRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return JSON.parse(JSON.stringify(value)) as Readonly<Record<string, unknown>>;
}
