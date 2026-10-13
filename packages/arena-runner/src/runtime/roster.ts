import { createHash } from 'node:crypto';
import type { ScenarioIr } from '@arena/spec';
import type { BotCompetitor, PreparePayload } from '../control/index.js';
import { RunnerError } from '../errors.js';
import type { PlayerIdentity } from './observations.js';

export const MAX_RUNTIME_SPECTATORS = 4;

/** Creates stable offline identities from seat numbers so every run preserves roster identity. */
export function createRuntimeRoster(scenario: ScenarioIr): Readonly<{
  competitors: readonly BotCompetitor[];
  competitorIdentities: readonly PlayerIdentity[];
  spectators: readonly PlayerIdentity[];
}> {
  const competitors: BotCompetitor[] = [];
  const competitorIdentities: PlayerIdentity[] = [];
  for (let seat = 0; seat < scenario.roster.competitors; seat += 1) {
    const username = `ArenaBot${seat}`;
    const offlineUuid = minecraftOfflineUuid(username);
    competitors.push(Object.freeze({
      kind: 'bot',
      seat,
      participant_id: `seat-${seat}`,
      username,
      offline_uuid: offlineUuid,
    }));
    competitorIdentities.push(Object.freeze({ username, offlineUuid }));
  }

  if (scenario.roster.spectatorCapacity > BigInt(MAX_RUNTIME_SPECTATORS)) {
    throw new RunnerError('invalid_input', 'scenario spectator capacity', {
      kind: 'runtime_client_limit_exceeded',
    });
  }
  const spectatorCount = Number(scenario.roster.spectatorCapacity);
  const spectators = Array.from({ length: spectatorCount }, (_, index) => {
    const username = `ArenaSpec${index}`;
    return Object.freeze({ username, offlineUuid: minecraftOfflineUuid(username) });
  });
  return Object.freeze({
    competitors: Object.freeze(competitors),
    competitorIdentities: Object.freeze(competitorIdentities),
    spectators: Object.freeze(spectators),
  });
}

export function createPreparePayload(scenario: ScenarioIr, roster: readonly BotCompetitor[]): PreparePayload {
  return Object.freeze({
    map_semantic_id: scenario.map.semanticId,
    scenario_semantic_id: scenario.semanticId,
    seed: scenario.seed,
    mode: 'hunger_games',
    settings: Object.freeze({
      match: Object.freeze({
        countdown_ticks: scenario.matchSettings.countdownTicks,
        grace_ticks: scenario.matchSettings.graceTicks,
        authoritative_max_ticks: scenario.matchSettings.authoritativeMaxTicks,
        respawn: scenario.matchSettings.respawn,
        block_breaking: scenario.matchSettings.blockBreaking,
        block_placing: scenario.matchSettings.blockPlacing,
        natural_mobs: scenario.matchSettings.naturalMobs,
        natural_random_ticks: scenario.matchSettings.naturalRandomTicks,
      }),
      border: Object.freeze({
        initial_diameter_blocks: scenario.border.initialDiameterBlocks,
        shrink_start_tick: scenario.border.shrinkStartTick,
        shrink_end_tick: scenario.border.shrinkEndTick,
        final_diameter_blocks: scenario.border.finalDiameterBlocks,
      }),
    }),
    roster,
  });
}

function minecraftOfflineUuid(username: string): string {
  const bytes = createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x30;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hexadecimal = bytes.toString('hex');
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`;
}
