export const CONTROL_CAPABILITIES = Object.freeze(["hunger_games_v1", "civilization_v1", "hunger_games_roster_v2"] as const);
export type ControlCapability = typeof CONTROL_CAPABILITIES[number];
export type FactionId = "ember" | "tide";
export type CivilizationRole = "gatherer_crafter" | "builder" | "defender_scout";

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

export interface BotCompetitor {
  readonly kind: "bot";
  readonly seat: number;
  readonly participant_id: string;
  readonly username: string;
  readonly offline_uuid: string;
}

export interface ExternalCompetitor {
  readonly kind: "external";
  readonly seat: number;
  readonly participant_id: string;
  readonly username: string;
  readonly offline_uuid: string;
}

export type RosterCompetitor = BotCompetitor | ExternalCompetitor;

export interface SquadDefinition {
  readonly id: string;
  readonly seats: readonly number[];
}

export type PrepareRules =
  | {
    readonly kind: "frontier_survival";
    readonly version: 1;
    readonly edit_radius_blocks: number;
    readonly max_block_edits_per_seat: number;
  }
  | { readonly kind: "squads"; readonly version: 1; readonly squads: readonly SquadDefinition[] };

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

export interface FixedBorderSettings {
  readonly kind: "fixed";
  readonly diameter_blocks: 192;
}

export interface HungerGamesPrepareSettings {
  readonly match: MatchSettings;
  readonly border: BorderSettings;
}

export type EmberFaction = {
  readonly id: "ember";
  readonly members: readonly [
    { readonly seat: 0; readonly role: "gatherer_crafter" },
    { readonly seat: 1; readonly role: "builder" },
    { readonly seat: 2; readonly role: "defender_scout" }
  ];
};

export type TideFaction = {
  readonly id: "tide";
  readonly members: readonly [
    { readonly seat: 3; readonly role: "gatherer_crafter" },
    { readonly seat: 4; readonly role: "builder" },
    { readonly seat: 5; readonly role: "defender_scout" }
  ];
};

export type CivilizationFactions = readonly [EmberFaction, TideFaction];

export type CivilizationStartingKit = readonly [
  { readonly item: "minecraft:bread"; readonly count: 4 },
  { readonly item: "minecraft:wooden_axe"; readonly count: 1 },
  { readonly item: "minecraft:wooden_pickaxe"; readonly count: 1 },
  { readonly item: "minecraft:wooden_sword"; readonly count: 1 }
];

export interface BlockPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface CaptureZone {
  readonly min: BlockPosition;
  readonly max: BlockPosition;
  readonly uncontested_ticks: 200;
  readonly score_points_per_tick: 1;
}

export interface CivilizationBlueprint {
  readonly id: "oak-outpost-v1";
  readonly anchors: {
    readonly ember: { readonly position: BlockPosition; readonly rotation_degrees: 0 };
    readonly tide: { readonly position: BlockPosition; readonly rotation_degrees: 180 };
  };
}

export interface CivilizationScenarioSettings {
  readonly factions: CivilizationFactions;
  readonly starting_kit: CivilizationStartingKit;
  readonly capture_zone: CaptureZone;
  readonly blueprint: CivilizationBlueprint;
}

export interface CivilizationPrepareSettings {
  readonly match: MatchSettings;
  readonly border: FixedBorderSettings;
  readonly civilization: CivilizationScenarioSettings;
}

export type PreparePayload = {
  readonly map_semantic_id: string;
  readonly scenario_semantic_id: string;
  readonly seed: bigint;
  readonly mode: "hunger_games";
  readonly settings: HungerGamesPrepareSettings;
  readonly roster: readonly BotCompetitor[];
} | {
  readonly map_semantic_id: string;
  readonly scenario_semantic_id: string;
  readonly seed: bigint;
  readonly mode: "civilization";
  readonly settings: CivilizationPrepareSettings;
  readonly roster: readonly BotCompetitor[];
} | {
  readonly map_semantic_id: string;
  readonly scenario_semantic_id: string;
  readonly seed: bigint;
  readonly mode: "hunger_games";
  readonly roster_version: 2;
  readonly rules?: PrepareRules;
  readonly settings: HungerGamesPrepareSettings;
  readonly roster: readonly RosterCompetitor[];
};

export type FactionScores = readonly [
  { readonly faction_id: "ember"; readonly points: bigint },
  { readonly faction_id: "tide"; readonly points: bigint }
];

export interface CivilizationStatePayload {
  readonly at: AuthoritativeTick;
  readonly occupants: readonly number[];
  readonly owner_faction: FactionId | null;
  readonly challenger_faction: FactionId | null;
  readonly capture_progress_ticks: bigint;
  readonly scores: FactionScores;
}

export interface FactionWinnerOutcome {
  readonly kind: "faction_winner";
  readonly winner_faction_id: FactionId;
  readonly reason: "elimination" | "tick_limit";
  readonly scores: FactionScores;
  readonly survivors: readonly number[];
  readonly at: AuthoritativeTick;
}

export interface HungerGamesDrawOutcome {
  readonly kind: "draw";
  readonly reason: "no_survivors" | "tick_limit";
  readonly survivors: readonly number[];
  readonly at: AuthoritativeTick;
}

export interface CivilizationDrawOutcome extends HungerGamesDrawOutcome {
  readonly scores: FactionScores;
}

export type HungerGamesPreparePayload = Extract<PreparePayload, { readonly mode: "hunger_games" }>;
export type CivilizationPreparePayload = Extract<PreparePayload, { readonly mode: "civilization" }>;
export type HungerGamesV2PreparePayload = Extract<PreparePayload, { readonly roster_version: 2 }>;

export type OutcomePayload =
  | {
      readonly kind: "winner";
      readonly winner_seat: number;
      readonly survivors: readonly [number];
      readonly at: AuthoritativeTick;
    }
  | FactionWinnerOutcome
  | HungerGamesDrawOutcome
  | CivilizationDrawOutcome
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

export type AbortReason =
  | "operator"
  | "lease_lost"
  | "invalid_world"
  | "protocol_error"
  | "runtime_timeout";

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
  | (ControlEnvelopeFields & { readonly type: "civilization_state"; readonly payload: CivilizationStatePayload })
  | (ControlEnvelopeFields & { readonly type: "outcome"; readonly payload: OutcomePayload })
  | (ControlEnvelopeFields & { readonly type: "metrics"; readonly payload: MetricsPayload })
  | (ControlEnvelopeFields & { readonly type: "ack"; readonly payload: Record<string, never> })
  | (ControlEnvelopeFields & { readonly type: "error"; readonly payload: { readonly code: ControlErrorCode; readonly message: string } });
