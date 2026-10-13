import type { Bot } from 'mineflayer';

const ENTITY_ACTION_STRING_MAPPER_PROTOCOL = 775;

/**
 * Mineflayer 4.39.0's feature table omits this protocol capability, so its numeric sprint fallback
 * serializes as start_riding_jump on protocol 775. Remove this binding when the feature table
 * reports entityActionUsesStringMapper for protocol 775.
 */
export function bindEntityActionStringMapperFeature(bot: Bot): void {
  if (bot.protocolVersion !== String(ENTITY_ACTION_STRING_MAPPER_PROTOCOL)) return;
  if (bot.registry.version.version !== ENTITY_ACTION_STRING_MAPPER_PROTOCOL) {
    throw new Error('Mineflayer protocol version does not match its registry');
  }

  const nativeSupportFeature = bot.supportFeature as (feature: string) => boolean;
  if (nativeSupportFeature('entityActionUsesStringMapper')) return;

  bot.supportFeature = ((feature: string) => (
    feature === 'entityActionUsesStringMapper' || nativeSupportFeature(feature)
  )) as Bot['supportFeature'];
}
