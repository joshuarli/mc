import {
  civilizationPolicyContext,
  civilizationProfileForSeat,
  type CivilizationPolicyContextInput,
} from '@arena/core';
import type { Bot } from 'mineflayer';
import {
  createMineflayerCivilizationClient,
  type CivilizationRosterMember,
} from '@arena/bots';
import type { CivilizationScenarioIr } from '@arena/spec';
import type { RuntimeGameplay } from './types.js';

type CivilizationRuntimeGameplay = Extract<RuntimeGameplay, { readonly mode: 'civilization' }>;

export function createCivilizationRuntimeGameplayAdapter(
  bot: Bot,
  scenario: CivilizationScenarioIr,
  seat: number,
  publicRoster: readonly CivilizationRosterMember[],
): CivilizationRuntimeGameplay {
  const profile = civilizationProfileForSeat(seat);
  if (profile === null) throw new RangeError('civilization competitor seat is outside the canonical roster');

  const rules = scenario.civilization;
  const anchor = rules.blueprint.anchors[profile.faction];
  // Keep raw input for the client's strict validator; the validated context adds a private own symbol.
  const contextInput: CivilizationPolicyContextInput = {
    ...profile,
    objective: {
      captureBox: { min: rules.captureZone.min, max: rules.captureZone.max },
      outpost: { blueprintId: rules.blueprint.id, anchor: anchor.position, rotationDegrees: anchor.rotationDegrees },
    },
  };
  const context = civilizationPolicyContext(contextInput);
  const client = createMineflayerCivilizationClient(bot, { context: contextInput, publicRoster });
  return { mode: 'civilization', context, client };
}
