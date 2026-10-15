import { createHash } from "node:crypto";

import {
  EXTERNAL_USERNAME_PATTERN,
  LEGACY_MAX_COMPETITORS,
  MAX_COMPETITORS,
  MAX_FRONTIER_EDITS_PER_SEAT,
  MAX_FRONTIER_EDIT_RADIUS_BLOCKS,
  MAX_SQUADS,
  MIN_FRONTIER_EDIT_RADIUS_BLOCKS,
  SQUAD_ID_PATTERN,
  UHC_ARMOR_TIERS,
  UHC_SWORD_MATERIALS,
  uhcFoodStackLimit
} from "@arena/spec";

import {
  isWellFormedUnicode,
  parseStrictJson,
  StrictJsonError,
  strictJsonNumberToken,
  type StrictJsonValue
} from "./strict-json.js";
import { CONTROL_CAPABILITIES } from "./types.js";
import type {
  AbortReason,
  AuthoritativeTick,
  BlockPosition,
  BorderSettings,
  BuildProgressPayload,
  CheckpointCommandPayload,
  CheckpointWrittenPayload,
  ClockPayload,
  BotCompetitor,
  CaptureZone,
  CivilizationBlueprint,
  CivilizationDrawOutcome,
  CivilizationFactions,
  CivilizationPrepareSettings,
  CivilizationScenarioSettings,
  CivilizationStartingKit,
  CivilizationStatePayload,
  ControlCapability,
  ControlErrorCode,
  DamageCause,
  DamageEntry,
  DamagePayload,
  MechanicsReceipt,
  MechanicsReceiptPayload,
  ControlMessage,
  EmberFaction,
  FactionId,
  FactionScores,
  EliminationPayload,
  FixedBorderSettings,
  HelloPayload,
  HungerGamesDrawOutcome,
  HungerGamesPrepareSettings,
  MatchSettings,
  MetricsPayload,
  OutcomePayload,
  PreparePayload,
  PrepareRules,
  PublicStatePayload,
  ResumeReference,
  ReadyPayload,
  RosterCompetitor,
  SquadDefinition,
  TideFaction,
  UhcDuelKit
} from "./types.js";

export const MAX_CONTROL_FRAME_BYTES = 1_048_576;

const CIVILIZATION_SEAT_COUNT = 6;
const MAX_SEAT = MAX_COMPETITORS - 1;
const MAX_EPOCH = 1_000_000;
const RESERVED_RUNNER_USERNAME = /^arena(?:bot|spec)/i;
const UHC_ARMOR = new Set<string>(UHC_ARMOR_TIERS);
const UHC_SWORDS = new Set<string>(UHC_SWORD_MATERIALS);

const MAX_U64 = 18_446_744_073_709_551_615n;
const U64_DECIMAL = /^(?:0|[1-9][0-9]{0,18}|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|1844674407370955[0][0-9]{3}|18446744073709551[0-5][0-9]{2}|184467440737095516[0][0-9]|1844674407370955161[0-5]|18446744073709551615)$/;
const POSITIVE_U64_DECIMAL = /^(?:[1-9][0-9]{0,18}|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|1844674407370955[0][0-9]{3}|18446744073709551[0-5][0-9]{2}|184467440737095516[0][0-9]|1844674407370955161[0-5]|18446744073709551615)$/;

export type ControlCodecErrorCode =
  | "invalid_frame"
  | "oversized_frame"
  | "invalid_message"
  | "unsupported_protocol"
  | "run_mismatch"
  | "non_monotonic_sequence"
  | "authentication_failed"
  | "unsupported_capability"
  | "invalid_handshake"
  | "invalid_correlation";

export class ControlCodecError extends Error {
  readonly code: ControlCodecErrorCode;
  readonly path: string | null;

  constructor(code: ControlCodecErrorCode, message: string, path: string | null = null) {
    super(message);
    this.name = "ControlCodecError";
    this.code = code;
    this.path = path;
  }
}

export function decodeControlEnvelope(input: string | Uint8Array): ControlMessage {
  if (input instanceof Uint8Array && input.byteLength > MAX_CONTROL_FRAME_BYTES) {
    throw new ControlCodecError("oversized_frame", "control JSON exceeds the 1 MiB limit");
  }
  try {
    if (typeof input === "string" && new TextEncoder().encode(input).byteLength > MAX_CONTROL_FRAME_BYTES) {
      throw new ControlCodecError("oversized_frame", "control JSON exceeds the 1 MiB limit");
    }
    return deepFreeze(readEnvelope(parseStrictJson(input)));
  } catch (error) {
    if (error instanceof ControlCodecError) throw error;
    if (error instanceof StrictJsonError) {
      throw new ControlCodecError("invalid_message", `control JSON rejected: ${error.code}`);
    }
    throw error;
  }
}

export function encodeControlEnvelope(message: ControlMessage): Uint8Array {
  const wireValue = toStrictJsonValue(message, new Set());
  const validated = readEnvelope(wireValue);
  const bytes = new TextEncoder().encode(JSON.stringify(sortObjectKeys(toStrictJsonValue(validated, new Set()))));
  if (bytes.byteLength > MAX_CONTROL_FRAME_BYTES) {
    throw new ControlCodecError("oversized_frame", "control JSON exceeds the 1 MiB limit");
  }
  return bytes;
}

export function decodeControlFrame(frame: Uint8Array): ControlMessage {
  if (frame.byteLength < 4) throw new ControlCodecError("invalid_frame", "control frame is shorter than its length prefix");
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const bodyLength = view.getUint32(0, false);
  if (bodyLength === 0) throw new ControlCodecError("invalid_frame", "control frame body cannot be empty");
  if (bodyLength > MAX_CONTROL_FRAME_BYTES) {
    throw new ControlCodecError("oversized_frame", "control frame exceeds the 1 MiB limit");
  }
  if (frame.byteLength !== bodyLength + 4) {
    throw new ControlCodecError("invalid_frame", "control frame length prefix does not match its body");
  }
  return decodeControlEnvelope(frame.subarray(4));
}

export function encodeControlFrame(message: ControlMessage): Uint8Array {
  const body = encodeControlEnvelope(message);
  const frame = new Uint8Array(body.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, body.byteLength, false);
  frame.set(body, 4);
  return frame;
}

export function assertControlCorrelation(message: ControlMessage, requestSequence: bigint): void {
  if (message.correlation !== requestSequence) {
    throw new ControlCodecError("invalid_correlation", "control response correlation does not match its request");
  }
}

export class ControlReceiver {
  private lastSequence = 0n;
  private handshake: "hello" | "ready" | "complete" | "terminal" = "hello";
  private expectedReadyCorrelation: bigint | null = null;
  private helloCapabilities: readonly ControlCapability[] = [];
  private readonly supportedCapabilities: ReadonlySet<ControlCapability>;

  constructor(
    private readonly runId: string,
    private readonly expectedToken: string,
    supportedCapabilities: readonly ControlCapability[]
  ) {
    if (!matchesPattern(runId, RUN_ID) || expectedToken.length === 0) {
      throw new ControlCodecError("invalid_handshake", "control receiver requires a valid run id and token");
    }
    const supported = new Set(supportedCapabilities);
    if (supported.size !== supportedCapabilities.length || supported.size === 0
        || supportedCapabilities.some((capability) => !CAPABILITIES.has(capability))) {
      throw new ControlCodecError("invalid_handshake", "control receiver capability set is invalid");
    }
    this.supportedCapabilities = new Set(supported);
  }

  get isReady(): boolean {
    return this.handshake === "complete" || this.handshake === "terminal";
  }

  get isTerminal(): boolean {
    return this.handshake === "terminal";
  }

  get lastAcceptedSequence(): bigint {
    return this.lastSequence;
  }

  expectReadyAfter(ackSequence: bigint): void {
    if (this.handshake !== "ready" || ackSequence <= 0n || ackSequence > MAX_U64) {
      throw new ControlCodecError("invalid_handshake", "ready correlation can be set only after an authenticated hello");
    }
    this.expectedReadyCorrelation = ackSequence;
  }

  acceptFrame(frame: Uint8Array): ControlMessage {
    if (this.handshake === "terminal") {
      throw new ControlCodecError("invalid_handshake", "control stream cannot continue after its outcome");
    }
    const message = decodeControlFrame(frame);
    if (message.run_id !== this.runId) {
      throw new ControlCodecError("run_mismatch", "control message belongs to a different run");
    }
    if (message.sequence <= this.lastSequence) {
      throw new ControlCodecError("non_monotonic_sequence", "control sequence must increase within its direction");
    }

    if (this.handshake === "hello") {
      if (message.type !== "hello") {
        throw new ControlCodecError("invalid_handshake", "plugin must authenticate before sending control events");
      }
      this.acceptHello(message.payload);
      this.handshake = "ready";
    } else if (this.handshake === "ready") {
      if (message.type !== "ready" || this.expectedReadyCorrelation === null
          || message.correlation !== this.expectedReadyCorrelation) {
        throw new ControlCodecError("invalid_handshake", "plugin readiness must correlate with the authenticated hello acknowledgment");
      }
      const announced = new Set(message.payload.capabilities);
      if (announced.size !== this.helloCapabilities.length
          || this.helloCapabilities.some((capability) => !announced.has(capability))) {
        throw new ControlCodecError("invalid_handshake", "ready capabilities differ from the authenticated hello");
      }
      this.handshake = "complete";
    } else if (!isPluginEvent(message)) {
      throw new ControlCodecError("invalid_handshake", "plugin sent a runner-only command or repeated handshake event");
    }

    if (this.handshake === "complete" && message.type === "checkpoint_written"
        && !this.helloCapabilities.includes("checkpoint_v1")) {
      throw new ControlCodecError("unsupported_capability", "plugin sent a checkpoint event without advertising checkpoint_v1");
    }

    if (this.handshake === "complete" && message.type === "metrics"
        && message.payload.tick_durations_micros !== undefined
        && !this.helloCapabilities.includes("tick_metrics_v1")) {
      throw new ControlCodecError("unsupported_capability", "plugin sent tick metrics without advertising tick_metrics_v1");
    }

    if (this.handshake === "complete" && message.type === "damage"
        && !this.helloCapabilities.includes("damage_events_v1")) {
      throw new ControlCodecError("unsupported_capability", "plugin sent a damage event without advertising damage_events_v1");
    }

    if (this.handshake === "complete" && message.type === "mechanics_receipt"
        && !this.helloCapabilities.includes("duel_mechanics_v1")) {
      throw new ControlCodecError("unsupported_capability", "plugin sent mechanics receipts without advertising duel_mechanics_v1");
    }

    if (this.handshake === "complete" && requiresCivilizationCapability(message)
        && !this.helloCapabilities.includes("civilization_v1")) {
      throw new ControlCodecError("unsupported_capability", "plugin sent a civilization event without advertising civilization_v1");
    }

    this.lastSequence = message.sequence;
    if (this.handshake === "complete" && message.type === "outcome") this.handshake = "terminal";
    return message;
  }

  private acceptHello(payload: HelloPayload): void {
    if (payload.token !== this.expectedToken) {
      throw new ControlCodecError("authentication_failed", "plugin control token is invalid");
    }
    for (const capability of payload.capabilities) {
      if (!this.supportedCapabilities.has(capability)) {
        throw new ControlCodecError("unsupported_capability", "plugin announced an unsupported capability");
      }
    }
    this.helloCapabilities = Object.freeze([...payload.capabilities]);
  }
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CAPABILITIES = new Set<ControlCapability>(CONTROL_CAPABILITIES);
const ABORT_REASONS = new Set<AbortReason>([
  "operator", "lease_lost", "invalid_world", "protocol_error", "runtime_timeout"
]);
const PHASES = new Set(["waiting", "countdown", "grace", "active", "finished", "aborted"]);

type StrictJsonObject = { readonly [key: string]: StrictJsonValue };
type RequiredObject<Keys extends readonly string[]> = StrictJsonObject & {
  readonly [Key in Keys[number]]: StrictJsonValue;
};

function isPluginEvent(message: ControlMessage): boolean {
  return message.type === "heartbeat" || message.type === "build_progress" || message.type === "public_clock"
    || message.type === "public_state" || message.type === "elimination" || message.type === "outcome"
    || message.type === "civilization_state" || message.type === "metrics" || message.type === "ack"
    || message.type === "checkpoint_written" || message.type === "damage" || message.type === "mechanics_receipt"
    || message.type === "error";
}

function requiresCivilizationCapability(message: ControlMessage): boolean {
  if (message.type === "civilization_state") return true;
  if (message.type !== "outcome") return false;
  return message.payload.kind === "faction_winner"
    || (message.payload.kind === "draw" && "scores" in message.payload);
}

export function readPreparePayload(value: StrictJsonValue): PreparePayload {
  return readPrepare(value);
}

function readEnvelope(value: StrictJsonValue): ControlMessage {
  const envelope = readObject(value, "envelope", ["protocol", "run_id", "sequence", "correlation", "type", "payload"],
    ["protocol", "run_id", "sequence", "type", "payload"]);
  if (readSafeInteger(envelope.protocol, "protocol", 0, Number.MAX_SAFE_INTEGER, envelope, "protocol") !== 1) {
    throw new ControlCodecError("unsupported_protocol", "control protocol version is unsupported", "protocol");
  }
  const runId = readString(envelope.run_id, "run_id", 1, 64, RUN_ID);
  const sequence = readU64(envelope.sequence, "sequence", true);
  const hasCorrelation = Object.hasOwn(envelope, "correlation");
  const correlation = hasCorrelation ? readU64(envelope.correlation!, "correlation", true) : undefined;
  const type = readString(envelope.type, "type", 1, 64);
  const payload = envelope.payload;
  const fields = correlation === undefined
    ? { protocol: 1 as const, run_id: runId, sequence }
    : { protocol: 1 as const, run_id: runId, sequence, correlation };

  switch (type) {
    case "hello":
      return { ...fields, type, payload: readHello(payload) };
    case "ready":
      requireCorrelation(correlation, type);
      return { ...fields, type, payload: readReady(payload) };
    case "heartbeat":
      return { ...fields, type, payload: readEmpty(payload, "payload") };
    case "build_progress":
      return { ...fields, type, payload: readBuildProgress(payload) };
    case "prepare":
      return { ...fields, type, payload: readPrepare(payload) };
    case "start":
      return { ...fields, type, payload: readEmpty(payload, "payload") };
    case "damage":
      return { ...fields, type, payload: readDamage(payload) };
    case "mechanics_receipt":
      return { ...fields, type, payload: readMechanicsReceipt(payload) };
    case "checkpoint":
      return { ...fields, type, payload: readCheckpointCommand(payload) };
    case "checkpoint_written":
      return { ...fields, type, payload: readCheckpointWritten(payload) };
    case "abort":
      return { ...fields, type, payload: readAbort(payload) };
    case "public_clock":
      return { ...fields, type, payload: readClock(payload) };
    case "public_state":
      return { ...fields, type, payload: readPublicState(payload) };
    case "elimination":
      return { ...fields, type, payload: readElimination(payload) };
    case "civilization_state":
      return { ...fields, type, payload: readCivilizationState(payload) };
    case "outcome":
      return { ...fields, type, payload: readOutcome(payload) };
    case "metrics":
      return { ...fields, type, payload: readMetrics(payload) };
    case "ack":
      requireCorrelation(correlation, type);
      return { ...fields, type, payload: readEmpty(payload, "payload") };
    case "error":
      return { ...fields, type, payload: readError(payload) };
    default:
      throw invalid("type", "unknown control message type");
  }
}

function readHello(value: StrictJsonValue): HelloPayload {
  const payload = readObject(value, "payload", ["token", "capabilities"], ["token", "capabilities"]);
  return {
    token: readString(payload.token, "payload.token", 1, 256, /^[A-Za-z0-9_-]+$/),
    capabilities: readCapabilities(payload.capabilities, "payload.capabilities")
  };
}

function readReady(value: StrictJsonValue): ReadyPayload {
  const payload = readObject(value, "payload", ["server", "plugin", "capabilities"], ["server", "plugin", "capabilities"]);
  const server = readObject(payload.server, "payload.server", ["name", "version", "minecraft_version", "protocol_version"],
    ["name", "version", "minecraft_version", "protocol_version"]);
  const plugin = readObject(payload.plugin, "payload.plugin", ["name", "version"], ["name", "version"]);
  return {
    server: {
      name: readString(server.name, "payload.server.name", 1, 128),
      version: readString(server.version, "payload.server.version", 1, 128),
      minecraft_version: readString(server.minecraft_version, "payload.server.minecraft_version", 1, 64),
      protocol_version: readSafeInteger(server.protocol_version, "payload.server.protocol_version", 0, 2_147_483_647, server, "protocol_version")
    },
    plugin: {
      name: readString(plugin.name, "payload.plugin.name", 1, 128),
      version: readString(plugin.version, "payload.plugin.version", 1, 128)
    },
    capabilities: readCapabilities(payload.capabilities, "payload.capabilities")
  };
}

function readCapabilities(value: StrictJsonValue | undefined, path: string): readonly ControlCapability[] {
  const values = readArray(value, path, 1, CAPABILITIES.size);
  const capabilities = values.map((entry, index) => {
    const capability = readString(entry, `${path}[${index}]`, 1, 64);
    if (!CAPABILITIES.has(capability as ControlCapability)) {
      throw new ControlCodecError("unsupported_capability", "control capability is unsupported", `${path}[${index}]`);
    }
    return capability as ControlCapability;
  });
  if (new Set(capabilities).size !== capabilities.length) invalid(path, "capabilities must be unique");
  return capabilities;
}

function readBuildProgress(value: StrictJsonValue): BuildProgressPayload {
  const payload = readObject(value, "payload", ["stage", "completed", "total"], ["stage", "completed", "total"]);
  const stage = readString(payload.stage, "payload.stage", 1, 64);
  if (stage !== "validating" && stage !== "preparing_world" && stage !== "snapshotting") invalid("payload.stage", "unknown build stage");
  const completed = readSafeInteger(payload.completed, "payload.completed", 0, Number.MAX_SAFE_INTEGER, payload, "completed");
  const total = readSafeInteger(payload.total, "payload.total", 0, Number.MAX_SAFE_INTEGER, payload, "total");
  if (completed > total) invalid("payload.completed", "completed cannot exceed total");
  return { stage, completed, total };
}

function readPrepare(value: StrictJsonValue): PreparePayload {
  const payload = readObject(value, "payload",
    ["map_semantic_id", "scenario_semantic_id", "seed", "mode", "settings", "roster", "roster_version", "rules", "resume", "damage_events"],
    ["map_semantic_id", "scenario_semantic_id", "seed", "mode", "settings", "roster"]);
  const mode = readString(payload.mode, "payload.mode", 1, 64);
  if (mode !== "hunger_games" && mode !== "civilization") invalid("payload.mode", "mode is unsupported by control-v1");
  const generalizedRoster = Object.hasOwn(payload, "roster_version");
  if (generalizedRoster) {
    if (mode !== "hunger_games") invalid("payload.roster_version", "only Hunger Games supports the generalized roster");
    readSafeInteger(payload.roster_version, "payload.roster_version", 2, 2, payload, "roster_version");
  }
  const common = {
    map_semantic_id: readString(payload.map_semantic_id, "payload.map_semantic_id", 64, 64, /^[0-9a-f]{64}$/),
    scenario_semantic_id: readString(payload.scenario_semantic_id, "payload.scenario_semantic_id", 64, 64, /^[0-9a-f]{64}$/),
    seed: readU64(payload.seed, "payload.seed", false)
  };
  if (Object.hasOwn(payload, "rules") && !generalizedRoster) {
    invalid("payload.rules", "rule modes require the generalized roster");
  }
  if (Object.hasOwn(payload, "damage_events") && !generalizedRoster) {
    invalid("payload.damage_events", "damage events require the generalized roster");
  }
  if (Object.hasOwn(payload, "resume") && !generalizedRoster) {
    invalid("payload.resume", "resume requires the generalized roster");
  }
  if (generalizedRoster) {
    const settings = readHungerGamesPrepareSettings(payload.settings);
    const roster = readGeneralizedRoster(payload.roster);
    const rules = Object.hasOwn(payload, "rules")
      ? readPrepareRules(payload.rules, roster.length, settings)
      : undefined;
    return {
      ...common,
      mode: "hunger_games",
      roster_version: 2,
      ...(rules === undefined ? {} : { rules }),
      ...(Object.hasOwn(payload, "resume") ? { resume: readResumeReference(payload.resume) } : {}),
      ...(Object.hasOwn(payload, "damage_events") && readBoolean(payload.damage_events, "payload.damage_events")
        ? { damage_events: true as const }
        : {}),
      settings,
      roster
    };
  }
  const roster = readBotRoster(payload.roster);
  if (mode === "hunger_games") {
    return { ...common, mode, settings: readHungerGamesPrepareSettings(payload.settings), roster };
  }
  if (roster.length !== CIVILIZATION_SEAT_COUNT) {
    invalid("payload.roster", "civilization requires exactly six bot competitors");
  }
  return { ...common, mode, settings: readCivilizationPrepareSettings(payload.settings), roster };
}

function readResumeReference(value: StrictJsonValue | undefined): ResumeReference {
  const path = "payload.resume";
  const reference = readObject(value, path, ["checkpoint_digest", "epoch"], ["checkpoint_digest", "epoch"]);
  return {
    checkpoint_digest: readString(reference.checkpoint_digest, `${path}.checkpoint_digest`, 64, 64, /^[0-9a-f]{64}$/),
    epoch: readSafeInteger(reference.epoch, `${path}.epoch`, 1, MAX_EPOCH, reference, "epoch")
  };
}

const DAMAGE_CAUSES = new Set<DamageCause>(["melee", "projectile", "border", "fall", "fire", "starvation", "other"]);
const MAX_DAMAGE_ENTRIES_PER_TICK = MAX_COMPETITORS * 8;

function readDamage(value: StrictJsonValue): DamagePayload {
  const payload = readObject(value, "payload", ["at", "entries"], ["at", "entries"]);
  const entries = readArray(payload.entries, "payload.entries", 1, MAX_DAMAGE_ENTRIES_PER_TICK).map((entry, index): DamageEntry => {
    const path = `payload.entries[${index}]`;
    const keys = ["victim", "attacker", "cause", "amount", "attacker_is_competitor"];
    const item = readObject(entry, path, keys, keys);
    const victim = readSafeInteger(item.victim, `${path}.victim`, 0, MAX_SEAT, item, "victim");
    const attacker = item.attacker === null
      ? null
      : readSafeInteger(item.attacker, `${path}.attacker`, 0, MAX_SEAT, item, "attacker");
    const cause = readString(item.cause, `${path}.cause`, 1, 16) as DamageCause;
    if (!DAMAGE_CAUSES.has(cause)) invalid(`${path}.cause`, "unknown damage cause");
    const amount = readFiniteNumber(item.amount, `${path}.amount`);
    if (amount <= 0) invalid(`${path}.amount`, "damage amount must be positive");
    const competitor = readBoolean(item.attacker_is_competitor, `${path}.attacker_is_competitor`);
    if (competitor !== (attacker !== null)) {
      invalid(`${path}.attacker_is_competitor`, "a competitor attacker is exactly an attacker with a seat");
    }
    if (attacker !== null && cause !== "melee" && cause !== "projectile" && cause !== "other") {
      invalid(`${path}.attacker`, "an attacker seat applies to melee, projectile, or other damage");
    }
    return { victim, attacker, cause, amount, attacker_is_competitor: competitor };
  });
  return { at: readTick(payload.at, "payload.at"), entries };
}

function readMechanicsReceipt(value: StrictJsonValue): MechanicsReceiptPayload {
  const payload = readObject(value, "payload", ["at", "receipts"], ["at", "receipts"]);
  const tick = readTick(payload.at, "payload.at");
  if (tick.domain !== "match") invalid("payload.at.domain", "mechanics receipts require a match tick");
  const seen = new Set<string>();
  const receipts = readArray(payload.receipts, "payload.receipts", 1, MAX_COMPETITORS * 6)
    .map((value, index): MechanicsReceipt => {
      const path = `payload.receipts[${index}]`;
      const item = readObject(value, path,
        ["seat", "kind", "blocks", "duration_ticks", "minimum_blocks", "maximum_blocks", "blocking", "enchanted"], ["seat", "kind"]);
      const seat = readSafeInteger(item.seat, `${path}.seat`, 0, MAX_SEAT, item, "seat");
      const kind = readString(item.kind, `${path}.kind`, 1, 64);
      let receipt: MechanicsReceipt;
      if (kind === "lateral_movement") {
        if (Object.hasOwn(item, "duration_ticks") || Object.hasOwn(item, "minimum_blocks") || Object.hasOwn(item, "maximum_blocks")
            || Object.hasOwn(item, "blocking") || Object.hasOwn(item, "enchanted")) invalid(path, "lateral movement has invalid fields");
        const blocks = readFiniteNumber(item.blocks, `${path}.blocks`);
        if (blocks < 1 || blocks > 1_000_000) invalid(`${path}.blocks`, "lateral movement must meet the one block threshold");
        receipt = { seat, kind, blocks };
      } else if (kind === "distance_maintained") {
        if (Object.hasOwn(item, "blocks") || Object.hasOwn(item, "blocking") || Object.hasOwn(item, "enchanted")) {
          invalid(path, "distance maintained has invalid fields");
        }
        const duration_ticks = readSafeInteger(item.duration_ticks, `${path}.duration_ticks`, 10, 10, item, "duration_ticks");
        const minimum_blocks = readFiniteNumber(item.minimum_blocks, `${path}.minimum_blocks`);
        const maximum_blocks = readFiniteNumber(item.maximum_blocks, `${path}.maximum_blocks`);
        if (minimum_blocks <= 4 || maximum_blocks > 40 || minimum_blocks > maximum_blocks) {
          invalid(path, "maintained distance must stay above four and within forty blocks");
        }
        receipt = { seat, kind, duration_ticks, minimum_blocks, maximum_blocks };
      } else if (kind === "ranged_projectile_release") {
        if (Object.hasOwn(item, "blocks") || Object.hasOwn(item, "duration_ticks") || Object.hasOwn(item, "minimum_blocks")
            || Object.hasOwn(item, "maximum_blocks") || Object.hasOwn(item, "blocking") || Object.hasOwn(item, "enchanted")) {
          invalid(path, "ranged projectile release has invalid fields");
        }
        receipt = { seat, kind };
      } else if (kind === "shield_blocking_transition") {
        if (Object.hasOwn(item, "blocks") || Object.hasOwn(item, "duration_ticks") || Object.hasOwn(item, "minimum_blocks")
            || Object.hasOwn(item, "maximum_blocks") || Object.hasOwn(item, "enchanted")) invalid(path, "shield transition has invalid fields");
        receipt = { seat, kind, blocking: readBoolean(item.blocking, `${path}.blocking`) };
      } else if (kind === "golden_apple_consume") {
        if (Object.hasOwn(item, "blocks") || Object.hasOwn(item, "duration_ticks") || Object.hasOwn(item, "minimum_blocks")
            || Object.hasOwn(item, "maximum_blocks") || Object.hasOwn(item, "blocking")) invalid(path, "golden apple consume has invalid fields");
        receipt = { seat, kind, enchanted: readBoolean(item.enchanted, `${path}.enchanted`) };
      } else {
        invalid(`${path}.kind`, "unknown mechanics receipt kind");
      }
      const transition = receipt.kind === "shield_blocking_transition" ? String(receipt.blocking) : "";
      const identity = `${seat}:${receipt.kind}:${transition}`;
      if (seen.has(identity)) invalid(path, "mechanics receipts must be unique by seat and action");
      seen.add(identity);
      return receipt;
    });
  return { at: tick, receipts };
}

function readCheckpointCommand(value: StrictJsonValue): CheckpointCommandPayload {
  const payload = readObject(value, "payload", ["checkpoint_id", "epoch"], ["checkpoint_id", "epoch"]);
  return {
    checkpoint_id: readString(payload.checkpoint_id, "payload.checkpoint_id", 1, 64, RUN_ID),
    epoch: readSafeInteger(payload.epoch, "payload.epoch", 0, MAX_EPOCH, payload, "epoch")
  };
}

function readCheckpointWritten(value: StrictJsonValue): CheckpointWrittenPayload {
  const keys = ["checkpoint_id", "epoch", "match_tick", "digest", "byte_length"];
  const payload = readObject(value, "payload", keys, keys);
  return {
    checkpoint_id: readString(payload.checkpoint_id, "payload.checkpoint_id", 1, 64, RUN_ID),
    epoch: readSafeInteger(payload.epoch, "payload.epoch", 0, MAX_EPOCH, payload, "epoch"),
    match_tick: readU64(payload.match_tick, "payload.match_tick", false),
    digest: readString(payload.digest, "payload.digest", 64, 64, /^[0-9a-f]{64}$/),
    byte_length: readSafeInteger(payload.byte_length, "payload.byte_length", 1, Number.MAX_SAFE_INTEGER, payload, "byte_length")
  };
}

function readPrepareRules(
  value: StrictJsonValue | undefined,
  competitors: number,
  settings: HungerGamesPrepareSettings
): PrepareRules {
  const path = "payload.rules";
  const header = readObject(value, path, ["kind", "version", "edit_radius_blocks", "max_block_edits_per_seat", "squads", "kit"],
    ["kind", "version"]);
  const kind = readString(header.kind, `${path}.kind`, 1, 32);
  readSafeInteger(header.version, `${path}.version`, 1, 1, header, "version");
  if (kind === "frontier_survival") {
    readObject(value, path, ["kind", "version", "edit_radius_blocks", "max_block_edits_per_seat"],
      ["kind", "version", "edit_radius_blocks", "max_block_edits_per_seat"]);
    if (!settings.match.block_breaking || !settings.match.block_placing
        || settings.match.natural_mobs || settings.match.natural_random_ticks) {
      invalid("payload.settings.match", "frontier survival requires block editing with mobs and random ticks off");
    }
    return {
      kind,
      version: 1,
      edit_radius_blocks: readSafeInteger(header.edit_radius_blocks, `${path}.edit_radius_blocks`,
        MIN_FRONTIER_EDIT_RADIUS_BLOCKS, MAX_FRONTIER_EDIT_RADIUS_BLOCKS, header, "edit_radius_blocks"),
      max_block_edits_per_seat: readSafeInteger(header.max_block_edits_per_seat, `${path}.max_block_edits_per_seat`,
        1, MAX_FRONTIER_EDITS_PER_SEAT, header, "max_block_edits_per_seat")
    };
  }
  if (kind === "squads") {
    readObject(value, path, ["kind", "version", "squads"], ["kind", "version", "squads"]);
    if (settings.match.block_breaking || settings.match.block_placing) {
      invalid("payload.settings.match", "squads use the classic block rules");
    }
    const entries = readArray(header.squads, `${path}.squads`, 2, MAX_SQUADS);
    const ids = new Set<string>();
    const assigned = new Set<number>();
    const squads = entries.map((entry, index): SquadDefinition => {
      const entryPath = `${path}.squads[${index}]`;
      const squad = readObject(entry, entryPath, ["id", "seats"], ["id", "seats"]);
      const id = readString(squad.id, `${entryPath}.id`, 1, 16, SQUAD_ID_PATTERN);
      if (ids.has(id)) invalid(`${entryPath}.id`, "squad ids must be unique");
      ids.add(id);
      const seatValues = readArray(squad.seats, `${entryPath}.seats`, 1, competitors);
      let previous = -1;
      const seats = seatValues.map((seatValue, seatIndex) => {
        const seat = readSafeInteger(seatValue, `${entryPath}.seats[${seatIndex}]`, 0, competitors - 1, seatValues, seatIndex);
        if (seat <= previous || assigned.has(seat)) {
          invalid(`${entryPath}.seats[${seatIndex}]`, "squad seats must be ascending and belong to one squad");
        }
        previous = seat;
        assigned.add(seat);
        return seat;
      });
      return { id, seats };
    });
    if (assigned.size !== competitors) invalid(`${path}.squads`, "squads must assign every competitor seat");
    return { kind, version: 1, squads };
  }
  if (kind === "uhc_duel") {
    readObject(value, path, ["kind", "version", "kit"], ["kind", "version", "kit"]);
    if (competitors !== 2) invalid("payload.roster", "uhc duel requires exactly two competitors");
    if (settings.match.respawn || settings.match.block_breaking || settings.match.block_placing
        || settings.match.natural_mobs || settings.match.natural_random_ticks) {
      invalid("payload.settings.match", "uhc duel uses the classic hunger games match rules");
    }
    return { kind, version: 1, kit: readUhcKit(header.kit, `${path}.kit`) };
  }
  return invalid(`${path}.kind`, "unknown rule mode");
}

function readUhcKit(value: StrictJsonValue | undefined, path: string): UhcDuelKit {
  const kit = readObject(value, path,
    ["armor", "sword", "arrows", "golden_apples", "food", "food_count", "shield"],
    ["armor", "sword", "arrows", "golden_apples", "food", "food_count"]);
  const armor = readString(kit.armor, `${path}.armor`, 1, 16);
  if (!UHC_ARMOR.has(armor)) invalid(`${path}.armor`, "unknown armor tier");
  const sword = readString(kit.sword, `${path}.sword`, 1, 16);
  if (!UHC_SWORDS.has(sword)) invalid(`${path}.sword`, "unknown sword material");
  const food = readString(kit.food, `${path}.food`, 1, 64);
  const foodStack = uhcFoodStackLimit(food);
  if (foodStack === undefined) invalid(`${path}.food`, "unknown food item");
  const shield = Object.hasOwn(kit, "shield") ? readBoolean(kit.shield, `${path}.shield`) : false;
  return {
    armor,
    sword,
    arrows: readSafeInteger(kit.arrows, `${path}.arrows`, 1, 64, kit, "arrows"),
    golden_apples: readSafeInteger(kit.golden_apples, `${path}.golden_apples`, 1, 64, kit, "golden_apples"),
    food,
    food_count: readSafeInteger(kit.food_count, `${path}.food_count`, 1, foodStack, kit, "food_count"),
    ...(shield ? { shield: true as const } : {})
  };
}

function readHungerGamesPrepareSettings(value: StrictJsonValue): HungerGamesPrepareSettings {
  const settings = readObject(value, "payload.settings", ["match", "border"], ["match", "border"]);
  const match = readMatchSettings(settings.match);
  const border = readBorderSettings(settings.border);
  if (match.grace_ticks >= match.authoritative_max_ticks) invalid("payload.settings.match.grace_ticks", "grace period must end before the tick limit");
  if (border.shrink_start_tick < match.grace_ticks) invalid("payload.settings.border.shrink_start_tick", "border shrink cannot begin before grace ends");
  if (border.shrink_end_tick <= border.shrink_start_tick
      || border.shrink_end_tick >= match.authoritative_max_ticks) {
    invalid("payload.settings.border.shrink_end_tick", "border schedule must end after it starts and before the tick limit");
  }
  return { match, border };
}

function readCivilizationPrepareSettings(value: StrictJsonValue): CivilizationPrepareSettings {
  const settings = readObject(value, "payload.settings",
    ["match", "border", "civilization"],
    ["match", "border", "civilization"]);
  const match = readMatchSettings(settings.match);
  if (match.grace_ticks !== 2400n || match.authoritative_max_ticks !== 18000n
      || match.respawn || !match.block_breaking || !match.block_placing) {
    invalid("payload.settings.match", "civilization requires its fixed match rules");
  }
  return {
    match,
    border: readFixedBorderSettings(settings.border),
    civilization: readCivilizationSettings(settings.civilization)
  };
}

function readCivilizationSettings(value: StrictJsonValue | undefined): CivilizationScenarioSettings {
  const path = "payload.settings.civilization";
  const civilization = readObject(value, path,
    ["factions", "starting_kit", "capture_zone", "blueprint"],
    ["factions", "starting_kit", "capture_zone", "blueprint"]);
  return {
    factions: readCivilizationFactions(civilization.factions),
    starting_kit: readCivilizationStartingKit(civilization.starting_kit),
    capture_zone: readCaptureZone(civilization.capture_zone),
    blueprint: readCivilizationBlueprint(civilization.blueprint)
  };
}

function readMatchSettings(value: StrictJsonValue | undefined): MatchSettings {
  const path = "payload.settings.match";
  const match = readObject(value, path,
    ["countdown_ticks", "grace_ticks", "authoritative_max_ticks", "respawn", "block_breaking", "block_placing", "natural_mobs", "natural_random_ticks"],
    ["countdown_ticks", "grace_ticks", "authoritative_max_ticks", "respawn", "block_breaking", "block_placing", "natural_mobs", "natural_random_ticks"]);
  const authoritativeMax = readU64(match.authoritative_max_ticks, `${path}.authoritative_max_ticks`, false);
  if (authoritativeMax === 0n) invalid(`${path}.authoritative_max_ticks`, "tick limit must be positive");
  return {
    countdown_ticks: readU64(match.countdown_ticks, `${path}.countdown_ticks`, false),
    grace_ticks: readU64(match.grace_ticks, `${path}.grace_ticks`, false),
    authoritative_max_ticks: authoritativeMax,
    respawn: readBoolean(match.respawn, `${path}.respawn`),
    block_breaking: readBoolean(match.block_breaking, `${path}.block_breaking`),
    block_placing: readBoolean(match.block_placing, `${path}.block_placing`),
    natural_mobs: readBoolean(match.natural_mobs, `${path}.natural_mobs`),
    natural_random_ticks: readBoolean(match.natural_random_ticks, `${path}.natural_random_ticks`)
  };
}

function readBorderSettings(value: StrictJsonValue | undefined): BorderSettings {
  const path = "payload.settings.border";
  const border = readObject(value, path,
    ["initial_diameter_blocks", "shrink_start_tick", "shrink_end_tick", "final_diameter_blocks"],
    ["initial_diameter_blocks", "shrink_start_tick", "shrink_end_tick", "final_diameter_blocks"]);
  const initial = readFiniteNumber(border.initial_diameter_blocks, `${path}.initial_diameter_blocks`);
  const final = readFiniteNumber(border.final_diameter_blocks, `${path}.final_diameter_blocks`);
  if (initial <= 0 || final <= 0 || final >= initial) invalid(path, "border diameters must be positive and final must be smaller than initial");
  return {
    initial_diameter_blocks: initial,
    shrink_start_tick: readU64(border.shrink_start_tick, `${path}.shrink_start_tick`, false),
    shrink_end_tick: readU64(border.shrink_end_tick, `${path}.shrink_end_tick`, false),
    final_diameter_blocks: final
  };
}

function readFixedBorderSettings(value: StrictJsonValue | undefined): FixedBorderSettings {
  const path = "payload.settings.border";
  const border = readObject(value, path, ["kind", "diameter_blocks"], ["kind", "diameter_blocks"]);
  if (readString(border.kind, `${path}.kind`, 1, 16) !== "fixed"
      || readSafeInteger(border.diameter_blocks, `${path}.diameter_blocks`, 192, 192, border, "diameter_blocks") !== 192) {
    invalid(path, "civilization requires a fixed 192-block border");
  }
  return { kind: "fixed", diameter_blocks: 192 };
}

function readCivilizationFactions(value: StrictJsonValue | undefined): CivilizationFactions {
  const path = "payload.settings.civilization.factions";
  const factions = readArray(value, path, 2, 2);
  const first = readObject(factions[0], `${path}[0]`, ["id", "members"], ["id", "members"]);
  const second = readObject(factions[1], `${path}[1]`, ["id", "members"], ["id", "members"]);
  if (readString(first.id, `${path}[0].id`, 1, 16) !== "ember"
      || readString(second.id, `${path}[1].id`, 1, 16) !== "tide") {
    invalid(path, "factions must be ordered ember then tide");
  }
  const emberMembers = readFactionMembers<EmberFaction["members"]>(first.members, `${path}[0].members`, 0);
  const tideMembers = readFactionMembers<TideFaction["members"]>(second.members, `${path}[1].members`, 3);
  return [
    { id: "ember", members: emberMembers },
    { id: "tide", members: tideMembers }
  ] as const;
}

function readFactionMembers<Members extends CivilizationFactions[number]["members"]>(
  value: StrictJsonValue | undefined,
  path: string,
  firstSeat: number
): Members {
  const members = readArray(value, path, 3, 3);
  const roles = ["gatherer_crafter", "builder", "defender_scout"] as const;
  return members.map((entry, index) => {
    const memberPath = `${path}[${index}]`;
    const member = readObject(entry, memberPath, ["seat", "role"], ["seat", "role"]);
    const seat = readSafeInteger(member.seat, `${memberPath}.seat`, firstSeat + index, firstSeat + index, member, "seat");
    const role = readString(member.role, `${memberPath}.role`, 1, 32);
    if (role !== roles[index]) invalid(`${memberPath}.role`, "faction roles must be ordered gatherer_crafter, builder, defender_scout");
    return { seat, role };
  }) as unknown as Members;
}

function readCivilizationStartingKit(value: StrictJsonValue | undefined): CivilizationStartingKit {
  const path = "payload.settings.civilization.starting_kit";
  const expected = [
    ["minecraft:bread", 4],
    ["minecraft:wooden_axe", 1],
    ["minecraft:wooden_pickaxe", 1],
    ["minecraft:wooden_sword", 1]
  ] as const;
  const entries = readArray(value, path, expected.length, expected.length);
  return entries.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const item = readObject(entry, entryPath, ["item", "count"], ["item", "count"]);
    if (readString(item.item, `${entryPath}.item`, 1, 128) !== expected[index]![0]
        || readSafeInteger(item.count, `${entryPath}.count`, expected[index]![1], expected[index]![1], item, "count") !== expected[index]![1]) {
      invalid(entryPath, "civilization starting kit differs from the canonical kit");
    }
    return { item: expected[index]![0], count: expected[index]![1] };
  }) as unknown as CivilizationStartingKit;
}

function readCaptureZone(value: StrictJsonValue | undefined): CaptureZone {
  const path = "payload.settings.civilization.capture_zone";
  const zone = readObject(value, path,
    ["min", "max", "uncontested_ticks", "score_points_per_tick"],
    ["min", "max", "uncontested_ticks", "score_points_per_tick"]);
  const minimum = readBlockPosition(zone.min, `${path}.min`);
  const maximum = readBlockPosition(zone.max, `${path}.max`);
  for (const axis of ["x", "y", "z"] as const) {
    if (minimum[axis] > maximum[axis]) invalid(path, "inclusive capture zone minimum must not exceed its maximum");
  }
  if (readSafeInteger(zone.uncontested_ticks, `${path}.uncontested_ticks`, 200, 200, zone, "uncontested_ticks") !== 200
      || readSafeInteger(zone.score_points_per_tick, `${path}.score_points_per_tick`, 1, 1, zone, "score_points_per_tick") !== 1) {
    invalid(path, "civilization capture requires 200 uncontested ticks and one point per owned end tick");
  }
  return {
    min: minimum,
    max: maximum,
    uncontested_ticks: 200,
    score_points_per_tick: 1
  };
}

function readBlockPosition(value: StrictJsonValue | undefined, path: string): BlockPosition {
  const position = readObject(value, path, ["x", "y", "z"], ["x", "y", "z"]);
  return {
    x: readSafeInteger(position.x, `${path}.x`, 0, Number.MAX_SAFE_INTEGER, position, "x"),
    y: readSafeInteger(position.y, `${path}.y`, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, position, "y"),
    z: readSafeInteger(position.z, `${path}.z`, 0, Number.MAX_SAFE_INTEGER, position, "z")
  };
}

function readCivilizationBlueprint(value: StrictJsonValue | undefined): CivilizationBlueprint {
  const path = "payload.settings.civilization.blueprint";
  const blueprint = readObject(value, path, ["id", "anchors"], ["id", "anchors"]);
  if (readString(blueprint.id, `${path}.id`, 1, 64) !== "oak-outpost-v1") {
    invalid(`${path}.id`, "blueprint identity is unsupported");
  }
  const anchors = readObject(blueprint.anchors, `${path}.anchors`, ["ember", "tide"], ["ember", "tide"]);
  return {
    id: "oak-outpost-v1",
    anchors: {
      ember: readBlueprintAnchor(anchors.ember, `${path}.anchors.ember`, 0),
      tide: readBlueprintAnchor(anchors.tide, `${path}.anchors.tide`, 180)
    }
  };
}

function readBlueprintAnchor(
  value: StrictJsonValue | undefined,
  path: string,
  rotation: 0
): { readonly position: BlockPosition; readonly rotation_degrees: 0 };
function readBlueprintAnchor(
  value: StrictJsonValue | undefined,
  path: string,
  rotation: 180
): { readonly position: BlockPosition; readonly rotation_degrees: 180 };
function readBlueprintAnchor(
  value: StrictJsonValue | undefined,
  path: string,
  rotation: 0 | 180
): { readonly position: BlockPosition; readonly rotation_degrees: 0 | 180 };
function readBlueprintAnchor(
  value: StrictJsonValue | undefined,
  path: string,
  rotation: 0 | 180
): { readonly position: BlockPosition; readonly rotation_degrees: 0 | 180 } {
  const anchor = readObject(value, path, ["position", "rotation_degrees"], ["position", "rotation_degrees"]);
  if (readSafeInteger(anchor.rotation_degrees, `${path}.rotation_degrees`, rotation, rotation, anchor, "rotation_degrees") !== rotation) {
    invalid(`${path}.rotation_degrees`, "anchor rotation does not match its faction");
  }
  return { position: readBlockPosition(anchor.position, `${path}.position`), rotation_degrees: rotation };
}

function readBotRoster(value: StrictJsonValue | undefined): readonly BotCompetitor[] {
  const entries = readArray(value, "payload.roster", 1, LEGACY_MAX_COMPETITORS);
  const participants = new Set<string>();
  const usernames = new Set<string>();
  const offlineUuids = new Set<string>();
  return entries.map((entry, index): BotCompetitor => {
    const path = `payload.roster[${index}]`;
    const member = readRosterObject(entry, path);
    const kind = readString(member.kind, `${path}.kind`, 1, 16);
    const seat = readSafeInteger(member.seat, `${path}.seat`, 0, LEGACY_MAX_COMPETITORS - 1, member, "seat");
    const participant = readParticipantId(member, path, participants);
    if (seat !== index) invalid(`${path}.seat`, "roster seats must be ordered and contiguous from zero");

    if (kind !== "bot") invalid(`${path}.kind`, "all roster members must be bots");
    const username = readString(member.username, `${path}.username`, 1, 16, /^[A-Za-z0-9_]+$/);
    const offlineUuid = readOfflineUuid(member, path);
    if (usernames.has(username) || offlineUuids.has(offlineUuid)) invalid(path, "bot usernames and offline UUIDs must be unique");
    usernames.add(username);
    offlineUuids.add(offlineUuid);
    return { kind, seat, participant_id: participant, username, offline_uuid: offlineUuid };
  });
}

function readGeneralizedRoster(value: StrictJsonValue | undefined): readonly RosterCompetitor[] {
  const entries = readArray(value, "payload.roster", 1, MAX_COMPETITORS);
  const participants = new Set<string>();
  const usernames = new Set<string>();
  const offlineUuids = new Set<string>();
  return entries.map((entry, index): RosterCompetitor => {
    const path = `payload.roster[${index}]`;
    const member = readRosterObject(entry, path);
    const kind = readString(member.kind, `${path}.kind`, 1, 16);
    const seat = readSafeInteger(member.seat, `${path}.seat`, 0, MAX_SEAT, member, "seat");
    const participant = readParticipantId(member, path, participants);
    if (seat !== index) invalid(`${path}.seat`, "roster seats must be ordered and contiguous from zero");
    if (kind !== "bot" && kind !== "external") invalid(`${path}.kind`, "roster controller kind must be bot or external");
    const username = readString(member.username, `${path}.username`, 1, 16, /^[A-Za-z0-9_]+$/);
    if (kind === "external"
        && (!EXTERNAL_USERNAME_PATTERN.test(username) || RESERVED_RUNNER_USERNAME.test(username))) {
      invalid(`${path}.username`, "external usernames must be 3 to 16 characters outside the runner identity space");
    }
    const offlineUuid = readOfflineUuid(member, path);
    if (offlineUuid !== minecraftOfflineUuid(username)) {
      invalid(`${path}.offline_uuid`, "offline UUID must derive from the username");
    }
    const folded = username.toLowerCase();
    if (usernames.has(folded) || offlineUuids.has(offlineUuid)) {
      invalid(path, "roster usernames and offline UUIDs must be unique ignoring case");
    }
    usernames.add(folded);
    offlineUuids.add(offlineUuid);
    return { kind, seat, participant_id: participant, username, offline_uuid: offlineUuid };
  });
}

function readRosterObject(entry: StrictJsonValue | undefined, path: string) {
  return readObject(entry, path,
    ["kind", "seat", "participant_id", "username", "offline_uuid"],
    ["kind", "seat", "participant_id", "username", "offline_uuid"]);
}

function readParticipantId(member: StrictJsonObject, path: string, seen: Set<string>): string {
  const participant = readString(member.participant_id, `${path}.participant_id`, 1, 128, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  if (seen.has(participant)) invalid(`${path}.participant_id`, "participant ids must be unique");
  seen.add(participant);
  return participant;
}

function readOfflineUuid(member: StrictJsonObject, path: string): string {
  return readString(member.offline_uuid, `${path}.offline_uuid`, 36, 36,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
}

function minecraftOfflineUuid(username: string): string {
  const bytes = createHash("md5").update(`OfflinePlayer:${username}`, "utf8").digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x30;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readAbort(value: StrictJsonValue): { readonly reason: AbortReason } {
  const payload = readObject(value, "payload", ["reason"], ["reason"]);
  return { reason: readAbortReason(payload.reason, "payload.reason") };
}

function readClock(value: StrictJsonValue): ClockPayload {
  const payload = readObject(value, "payload", ["phase", "tick", "border_diameter_blocks"], ["phase", "tick", "border_diameter_blocks"]);
  const phase = readString(payload.phase, "payload.phase", 1, 32);
  if (!PHASES.has(phase)) invalid("payload.phase", "unknown public phase");
  const tick = payload.tick === null ? null : readTick(payload.tick, "payload.tick");
  if ((phase === "waiting" && tick !== null)
      || (phase === "countdown" && tick?.domain !== "countdown")
      || ((phase === "grace" || phase === "active") && tick?.domain !== "match")
      || (phase === "finished" && tick === null)) {
    invalid("payload.tick", "tick domain does not match the public phase");
  }
  const border = readFiniteNumber(payload.border_diameter_blocks, "payload.border_diameter_blocks");
  if (border <= 0) invalid("payload.border_diameter_blocks", "border diameter must be positive");
  return { phase: phase as ClockPayload["phase"], tick, border_diameter_blocks: border };
}

function readPublicState(value: StrictJsonValue): PublicStatePayload {
  const payload = readObject(value, "payload", ["at", "alive_seats"], ["at", "alive_seats"]);
  return {
    at: readTick(payload.at, "payload.at"),
    alive_seats: readSeatList(payload.alive_seats, "payload.alive_seats")
  };
}

function readElimination(value: StrictJsonValue): EliminationPayload {
  const payload = readObject(value, "payload", ["at", "eliminations"], ["at", "eliminations"]);
  const events = readArray(payload.eliminations, "payload.eliminations", 1, MAX_COMPETITORS);
  let previousSeat = -1;
  const eliminations = events.map((entry, index) => {
    const path = `payload.eliminations[${index}]`;
    const elimination = readObject(entry, path, ["seat", "cause"], ["seat", "cause"]);
    const seat = readSafeInteger(elimination.seat, `${path}.seat`, 0, MAX_SEAT, elimination, "seat");
    if (seat <= previousSeat) invalid(`${path}.seat`, "eliminations must be ordered by unique seat");
    previousSeat = seat;
    const cause = readEliminationCause(elimination.cause, `${path}.cause`);
    return { seat, cause };
  });
  return { at: readTick(payload.at, "payload.at"), eliminations };
}

function readCivilizationState(value: StrictJsonValue): CivilizationStatePayload {
  const payload = readObject(value, "payload",
    ["at", "occupants", "owner_faction", "challenger_faction", "capture_progress_ticks", "scores"],
    ["at", "occupants", "owner_faction", "challenger_faction", "capture_progress_ticks", "scores"]);
  const at = readTick(payload.at, "payload.at");
  if (at.domain !== "match") invalid("payload.at.domain", "civilization state requires a match tick");
  const owner = readFactionId(payload.owner_faction, "payload.owner_faction", true);
  const challenger = readFactionId(payload.challenger_faction, "payload.challenger_faction", true);
  if (owner !== null && owner === challenger) {
    invalid("payload.challenger_faction", "challenger must differ from the current owner");
  }
  return {
    at,
    occupants: readSeatList(payload.occupants, "payload.occupants"),
    owner_faction: owner,
    challenger_faction: challenger,
    capture_progress_ticks: readU64(payload.capture_progress_ticks, "payload.capture_progress_ticks", false),
    scores: readFactionScores(payload.scores, "payload.scores")
  };
}

function readOutcome(value: StrictJsonValue): OutcomePayload {
  const payload = readObject(value, "payload",
    ["kind", "winner_seat", "winner_faction_id", "reason", "scores", "survivors", "at"],
    ["kind", "survivors", "at"]);
  const kind = readString(payload.kind, "payload.kind", 1, 16);
  const survivors = readSeatList(payload.survivors, "payload.survivors");
  const at = payload.at === null ? null : readTick(payload.at, "payload.at");
  if (kind === "winner") {
    requireExactKeys(payload, "payload", ["kind", "winner_seat", "survivors", "at"]);
    if (at === null) {
      invalid("payload", "winner outcome requires a winner seat and authoritative tick only");
    }
    const winnerSeat = readSafeInteger(payload.winner_seat, "payload.winner_seat", 0, MAX_SEAT, payload, "winner_seat");
    if (survivors.length !== 1 || survivors[0] !== winnerSeat) invalid("payload.survivors", "winner must be the sole survivor");
    return { kind, winner_seat: winnerSeat, survivors: [winnerSeat], at };
  }
  if (kind === "faction_winner") {
    requireExactKeys(payload, "payload", ["kind", "winner_faction_id", "reason", "scores", "survivors", "at"]);
    if (at === null || at.domain !== "match") invalid("payload.at", "faction winner requires an authoritative match tick");
    const winner = readFactionId(payload.winner_faction_id, "payload.winner_faction_id", false)!;
    const reason = readString(payload.reason, "payload.reason", 1, 32);
    if (reason !== "elimination" && reason !== "tick_limit") {
      invalid("payload.reason", "faction winner reason must be elimination or tick_limit");
    }
    const scores = readFactionScores(payload.scores, "payload.scores");
    const winnerPoints = scores[winner === "ember" ? 0 : 1].points;
    const loserPoints = scores[winner === "ember" ? 1 : 0].points;
    if (reason === "tick_limit" && winnerPoints <= loserPoints) {
      invalid("payload.scores", "tick-limit winner must have strictly more points");
    }
    if (reason === "elimination"
        && (survivors.length === 0 || survivors.some((seat) => factionForSeat(seat) !== winner))) {
      invalid("payload.survivors", "elimination winner survivors must belong to the winning faction");
    }
    if (reason === "tick_limit"
        && (!survivors.some((seat) => factionForSeat(seat) === "ember")
          || !survivors.some((seat) => factionForSeat(seat) === "tide"))) {
      invalid("payload.survivors", "tick-limit outcome requires a survivor from each faction");
    }
    return { kind, winner_faction_id: winner, reason, scores, survivors, at };
  }
  if (kind === "draw") {
    if (at === null) invalid("payload.at", "draw outcome requires an authoritative tick");
    const reason = readString(payload.reason, "payload.reason", 1, 32);
    if (reason !== "no_survivors" && reason !== "tick_limit") invalid("payload.reason", "unknown draw reason");
    if (Object.hasOwn(payload, "scores")) {
      requireExactKeys(payload, "payload", ["kind", "reason", "scores", "survivors", "at"]);
      if (at.domain !== "match") invalid("payload.at", "civilization draw requires an authoritative match tick");
      const scores = readFactionScores(payload.scores, "payload.scores");
      if ((reason === "no_survivors" && survivors.length !== 0)
          || (reason === "tick_limit" && (survivors.length < 2
            || !survivors.some((seat) => factionForSeat(seat) === "ember")
            || !survivors.some((seat) => factionForSeat(seat) === "tide")))) {
        invalid("payload.survivors", "civilization draw survivors do not match the draw reason");
      }
      if (reason === "tick_limit" && scores[0].points !== scores[1].points) {
        invalid("payload.scores", "tick-limit draw requires equal faction scores");
      }
      return { kind, reason, survivors, at, scores } satisfies CivilizationDrawOutcome;
    }
    requireExactKeys(payload, "payload", ["kind", "reason", "survivors", "at"]);
    if ((reason === "no_survivors" && survivors.length !== 0)
        || (reason === "tick_limit" && survivors.length < 2)) {
      invalid("payload.survivors", "draw survivors do not match the draw reason");
    }
    return { kind, reason, survivors, at } satisfies HungerGamesDrawOutcome;
  }
  if (kind === "abort") {
    requireExactKeys(payload, "payload", ["kind", "reason", "survivors", "at"]);
    return { kind, reason: readAbortReason(payload.reason, "payload.reason"), survivors, at };
  }
  return invalid("payload.kind", "outcome kind must be winner, faction_winner, draw, or abort");
}

function readFactionScores(value: StrictJsonValue | undefined, path: string): FactionScores {
  const entries = readArray(value, path, 2, 2);
  const first = readObject(entries[0], `${path}[0]`, ["faction_id", "points"], ["faction_id", "points"]);
  const second = readObject(entries[1], `${path}[1]`, ["faction_id", "points"], ["faction_id", "points"]);
  if (readFactionId(first.faction_id, `${path}[0].faction_id`, false) !== "ember"
      || readFactionId(second.faction_id, `${path}[1].faction_id`, false) !== "tide") {
    invalid(path, "faction scores must be ordered ember then tide");
  }
  return [
    { faction_id: "ember", points: readU64(first.points, `${path}[0].points`, false) },
    { faction_id: "tide", points: readU64(second.points, `${path}[1].points`, false) }
  ] as const;
}

function readFactionId(value: StrictJsonValue | undefined, path: string, nullable: true): FactionId | null;
function readFactionId(value: StrictJsonValue | undefined, path: string, nullable: false): FactionId;
function readFactionId(value: StrictJsonValue | undefined, path: string, nullable: boolean): FactionId | null {
  if (nullable && value === null) return null;
  const faction = readString(value, path, 1, 16);
  if (faction !== "ember" && faction !== "tide") invalid(path, "unknown faction id");
  return faction;
}

function factionForSeat(seat: number): FactionId {
  if (seat >= CIVILIZATION_SEAT_COUNT) invalid("payload.survivors", "civilization seats range from 0 through 5");
  return seat < 3 ? "ember" : "tide";
}

function requireExactKeys(value: StrictJsonObject, path: string, expected: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    invalid(path, "fields do not match the selected outcome variant");
  }
}

function readMetrics(value: StrictJsonValue): MetricsPayload {
  const payload = readObject(value, "payload",
    ["server_tick_duration_micros", "critical_queue_depth", "dropped_optional_metrics", "tick_durations_micros"],
    ["server_tick_duration_micros", "critical_queue_depth", "dropped_optional_metrics"]);
  const base = {
    server_tick_duration_micros: readSafeInteger(payload.server_tick_duration_micros, "payload.server_tick_duration_micros", 0, Number.MAX_SAFE_INTEGER, payload, "server_tick_duration_micros"),
    critical_queue_depth: readSafeInteger(payload.critical_queue_depth, "payload.critical_queue_depth", 0, Number.MAX_SAFE_INTEGER, payload, "critical_queue_depth"),
    dropped_optional_metrics: readSafeInteger(payload.dropped_optional_metrics, "payload.dropped_optional_metrics", 0, Number.MAX_SAFE_INTEGER, payload, "dropped_optional_metrics")
  };
  if (!Object.hasOwn(payload, "tick_durations_micros")) return base;
  const samples = readArray(payload.tick_durations_micros, "payload.tick_durations_micros", 1, 20);
  return {
    ...base,
    tick_durations_micros: samples.map((sample, index) =>
      readSafeInteger(sample, `payload.tick_durations_micros[${index}]`, 0, Number.MAX_SAFE_INTEGER, samples, index))
  };
}

function readError(value: StrictJsonValue): { readonly code: ControlErrorCode; readonly message: string } {
  const payload = readObject(value, "payload", ["code", "message"], ["code", "message"]);
  const code = readString(payload.code, "payload.code", 1, 64);
  const codes = new Set<ControlErrorCode>([
    "authentication_failed", "unsupported_capability", "invalid_command", "invalid_state", "invalid_world", "internal"
  ]);
  if (!codes.has(code as ControlErrorCode)) invalid("payload.code", "unknown control error code");
  return { code: code as ControlErrorCode, message: readString(payload.message, "payload.message", 1, 1024) };
}

function readTick(value: StrictJsonValue | undefined, path: string): AuthoritativeTick {
  const tick = readObject(value, path, ["domain", "value"], ["domain", "value"]);
  const domain = readString(tick.domain, `${path}.domain`, 1, 16);
  if (domain !== "countdown" && domain !== "match") invalid(`${path}.domain`, "tick domain must be countdown or match");
  return { domain, value: readU64(tick.value, `${path}.value`, false) };
}

function readSeatList(value: StrictJsonValue | undefined, path: string): readonly number[] {
  const values = readArray(value, path, 0, MAX_COMPETITORS);
  let previous = -1;
  return values.map((entry, index) => {
    const seat = readSafeInteger(entry, `${path}[${index}]`, 0, MAX_SEAT, values, index);
    if (seat <= previous) invalid(`${path}[${index}]`, "seats must be ordered and unique");
    previous = seat;
    return seat;
  });
}

function readAbortReason(value: StrictJsonValue | undefined, path: string): AbortReason {
  const reason = readString(value, path, 1, 64);
  if (!ABORT_REASONS.has(reason as AbortReason)) invalid(path, "unknown abort reason");
  return reason as AbortReason;
}

function readEliminationCause(value: StrictJsonValue | undefined, path: string): "death" | "disconnect" {
  const cause = readString(value, path, 1, 32);
  if (cause === "death" || cause === "disconnect") return cause;
  return invalid(path, "unknown elimination cause");
}

function readEmpty(value: StrictJsonValue, path: string): Record<string, never> {
  readObject(value, path, [], []);
  return {};
}

export function readObject<const Keys extends readonly string[]>(
  value: StrictJsonValue | undefined,
  path: string,
  allowed: readonly string[],
  required: Keys
): RequiredObject<Keys> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path, "must be an object");
  const object = value as { readonly [key: string]: StrictJsonValue };
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) invalid(`${path}.${key}`, "unknown field");
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) invalid(`${path}.${key}`, "required field is missing");
  }
  return object as RequiredObject<Keys>;
}

export function readArray(value: StrictJsonValue | undefined, path: string, minLength: number, maxLength: number): readonly StrictJsonValue[] {
  if (!Array.isArray(value) || value.length < minLength || value.length > maxLength) {
    invalid(path, `must be an array with ${minLength} to ${maxLength} entries`);
  }
  return value;
}

export function readString(
  value: StrictJsonValue | undefined,
  path: string,
  minLength: number,
  maxLength: number,
  pattern?: RegExp
): string {
  if (typeof value !== "string" || Array.from(value).length < minLength || Array.from(value).length > maxLength || (pattern && !matchesPattern(value, pattern))) {
    invalid(path, "must be a string with the required length and format");
  }
  return value;
}

export function readBoolean(value: StrictJsonValue | undefined, path: string): boolean {
  if (typeof value !== "boolean") invalid(path, "must be a boolean");
  return value;
}

export function readSafeInteger(
  value: StrictJsonValue | undefined,
  path: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  owner?: object,
  key?: string | number
): number {
  const token = owner === undefined || key === undefined ? undefined : strictJsonNumberToken(owner, key);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || (token !== undefined && !isIntegerNumberToken(token))
      || value < min || value > max) {
    invalid(path, "must be a safe integer in range");
  }
  return value;
}

function isIntegerNumberToken(token: string): boolean {
  const match = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) return false;
  const fraction = match[2] ?? "";
  const exponent = match[3] === undefined ? 0 : Number(match[3]);
  const decimalPlaces = fraction.length - exponent;
  if (decimalPlaces <= 0) return true;
  const digits = `${match[1]}${fraction}`;
  if (decimalPlaces >= digits.length) return /^0+$/.test(digits);
  return new RegExp(`0{${decimalPlaces}}$`).test(digits);
}

export function readFiniteNumber(value: StrictJsonValue | undefined, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(path, "must be a finite number");
  return value;
}

export function readU64(value: StrictJsonValue | undefined, path: string, positive: boolean): bigint {
  if (typeof value !== "string" || value.length > 20
      || !matchesPattern(value, positive ? POSITIVE_U64_DECIMAL : U64_DECIMAL)) {
    invalid(path, positive ? "must be a positive canonical u64 decimal string" : "must be a canonical u64 decimal string");
  }
  const parsed = BigInt(value);
  if (parsed > MAX_U64) invalid(path, "exceeds the u64 range");
  return parsed;
}

function requireCorrelation(value: bigint | undefined, type: string): void {
  if (value === undefined) invalid("correlation", `${type} requires a response correlation`);
}

function matchesPattern(value: string, pattern: RegExp): boolean {
  const match = pattern.exec(value);
  return match !== null && match[0] === value;
}

function toStrictJsonValue(value: unknown, seen: Set<object>): StrictJsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!isWellFormedUnicode(value)) throw new ControlCodecError("invalid_message", "control message contains an unpaired surrogate");
    return value;
  }
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new ControlCodecError("invalid_message", "control message contains an unsafe number");
    }
    return value;
  }
  if (typeof value !== "object") throw new ControlCodecError("invalid_message", "control message contains a non-JSON value");
  if (seen.has(value)) throw new ControlCodecError("invalid_message", "control message contains a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: StrictJsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) throw new ControlCodecError("invalid_message", "control array contains a hole");
        entries.push(toStrictJsonValue(value[index], seen));
      }
      if (Object.keys(value).length !== value.length) throw new ControlCodecError("invalid_message", "control array has extra properties");
      return entries;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ControlCodecError("invalid_message", "control message contains a non-plain object");
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new ControlCodecError("invalid_message", "control message contains symbol fields");
    }
    const result: { [key: string]: StrictJsonValue } = Object.create(null) as { [key: string]: StrictJsonValue };
    for (const key of Object.getOwnPropertyNames(value)) {
      if (!isWellFormedUnicode(key)) throw new ControlCodecError("invalid_message", "control message contains an unpaired surrogate key");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new ControlCodecError("invalid_message", "control message contains a hidden or accessor field");
      }
      result[key] = toStrictJsonValue(descriptor.value, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sortObjectKeys(value: StrictJsonValue): StrictJsonValue {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (isStrictJsonObject(value)) {
    const sorted: { [key: string]: StrictJsonValue } = Object.create(null) as { [key: string]: StrictJsonValue };
    for (const key of Object.keys(value).sort()) sorted[key] = sortObjectKeys(value[key]!);
    return sorted;
  }
  return value;
}

function isStrictJsonObject(value: StrictJsonValue): value is StrictJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function invalid(path: string, message: string): never {
  throw new ControlCodecError("invalid_message", message, path);
}
