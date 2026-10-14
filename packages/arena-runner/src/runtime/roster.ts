import { createHash } from 'node:crypto';
import type {
  CivilizationFactionMemberIr,
  CivilizationScenarioIr,
  HungerGamesScenarioV3Ir,
  HungerGamesScenarioV4Ir,
  RuleModeIr,
  ScenarioIr,
} from '@arena/spec';
import type { BotCompetitor, ExternalCompetitor, PreparePayload, PrepareRules, RosterCompetitor } from '../control/index.js';
import { RunnerError } from '../errors.js';
import type { PlayerIdentity } from './observations.js';

export const MAX_RUNTIME_SPECTATORS = 4;

export type RuntimeSpectatorMode = 'automated' | 'reserveExternalSlot';

export function createRuntimeRoster(
  scenario: ScenarioIr,
  options: Readonly<{ spectatorMode?: RuntimeSpectatorMode }> = {},
): Readonly<{
  competitors: readonly RosterCompetitor[];
  botCompetitors: readonly BotCompetitor[];
  externalCompetitors: readonly ExternalCompetitor[];
  competitorIdentities: readonly PlayerIdentity[];
  spectators: readonly PlayerIdentity[];
}> {
  const spectatorMode = options.spectatorMode ?? 'automated';
  const spectatorCapacity = scenario.roster.spectatorCapacity;
  if (spectatorMode === 'reserveExternalSlot' && spectatorCapacity === 0n) {
    throw new RunnerError('invalid_input', 'scenario spectator capacity', {
      kind: 'external_spectator_requires_capacity',
    });
  }
  if (spectatorCapacity > BigInt(MAX_RUNTIME_SPECTATORS)) {
    throw new RunnerError('invalid_input', 'scenario spectator capacity', {
      kind: 'runtime_client_limit_exceeded',
    });
  }

  const competitors: RosterCompetitor[] = [];
  const botCompetitors: BotCompetitor[] = [];
  const externalCompetitors: ExternalCompetitor[] = [];
  const competitorIdentities: PlayerIdentity[] = [];
  for (const { seat, controller } of scenario.roster.seats) {
    const username = controller.kind === 'bot' ? `ArenaBot${seat}` : controller.username;
    const offlineUuid = minecraftOfflineUuid(username);
    const common = { seat, participant_id: `seat-${seat}`, username, offline_uuid: offlineUuid };
    if (controller.kind === 'bot') {
      const bot: BotCompetitor = Object.freeze({ kind: 'bot', ...common });
      competitors.push(bot);
      botCompetitors.push(bot);
    } else {
      const external: ExternalCompetitor = Object.freeze({ kind: 'external', ...common });
      competitors.push(external);
      externalCompetitors.push(external);
    }
    competitorIdentities.push(Object.freeze({ username, offlineUuid }));
  }

  const spectatorCount = Number(spectatorCapacity) - (spectatorMode === 'reserveExternalSlot' ? 1 : 0);
  const spectators = Array.from({ length: spectatorCount }, (_, index) => {
    const username = `ArenaSpec${index}`;
    return Object.freeze({ username, offlineUuid: minecraftOfflineUuid(username) });
  });
  return Object.freeze({
    competitors: Object.freeze(competitors),
    botCompetitors: Object.freeze(botCompetitors),
    externalCompetitors: Object.freeze(externalCompetitors),
    competitorIdentities: Object.freeze(competitorIdentities),
    spectators: Object.freeze(spectators),
  });
}

export function createPreparePayload(scenario: ScenarioIr, roster: readonly RosterCompetitor[]): PreparePayload {
  const common = {
    map_semantic_id: scenario.map.semanticId,
    scenario_semantic_id: scenario.semanticId,
    seed: scenario.seed,
  };
  const match = Object.freeze({
    countdown_ticks: scenario.matchSettings.countdownTicks,
    grace_ticks: scenario.matchSettings.graceTicks,
    authoritative_max_ticks: scenario.matchSettings.authoritativeMaxTicks,
    respawn: scenario.matchSettings.respawn,
    block_breaking: scenario.matchSettings.blockBreaking,
    block_placing: scenario.matchSettings.blockPlacing,
    natural_mobs: scenario.matchSettings.naturalMobs,
    natural_random_ticks: scenario.matchSettings.naturalRandomTicks,
  });
  if (scenario.mode === 'civilization') return Object.freeze({
    ...common,
    roster: botOnlyRoster(roster),
    mode: scenario.mode,
    settings: Object.freeze({
      match,
      border: Object.freeze({ kind: scenario.border.kind, diameter_blocks: scenario.border.diameterBlocks }),
      civilization: civilizationPrepareSettings(scenario),
    }),
  });
  const settings = Object.freeze({
    match,
    border: Object.freeze({
      initial_diameter_blocks: scenario.border.initialDiameterBlocks,
      shrink_start_tick: scenario.border.shrinkStartTick,
      shrink_end_tick: scenario.border.shrinkEndTick,
      final_diameter_blocks: scenario.border.finalDiameterBlocks,
    }),
  });
  if (hungerRulesOnWire(scenario) || roster.some((competitor) => competitor.kind === 'external')) {
    const rules = hungerRulesOnWire(scenario) ? preparedRules(scenario.rules) : undefined;
    return Object.freeze({
      ...common,
      mode: 'hunger_games',
      roster_version: 2,
      ...(rules === undefined ? {} : { rules }),
      settings,
      roster,
    });
  }
  return Object.freeze({ ...common, mode: 'hunger_games', settings, roster: botOnlyRoster(roster) });
}

function hungerRulesOnWire(
  scenario: ScenarioIr,
): scenario is HungerGamesScenarioV3Ir | HungerGamesScenarioV4Ir {
  return scenario.mode === 'hunger_games' && (
    scenario.schemaVersion === 3
    || (scenario.schemaVersion === 4 && scenario.rules.kind === 'uhc_duel')
  );
}

function preparedRules(rules: RuleModeIr): PrepareRules | undefined {
  switch (rules.kind) {
    case 'classic': return undefined;
    case 'frontier_survival': return Object.freeze({
      kind: 'frontier_survival',
      version: rules.version,
      edit_radius_blocks: rules.editRadiusBlocks,
      max_block_edits_per_seat: rules.maxBlockEditsPerSeat,
    });
    case 'squads': return Object.freeze({
      kind: 'squads',
      version: rules.version,
      squads: Object.freeze(rules.squads.map((squad) => Object.freeze({ id: squad.id, seats: squad.seats }))),
    });
    case 'uhc_duel': return Object.freeze({
      kind: 'uhc_duel',
      version: rules.version,
      kit: Object.freeze({
        armor: rules.kit.armor,
        sword: rules.kit.sword,
        arrows: rules.kit.arrows,
        golden_apples: rules.kit.goldenApples,
        food: rules.kit.food,
        food_count: rules.kit.foodCount,
        ...(rules.kit.shield ? { shield: true as const } : {}),
      }),
    });
  }
}

function botOnlyRoster(roster: readonly RosterCompetitor[]): readonly BotCompetitor[] {
  return roster.map((competitor) => {
    if (competitor.kind !== 'bot') {
      throw new RunnerError('invalid_input', 'scenario roster', { kind: 'external_seat_requires_roster_v2' });
    }
    return competitor;
  });
}

function civilizationPrepareSettings(scenario: CivilizationScenarioIr) {
  const rules = scenario.civilization;
  const [ember, tide] = rules.factions;
  if (ember.id !== 'ember' || tide.id !== 'tide'
      || rules.blueprint.anchors.ember.rotationDegrees !== 0
      || rules.blueprint.anchors.tide.rotationDegrees !== 180) {
    throw new RunnerError('invalid_input', 'civilization roster', { kind: 'noncanonical_factions' });
  }
  return Object.freeze({
    factions: Object.freeze([
      Object.freeze({ id: ember.id, members: Object.freeze([
        canonicalMember(ember.members[0], 0, 'gatherer_crafter'),
        canonicalMember(ember.members[1], 1, 'builder'),
        canonicalMember(ember.members[2], 2, 'defender_scout'),
      ] as const) }),
      Object.freeze({ id: tide.id, members: Object.freeze([
        canonicalMember(tide.members[0], 3, 'gatherer_crafter'),
        canonicalMember(tide.members[1], 4, 'builder'),
        canonicalMember(tide.members[2], 5, 'defender_scout'),
      ] as const) }),
    ] as const),
    starting_kit: rules.startingKit,
    capture_zone: Object.freeze({
      min: rules.captureZone.min, max: rules.captureZone.max,
      uncontested_ticks: rules.captureZone.uncontestedTicks,
      score_points_per_tick: rules.captureZone.pointsPerOwnedTick,
    }),
    blueprint: Object.freeze({ id: rules.blueprint.id, anchors: Object.freeze({
      ember: Object.freeze({ position: rules.blueprint.anchors.ember.position, rotation_degrees: 0 as const }),
      tide: Object.freeze({ position: rules.blueprint.anchors.tide.position, rotation_degrees: 180 as const }),
    }) }),
  });
}

function canonicalMember<S extends number, R extends CivilizationFactionMemberIr['role']>(
  member: CivilizationFactionMemberIr, seat: S, role: R,
): Readonly<{ seat: S; role: R }> {
  if (member.seat !== seat || member.role !== role) {
    throw new RunnerError('invalid_input', 'civilization roster', { kind: 'noncanonical_member' });
  }
  return Object.freeze({ seat, role });
}

function minecraftOfflineUuid(username: string): string {
  const bytes = createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x30;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hexadecimal = bytes.toString('hex');
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`;
}
