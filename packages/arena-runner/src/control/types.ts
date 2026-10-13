export type ControlCapability = "hunger_games_v1" | "dynamic_human_seat_v1";

export type AuthoritativeTick =
  | { readonly domain: "countdown"; readonly value: bigint }
  | { readonly domain: "match"; readonly value: bigint };

export interface ControlEnvelopeFields {
  readonly protocol: 1;
  readonly run_id: string;
  readonly sequence: bigint;
  readonly correlation?: bigint;
}

export interface HelloPayload {
  readonly token: string;
  readonly capabilities: readonly ControlCapability[];
}

export interface ReadyPayload {
  readonly server: {
    readonly name: string;
    readonly version: string;
    readonly minecraft_version: string;
    readonly protocol_version: number;
  };
  readonly plugin: {
    readonly name: string;
    readonly version: string;
  };
  readonly capabilities: readonly ControlCapability[];
}

export interface BuildProgressPayload {
  readonly stage: "validating" | "preparing_world" | "snapshotting";
  readonly completed: number;
  readonly total: number;
}

export type Competitor =
  | {
      readonly kind: "bot";
      readonly seat: number;
      readonly participant_id: string;
      readonly username: string;
      readonly offline_uuid: string;
    }
  | {
      readonly kind: "human";
      readonly seat: 0;
      readonly participant_id: string;
    };

export interface MatchSettings {
  readonly countdown_ticks: bigint;
  readonly grace_ticks: bigint;
  readonly authoritative_max_ticks: bigint;
  readonly respawn: boolean;
  readonly block_breaking: boolean;
  readonly block_placing: boolean;
  readonly natural_mobs: boolean;
  readonly natural_random_ticks: boolean;
}

export interface BorderSettings {
  readonly initial_diameter_blocks: number;
  readonly shrink_start_tick: bigint;
  readonly shrink_end_tick: bigint;
  readonly final_diameter_blocks: number;
}

export interface PreparePayload {
  readonly map_semantic_id: string;
  readonly scenario_semantic_id: string;
  readonly seed: bigint;
  readonly mode: "hunger_games";
  readonly settings: {
    readonly match: MatchSettings;
    readonly border: BorderSettings;
  };
  readonly roster: readonly Competitor[];
}

export type AbortReason =
  | "operator"
  | "lease_lost"
  | "invalid_world"
  | "protocol_error"
  | "human_wait_timeout"
  | "runtime_timeout";

export interface ClockPayload {
  readonly phase: "waiting" | "countdown" | "grace" | "active" | "finished" | "aborted";
  readonly tick: AuthoritativeTick | null;
  readonly border_diameter_blocks: number;
}

export interface PublicStatePayload {
  readonly at: AuthoritativeTick;
  readonly alive_seats: readonly number[];
}

export interface EliminationPayload {
  readonly at: AuthoritativeTick;
  readonly eliminations: readonly {
    readonly seat: number;
    readonly cause: "death" | "disconnect";
  }[];
}

export type OutcomePayload =
  | {
      readonly kind: "winner";
      readonly winner_seat: number;
      readonly survivors: readonly [number];
      readonly at: AuthoritativeTick;
    }
  | {
      readonly kind: "draw";
      readonly reason: "no_survivors" | "tick_limit";
      readonly survivors: readonly number[];
      readonly at: AuthoritativeTick;
    }
  | {
      readonly kind: "abort";
      readonly reason: AbortReason;
      readonly survivors: readonly number[];
      readonly at: AuthoritativeTick | null;
    };

export interface MetricsPayload {
  readonly server_tick_duration_micros: number;
  readonly critical_queue_depth: number;
  readonly dropped_optional_metrics: number;
}

export type ControlErrorCode =
  | "authentication_failed"
  | "unsupported_capability"
  | "invalid_command"
  | "invalid_state"
  | "invalid_world"
  | "internal";

export type ControlMessage =
  | (ControlEnvelopeFields & { readonly type: "hello"; readonly payload: HelloPayload })
  | (ControlEnvelopeFields & { readonly type: "ready"; readonly payload: ReadyPayload })
  | (ControlEnvelopeFields & { readonly type: "heartbeat"; readonly payload: Record<string, never> })
  | (ControlEnvelopeFields & { readonly type: "build_progress"; readonly payload: BuildProgressPayload })
  | (ControlEnvelopeFields & { readonly type: "prepare"; readonly payload: PreparePayload })
  | (ControlEnvelopeFields & { readonly type: "start"; readonly payload: Record<string, never> })
  | (ControlEnvelopeFields & { readonly type: "abort"; readonly payload: { readonly reason: AbortReason } })
  | (ControlEnvelopeFields & { readonly type: "public_clock"; readonly payload: ClockPayload })
  | (ControlEnvelopeFields & { readonly type: "public_state"; readonly payload: PublicStatePayload })
  | (ControlEnvelopeFields & { readonly type: "elimination"; readonly payload: EliminationPayload })
  | (ControlEnvelopeFields & { readonly type: "outcome"; readonly payload: OutcomePayload })
  | (ControlEnvelopeFields & { readonly type: "metrics"; readonly payload: MetricsPayload })
  | (ControlEnvelopeFields & { readonly type: "ack"; readonly payload: Record<string, never> })
  | (ControlEnvelopeFields & { readonly type: "error"; readonly payload: { readonly code: ControlErrorCode; readonly message: string } });
