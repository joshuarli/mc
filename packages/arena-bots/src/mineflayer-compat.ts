import type { Bot } from 'mineflayer';

const MINECRAFT_26_1_PROTOCOL = 775;
const SERVER_PLAYER_HALF_WIDTH = Math.fround(0.6) / 2;

/**
 * Mineflayer 4.39.0's feature table omits this protocol capability, so its numeric sprint fallback
 * serializes as start_riding_jump on protocol 775. Remove this binding when the feature table
 * reports entityActionUsesStringMapper for protocol 775.
 */
export function bindEntityActionStringMapperFeature(bot: Bot): void {
  if (String(bot.protocolVersion) !== String(MINECRAFT_26_1_PROTOCOL)) return;
  if (bot.registry.version.version !== MINECRAFT_26_1_PROTOCOL) {
    throw new Error('Mineflayer protocol version does not match its registry');
  }

  const nativeSupportFeature = bot.supportFeature as (feature: string) => boolean;
  if (nativeSupportFeature('entityActionUsesStringMapper')) return;

  bot.supportFeature = ((feature: string) => (
    feature === 'entityActionUsesStringMapper' || nativeSupportFeature(feature)
  )) as Bot['supportFeature'];
}

/**
 * Paper 26.1 uses float-width player bounds; prismarine-physics' JavaScript 0.3 half-width can
 * stop at a full-cube contact point that overlaps those wider bounds. Remove this binding when
 * pinned physics uses the same float-rounded player width.
 */
export function bindPlayerCollisionDimensions(bot: Bot): void {
  if (String(bot.protocolVersion) !== String(MINECRAFT_26_1_PROTOCOL)) return;
  if (bot.registry.version.version !== MINECRAFT_26_1_PROTOCOL) {
    throw new Error('Mineflayer protocol version does not match its registry');
  }

  const physics = bot.physics as Bot['physics'] & { playerHalfWidth: number };
  if (physics === undefined || physics === null) {
    throw new Error('Mineflayer physics is unavailable during protocol 775 collision binding');
  }
  if (physics.playerHalfWidth === SERVER_PLAYER_HALF_WIDTH) return;
  if (physics.playerHalfWidth !== 0.3) {
    throw new Error(`Mineflayer player half width does not match the protocol 775 compatibility binding: ${physics.playerHalfWidth}`);
  }

  physics.playerHalfWidth = SERVER_PLAYER_HALF_WIDTH;
}
