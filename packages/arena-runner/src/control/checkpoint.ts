import { createHash } from "node:crypto";

import {
  invalid,
  readArray,
  readBoolean,
  readFiniteNumber,
  readObject,
  readPreparePayload,
  readSafeInteger,
  readString,
  readU64
} from "./codec.js";
import { parseStrictJson, StrictJsonError } from "./strict-json.js";
import type { StrictJsonValue } from "./strict-json.js";
import type { HungerGamesV2PreparePayload } from "./types.js";

export const CHECKPOINT_SCHEMA_VERSION = 1;
export const MAX_CHECKPOINT_BODY_BYTES = 32 * 1024 * 1024;
const TRAILER_PREFIX = "#arena-checkpoint-complete v1 sha256=";
const MAX_EPOCH = 1_000_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class CheckpointDecodeError extends Error {
  constructor(message: string, readonly path: string | null = null) {
    super(message);
    this.name = "CheckpointDecodeError";
  }
}

export interface CheckpointLivingState {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly health: number;
  readonly food: number;
  readonly saturation: number;
  readonly selected_slot: number;
  readonly inventory: readonly { readonly slot: number; readonly item: string }[];
}

export interface CheckpointSeat {
  readonly seat: number;
  readonly alive: boolean;
  readonly uuid: string;
  readonly username: string;
  readonly state?: CheckpointLivingState;
}

export interface CheckpointExtension {
  readonly version: number;
  readonly payload: string;
}

export interface CheckpointRecord {
  readonly schema: 1;
  readonly checkpoint_id: string;
  readonly run_id: string;
  readonly epoch: number;
  readonly world_identity: string;
  readonly prepare: HungerGamesV2PreparePayload;
  readonly match_tick: bigint;
  readonly border_diameter_blocks: number;
  readonly eliminations: readonly { readonly seat: number; readonly cause: "death" | "disconnect"; readonly tick: bigint }[];
  readonly seats: readonly CheckpointSeat[];
  readonly extension: CheckpointExtension | null;
}

export function encodeCheckpointBody(record: CheckpointRecord): Uint8Array {
  const replacer = (_key: string, value: unknown): unknown => typeof value === "bigint" ? value.toString(10) : value;
  return new TextEncoder().encode(JSON.stringify(sortKeys(JSON.parse(JSON.stringify(record, replacer))), replacer));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    return sorted;
  }
  return value;
}

export function decodeCheckpoint(bytes: Uint8Array): { readonly record: CheckpointRecord; readonly digest: string; readonly byteLength: number } {
  const text = Buffer.from(bytes);
  const split = text.lastIndexOf(0x0a, text.length - 2);
  if (text.length < 2 || text[text.length - 1] !== 0x0a || split < 0) {
    throw new CheckpointDecodeError("checkpoint has no completion trailer");
  }
  const body = text.subarray(0, split);
  const digest = createHash("sha256").update(body).digest("hex");
  const expected = `${TRAILER_PREFIX}${digest} bytes=${body.length}\n`;
  if (body.length === 0 || body.length > MAX_CHECKPOINT_BODY_BYTES
      || text.subarray(split + 1).toString("ascii") !== expected) {
    throw new CheckpointDecodeError("checkpoint trailer does not match its body");
  }
  let value: StrictJsonValue;
  try {
    value = parseStrictJson(body);
  } catch (error) {
    if (error instanceof StrictJsonError) throw new CheckpointDecodeError(`checkpoint JSON rejected: ${error.code}`);
    throw error;
  }
  try {
    return { record: readRecord(value), digest, byteLength: body.length };
  } catch (error) {
    if (error instanceof Error && error.name === "ControlCodecError") {
      throw new CheckpointDecodeError(error.message, (error as { path?: string | null }).path ?? null);
    }
    throw error;
  }
}

function readRecord(value: StrictJsonValue): CheckpointRecord {
  const keys = ["schema", "checkpoint_id", "run_id", "epoch", "world_identity", "prepare", "match_tick",
    "border_diameter_blocks", "eliminations", "seats", "extension"];
  const root = readObject(value, "checkpoint", keys, keys);
  readSafeInteger(root.schema, "checkpoint.schema", CHECKPOINT_SCHEMA_VERSION, CHECKPOINT_SCHEMA_VERSION, root, "schema");
  const prepare = readPreparePayload(root.prepare as StrictJsonValue);
  if (!("roster_version" in prepare) || "resume" in prepare) {
    invalid("checkpoint.prepare", "must be the original generalized-roster prepare");
  }
  const border = readFiniteNumber(root.border_diameter_blocks, "checkpoint.border_diameter_blocks");
  if (border <= 0) invalid("checkpoint.border_diameter_blocks", "must be positive");

  const eliminationValues = readArray(root.eliminations, "checkpoint.eliminations", 0, 256);
  let previous = -1;
  const eliminations = eliminationValues.map((entry, index) => {
    const path = `checkpoint.eliminations[${index}]`;
    const item = readObject(entry, path, ["seat", "cause", "tick"], ["seat", "cause", "tick"]);
    const seat = readSafeInteger(item.seat, `${path}.seat`, 0, 255, item, "seat");
    if (seat <= previous || seat >= prepare.roster.length) invalid(`${path}.seat`, "eliminations must be ascending roster seats");
    previous = seat;
    const cause = readString(item.cause, `${path}.cause`, 1, 16);
    if (cause !== "death" && cause !== "disconnect") invalid(`${path}.cause`, "unknown elimination cause");
    return { seat, cause, tick: readU64(item.tick, `${path}.tick`, false) } as const;
  });
  const dead = new Set(eliminations.map(({ seat }) => seat));

  const seatValues = readArray(root.seats, "checkpoint.seats", 1, 256);
  if (seatValues.length !== prepare.roster.length) invalid("checkpoint.seats", "must describe every roster seat");
  let living = 0;
  const seats = seatValues.map((entry, index): CheckpointSeat => {
    const path = `checkpoint.seats[${index}]`;
    const item = readObject(entry, path, ["seat", "alive", "uuid", "username", "state"], ["seat", "alive", "uuid", "username"]);
    const seat = readSafeInteger(item.seat, `${path}.seat`, 0, 255, item, "seat");
    const alive = readBoolean(item.alive, `${path}.alive`);
    const uuid = readString(item.uuid, `${path}.uuid`, 36, 36, UUID_PATTERN);
    const username = readString(item.username, `${path}.username`, 1, 16, /^[A-Za-z0-9_]+$/);
    const competitor = prepare.roster[index];
    if (seat !== index || competitor === undefined || competitor.username !== username
        || competitor.offline_uuid !== uuid || alive === dead.has(index)) {
      invalid(path, "seat state must match the roster identity and eliminations");
    }
    if (alive !== Object.hasOwn(item, "state")) invalid(`${path}.state`, "state belongs exactly to living seats");
    if (alive) living += 1;
    return alive
      ? { seat, alive, uuid, username, state: readLivingState(item.state, `${path}.state`) }
      : { seat, alive, uuid, username };
  });
  if (living < 2) invalid("checkpoint.seats", "a checkpoint needs at least two living seats");

  let extension: CheckpointExtension | null = null;
  if (root.extension !== null) {
    const item = readObject(root.extension, "checkpoint.extension", ["version", "payload"], ["version", "payload"]);
    extension = {
      version: readSafeInteger(item.version, "checkpoint.extension.version", 1, 65_535, item, "version"),
      payload: readString(item.payload, "checkpoint.extension.payload", 0, 2 * 1024 * 1024, /^[A-Za-z0-9+/]*={0,2}$/)
    };
  }
  return {
    schema: 1,
    checkpoint_id: readString(root.checkpoint_id, "checkpoint.checkpoint_id", 1, 64, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
    run_id: readString(root.run_id, "checkpoint.run_id", 1, 64, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
    epoch: readSafeInteger(root.epoch, "checkpoint.epoch", 0, MAX_EPOCH, root, "epoch"),
    world_identity: readString(root.world_identity, "checkpoint.world_identity", 64, 64, /^[0-9a-f]{64}$/),
    prepare,
    match_tick: readU64(root.match_tick, "checkpoint.match_tick", false),
    border_diameter_blocks: border,
    eliminations,
    seats,
    extension
  };
}

function readLivingState(value: StrictJsonValue | undefined, path: string): CheckpointLivingState {
  const keys = ["x", "y", "z", "yaw", "pitch", "health", "food", "saturation", "selected_slot", "inventory"];
  const state = readObject(value, path, keys, keys);
  const health = readFiniteNumber(state.health, `${path}.health`);
  if (health <= 0) invalid(`${path}.health`, "living seats have positive health");
  const items = readArray(state.inventory, `${path}.inventory`, 0, 64).map((entry, index) => {
    const itemPath = `${path}.inventory[${index}]`;
    const item = readObject(entry, itemPath, ["slot", "item"], ["slot", "item"]);
    return {
      slot: readSafeInteger(item.slot, `${itemPath}.slot`, 0, 255, item, "slot"),
      item: readString(item.item, `${itemPath}.item`, 1, 65_536, /^[A-Za-z0-9+/]+={0,2}$/)
    };
  });
  return {
    x: readFiniteNumber(state.x, `${path}.x`),
    y: readFiniteNumber(state.y, `${path}.y`),
    z: readFiniteNumber(state.z, `${path}.z`),
    yaw: readFiniteNumber(state.yaw, `${path}.yaw`),
    pitch: readFiniteNumber(state.pitch, `${path}.pitch`),
    health,
    food: readSafeInteger(state.food, `${path}.food`, 0, 20, state, "food"),
    saturation: readFiniteNumber(state.saturation, `${path}.saturation`),
    selected_slot: readSafeInteger(state.selected_slot, `${path}.selected_slot`, 0, 8, state, "selected_slot"),
    inventory: items
  };
}
