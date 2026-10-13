import { parseStrictJson, StrictJsonError, type StrictJsonValue } from "./strict-json.js";
import type {
  AbortReason,
  AuthoritativeTick,
  BorderSettings,
  BuildProgressPayload,
  ClockPayload,
  Competitor,
  ControlCapability,
  ControlErrorCode,
  ControlMessage,
  EliminationPayload,
  HelloPayload,
  MatchSettings,
  MetricsPayload,
  OutcomePayload,
  PreparePayload,
  PublicStatePayload,
  ReadyPayload
} from "./types.js";

export const MAX_CONTROL_FRAME_BYTES = 1_048_576;

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
    return readEnvelope(parseStrictJson(input));
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

  constructor(
    private readonly runId: string,
    private readonly expectedToken: string,
    private readonly supportedCapabilities: readonly ControlCapability[]
  ) {
    if (!matchesPattern(runId, RUN_ID) || expectedToken.length === 0) {
      throw new ControlCodecError("invalid_handshake", "control receiver requires a valid run id and token");
    }
    const supported = new Set(supportedCapabilities);
    if (supported.size !== supportedCapabilities.length || !supported.has("hunger_games_v1")
        || supportedCapabilities.some((capability) => !CAPABILITIES.has(capability))) {
      throw new ControlCodecError("invalid_handshake", "control receiver capability set is invalid");
    }
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

    this.lastSequence = message.sequence;
    if (this.handshake === "complete" && message.type === "outcome") this.handshake = "terminal";
    return message;
  }

  private acceptHello(payload: HelloPayload): void {
    if (payload.token !== this.expectedToken) {
      throw new ControlCodecError("authentication_failed", "plugin control token is invalid");
    }
    const supported = new Set(this.supportedCapabilities);
    for (const capability of payload.capabilities) {
      if (!supported.has(capability)) {
        throw new ControlCodecError("unsupported_capability", "plugin announced an unsupported capability");
      }
    }
    if (!payload.capabilities.includes("hunger_games_v1")) {
      throw new ControlCodecError("unsupported_capability", "plugin does not support Hunger Games control");
    }
    this.helloCapabilities = payload.capabilities;
  }
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CAPABILITIES = new Set<ControlCapability>(["hunger_games_v1", "dynamic_human_seat_v1"]);
const ABORT_REASONS = new Set<AbortReason>([
  "operator", "lease_lost", "invalid_world", "protocol_error", "human_wait_timeout", "runtime_timeout"
]);
const PHASES = new Set(["waiting", "countdown", "grace", "active", "finished", "aborted"]);

function isPluginEvent(message: ControlMessage): boolean {
  return message.type === "heartbeat" || message.type === "build_progress" || message.type === "public_clock"
    || message.type === "public_state" || message.type === "elimination" || message.type === "outcome"
    || message.type === "metrics" || message.type === "ack" || message.type === "error";
}

function readEnvelope(value: StrictJsonValue): ControlMessage {
  const envelope = readObject(value, "envelope", ["protocol", "run_id", "sequence", "correlation", "type", "payload"],
    ["protocol", "run_id", "sequence", "type", "payload"]);
  if (readSafeInteger(envelope.protocol, "protocol") !== 1) {
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
    case "abort":
      return { ...fields, type, payload: readAbort(payload) };
    case "public_clock":
      return { ...fields, type, payload: readClock(payload) };
    case "public_state":
      return { ...fields, type, payload: readPublicState(payload) };
    case "elimination":
      return { ...fields, type, payload: readElimination(payload) };
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
      protocol_version: readSafeInteger(server.protocol_version, "payload.server.protocol_version", 0, 2_147_483_647)
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
  const completed = readSafeInteger(payload.completed, "payload.completed", 0);
  const total = readSafeInteger(payload.total, "payload.total", 0);
  if (completed > total) invalid("payload.completed", "completed cannot exceed total");
  return { stage, completed, total };
}

function readPrepare(value: StrictJsonValue): PreparePayload {
  const payload = readObject(value, "payload", ["map_semantic_id", "scenario_semantic_id", "seed", "mode", "settings", "roster"],
    ["map_semantic_id", "scenario_semantic_id", "seed", "mode", "settings", "roster"]);
  const mode = readString(payload.mode, "payload.mode", 1, 64);
  if (mode !== "hunger_games") invalid("payload.mode", "mode is unsupported by control-v1");
  const settings = readObject(payload.settings, "payload.settings", ["match", "border"], ["match", "border"]);
  const match = readMatchSettings(settings.match);
  const border = readBorderSettings(settings.border);
  if (match.grace_ticks >= match.authoritative_max_ticks) invalid("payload.settings.match.grace_ticks", "grace period must end before the tick limit");
  if (border.shrink_start_tick < match.grace_ticks) invalid("payload.settings.border.shrink_start_tick", "border shrink cannot begin before grace ends");
  if (border.shrink_end_tick <= border.shrink_start_tick
      || border.shrink_end_tick >= match.authoritative_max_ticks) {
    invalid("payload.settings.border.shrink_end_tick", "border schedule must end after it starts and before the tick limit");
  }
  const roster = readRoster(payload.roster);
  return {
    map_semantic_id: readString(payload.map_semantic_id, "payload.map_semantic_id", 64, 64, /^[0-9a-f]{64}$/),
    scenario_semantic_id: readString(payload.scenario_semantic_id, "payload.scenario_semantic_id", 64, 64, /^[0-9a-f]{64}$/),
    seed: readU64(payload.seed, "payload.seed", false),
    mode,
    settings: { match, border },
    roster
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

function readRoster(value: StrictJsonValue | undefined): readonly Competitor[] {
  const entries = readArray(value, "payload.roster", 1, 6);
  const participants = new Set<string>();
  const usernames = new Set<string>();
  const offlineUuids = new Set<string>();
  let humans = 0;
  const roster = entries.map((entry, index): Competitor => {
    const path = `payload.roster[${index}]`;
    const member = readObject(entry, path,
      ["kind", "seat", "participant_id", "username", "offline_uuid"],
      ["kind", "seat", "participant_id"]);
    const kind = readString(member.kind, `${path}.kind`, 1, 16);
    const seat = readSafeInteger(member.seat, `${path}.seat`, 0, 5);
    const participant = readString(member.participant_id, `${path}.participant_id`, 1, 128, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    if (participants.has(participant)) invalid(`${path}.participant_id`, "participant ids must be unique");
    participants.add(participant);
    if (seat !== index) invalid(`${path}.seat`, "roster seats must be ordered and contiguous from zero");

    if (kind === "human") {
      if (Object.hasOwn(member, "username") || Object.hasOwn(member, "offline_uuid") || seat !== 0 || humans !== 0) {
        invalid(path, "human roster entry must reserve unique seat zero without a bound game identity");
      }
      humans++;
      return { kind, seat: 0, participant_id: participant };
    }
    if (kind !== "bot") invalid(`${path}.kind`, "roster member kind must be bot or human");
    const username = readString(member.username, `${path}.username`, 1, 16, /^[A-Za-z0-9_]+$/);
    const offlineUuid = readString(member.offline_uuid, `${path}.offline_uuid`, 36, 36,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    if (usernames.has(username) || offlineUuids.has(offlineUuid)) invalid(path, "bot usernames and offline UUIDs must be unique");
    usernames.add(username);
    offlineUuids.add(offlineUuid);
    return { kind, seat, participant_id: participant, username, offline_uuid: offlineUuid };
  });
  return roster;
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
  const events = readArray(payload.eliminations, "payload.eliminations", 1, 6);
  let previousSeat = -1;
  const eliminations = events.map((entry, index) => {
    const path = `payload.eliminations[${index}]`;
    const elimination = readObject(entry, path, ["seat", "cause"], ["seat", "cause"]);
    const seat = readSafeInteger(elimination.seat, `${path}.seat`, 0, 5);
    if (seat <= previousSeat) invalid(`${path}.seat`, "eliminations must be ordered by unique seat");
    previousSeat = seat;
    const cause = readString(elimination.cause, `${path}.cause`, 1, 32);
    if (cause !== "death" && cause !== "disconnect") invalid(`${path}.cause`, "unknown elimination cause");
    return { seat, cause };
  });
  return { at: readTick(payload.at, "payload.at"), eliminations };
}

function readOutcome(value: StrictJsonValue): OutcomePayload {
  const payload = readObject(value, "payload", ["kind", "winner_seat", "reason", "survivors", "at"],
    ["kind", "survivors", "at"]);
  const kind = readString(payload.kind, "payload.kind", 1, 16);
  const survivors = readSeatList(payload.survivors, "payload.survivors");
  const at = payload.at === null ? null : readTick(payload.at, "payload.at");
  if (kind === "winner") {
    if (!Object.hasOwn(payload, "winner_seat") || Object.hasOwn(payload, "reason") || at === null) {
      invalid("payload", "winner outcome requires a winner seat and authoritative tick only");
    }
    const winnerSeat = readSafeInteger(payload.winner_seat, "payload.winner_seat", 0, 5);
    if (survivors.length !== 1 || survivors[0] !== winnerSeat) invalid("payload.survivors", "winner must be the sole survivor");
    return { kind, winner_seat: winnerSeat, survivors: [winnerSeat], at };
  }
  if (kind === "draw") {
    if (!Object.hasOwn(payload, "reason") || Object.hasOwn(payload, "winner_seat") || at === null) {
      invalid("payload", "draw outcome requires a reason and authoritative tick only");
    }
    const reason = readString(payload.reason, "payload.reason", 1, 32);
    if (reason !== "no_survivors" && reason !== "tick_limit") invalid("payload.reason", "unknown draw reason");
    if ((reason === "no_survivors" && survivors.length !== 0)
        || (reason === "tick_limit" && survivors.length < 2)) {
      invalid("payload.survivors", "draw survivors do not match the draw reason");
    }
    return { kind, reason, survivors, at };
  }
  if (kind === "abort") {
    if (!Object.hasOwn(payload, "reason") || Object.hasOwn(payload, "winner_seat")) {
      invalid("payload", "abort outcome requires a reason and no winner seat");
    }
    return { kind, reason: readAbortReason(payload.reason, "payload.reason"), survivors, at };
  }
  return invalid("payload.kind", "outcome kind must be winner, draw, or abort");
}

function readMetrics(value: StrictJsonValue): MetricsPayload {
  const payload = readObject(value, "payload",
    ["server_tick_duration_micros", "critical_queue_depth", "dropped_optional_metrics"],
    ["server_tick_duration_micros", "critical_queue_depth", "dropped_optional_metrics"]);
  return {
    server_tick_duration_micros: readSafeInteger(payload.server_tick_duration_micros, "payload.server_tick_duration_micros", 0),
    critical_queue_depth: readSafeInteger(payload.critical_queue_depth, "payload.critical_queue_depth", 0),
    dropped_optional_metrics: readSafeInteger(payload.dropped_optional_metrics, "payload.dropped_optional_metrics", 0)
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
  const values = readArray(value, path, 0, 6);
  let previous = -1;
  return values.map((entry, index) => {
    const seat = readSafeInteger(entry, `${path}[${index}]`, 0, 5);
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

function readEmpty(value: StrictJsonValue, path: string): Record<string, never> {
  const object = readObject(value, path, [], []);
  return object as Record<string, never>;
}

function readObject(
  value: StrictJsonValue | undefined,
  path: string,
  allowed: readonly string[],
  required: readonly string[]
): { readonly [key: string]: StrictJsonValue } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path, "must be an object");
  const object = value as { readonly [key: string]: StrictJsonValue };
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) invalid(`${path}.${key}`, "unknown field");
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) invalid(`${path}.${key}`, "required field is missing");
  }
  return object;
}

function readArray(value: StrictJsonValue | undefined, path: string, minLength: number, maxLength: number): readonly StrictJsonValue[] {
  if (!Array.isArray(value) || value.length < minLength || value.length > maxLength) {
    invalid(path, `must be an array with ${minLength} to ${maxLength} entries`);
  }
  return value;
}

function readString(
  value: StrictJsonValue | undefined,
  path: string,
  minLength: number,
  maxLength: number,
  pattern?: RegExp
): string {
  if (typeof value !== "string" || value.length < minLength || value.length > maxLength || (pattern && !matchesPattern(value, pattern))) {
    invalid(path, "must be a string with the required length and format");
  }
  return value;
}

function readBoolean(value: StrictJsonValue | undefined, path: string): boolean {
  if (typeof value !== "boolean") invalid(path, "must be a boolean");
  return value;
}

function readSafeInteger(value: StrictJsonValue | undefined, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(path, "must be a safe integer in range");
  }
  return value;
}

function readFiniteNumber(value: StrictJsonValue | undefined, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(path, "must be a finite number");
  return value;
}

function readU64(value: StrictJsonValue | undefined, path: string, positive: boolean): bigint {
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
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
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

function sortObjectKeys(value: StrictJsonValue): StrictJsonValue {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value !== null && typeof value === "object") {
    const sorted: { [key: string]: StrictJsonValue } = Object.create(null) as { [key: string]: StrictJsonValue };
    for (const key of Object.keys(value).sort()) sorted[key] = sortObjectKeys(value[key]!);
    return sorted;
  }
  return value;
}

function invalid(path: string, message: string): never {
  throw new ControlCodecError("invalid_message", message, path);
}
