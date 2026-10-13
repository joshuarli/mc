import type { Bot } from 'mineflayer';

const MINECRAFT_26_1_PROTOCOL = 775;
const SERVER_PLAYER_HALF_WIDTH = Math.fround(0.6) / 2;

interface VelocityPacket {
  readonly entityId: number;
  readonly velocity: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
}

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

/**
 * Protocol 775 lpVec3 velocities are already in blocks per tick, but Mineflayer 4.39.0 applies
 * its legacy 1/8000 conversion to these two packet handlers. Correct entity state after those
 * handlers until Mineflayer interprets protocol 775 velocity units itself.
 */
export function bindProtocol775VelocityUnits(bot: Bot): () => void {
  if (String(bot.protocolVersion) !== String(MINECRAFT_26_1_PROTOCOL)) return () => undefined;
  if (bot.registry.version.version !== MINECRAFT_26_1_PROTOCOL) {
    throw new Error('Mineflayer protocol version does not match its registry');
  }

  const client = bot._client;
  const applyPacketVelocity = (packet: VelocityPacket): void => {
    if (
      !Number.isSafeInteger(packet.entityId)
      || packet.entityId < 0
      || !Number.isFinite(packet.velocity?.x)
      || !Number.isFinite(packet.velocity?.y)
      || !Number.isFinite(packet.velocity?.z)
    ) {
      bot.emit('error', new Error('Malformed protocol 775 entity velocity packet'));
      return;
    }

    const entity = bot.entities[packet.entityId];
    if (entity === undefined) {
      bot.emit('error', new Error(`Mineflayer entity ${packet.entityId} is unavailable for protocol 775 velocity`));
      return;
    }

    entity.velocity.set(packet.velocity.x, packet.velocity.y, packet.velocity.z);
  };
  const onEntityVelocity = (packet: VelocityPacket): void => applyPacketVelocity(packet);
  const onSpawnEntity = (packet: VelocityPacket): void => applyPacketVelocity(packet);

  client.on('entity_velocity', onEntityVelocity);
  client.on('spawn_entity', onSpawnEntity);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    client.removeListener('entity_velocity', onEntityVelocity);
    client.removeListener('spawn_entity', onSpawnEntity);
  };
}
