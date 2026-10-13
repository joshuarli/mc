import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import { bindEntityActionStringMapperFeature } from '../src/mineflayer-compat.js';

const require = createRequire(import.meta.url);
const mineflayerRequire = createRequire(require.resolve('mineflayer'));
const injectPhysics = mineflayerRequire('./lib/plugins/physics.js') as (
  bot: object,
  options: { readonly physicsEnabled: boolean },
) => void;
const minecraftData = mineflayerRequire('minecraft-data') as (version: string) => {
  readonly version: { readonly version: number };
  supportFeature(feature: string): boolean;
};
const protocol = mineflayerRequire('minecraft-protocol') as {
  readonly states: { readonly PLAY: string };
  createSerializer(options: { readonly state: string; readonly isServer: boolean; readonly version: string }): {
    createPacketBuffer(packet: { readonly name: string; readonly params: unknown }): Buffer;
  };
  createDeserializer(options: { readonly state: string; readonly isServer: boolean; readonly version: string }): {
    parsePacketBuffer(buffer: Buffer): {
      readonly data: { readonly params: { readonly actionId: string | number } };
      readonly buffer: Buffer;
    };
  };
};

test('Mineflayer 4.39 encodes sprint actions with the protocol 775 mapper', () => {
  const native = makeBot();
  assert.equal(supports(native.bot, 'entityActionUsesStringMapper'), false);

  injectPhysics(native.bot, { physicsEnabled: false });
  native.bot.setControlState('sprint', true);
  const uncorrectedAction = serializeEntityAction(native.actions.at(-1));
  assert.deepEqual(uncorrectedAction, { actionName: 'start_riding_jump', actionId: 3 });

  const corrected = makeBot();
  const nativeSupportFeature = (corrected.bot.supportFeature as (feature: string) => boolean).bind(corrected.bot);
  const preservedFeatures = ['newPlayerInputPacket', 'stateIdUsed', 'unsupportedFeature'];
  const before = preservedFeatures.map((feature) => nativeSupportFeature(feature));

  bindEntityActionStringMapperFeature(corrected.bot);
  assert.equal(supports(corrected.bot, 'entityActionUsesStringMapper'), true);
  assert.deepEqual(
    preservedFeatures.map((feature) => supports(corrected.bot, feature)),
    before,
  );
  const correctedSupportFeature = corrected.bot.supportFeature;
  bindEntityActionStringMapperFeature(corrected.bot);
  assert.equal(corrected.bot.supportFeature, correctedSupportFeature);

  injectPhysics(corrected.bot, { physicsEnabled: false });
  corrected.bot.setControlState('sprint', true);
  corrected.bot.setControlState('sprint', false);
  assert.deepEqual(serializeEntityAction(corrected.actions[0]), { actionName: 'start_sprinting', actionId: 1 });
  assert.deepEqual(serializeEntityAction(corrected.actions[1]), { actionName: 'stop_sprinting', actionId: 2 });
});

test('the entity action string mapper correction is limited to protocol 775', () => {
  const bot = makeBot();
  bot.bot.protocolVersion = '776';
  const nativeSupportFeature = bot.bot.supportFeature as (feature: string) => boolean;

  bindEntityActionStringMapperFeature(bot.bot);

  assert.equal(supports(bot.bot, 'entityActionUsesStringMapper'), nativeSupportFeature('entityActionUsesStringMapper'));
  assert.equal(supports(bot.bot, 'newPlayerInputPacket'), nativeSupportFeature('newPlayerInputPacket'));
  assert.equal(bot.bot.supportFeature, nativeSupportFeature);
});

test('the entity action string mapper accepts Mineflayer declaration string versions', () => {
  const bot = makeBot();
  bot.bot.protocolVersion = '775';

  bindEntityActionStringMapperFeature(bot.bot);

  assert.equal(supports(bot.bot, 'entityActionUsesStringMapper'), true);
});

test('rejects protocol 775 when the Mineflayer registry disagrees', () => {
  const bot = makeBot();
  const registry = bot.bot.registry;
  bot.bot.registry = Object.create(registry, {
    version: { value: { ...registry.version, version: 776 } },
  }) as Bot['registry'];

  assert.throws(
    () => bindEntityActionStringMapperFeature(bot.bot),
    /Mineflayer protocol version does not match its registry/,
  );
});

function makeBot(): { readonly bot: Bot; readonly actions: { readonly entityId: number; readonly actionId: string | number; readonly jumpBoost: number }[] } {
  const registry = minecraftData('26.1');
  const client = new EventEmitter() as EventEmitter & {
    write(name: string, packet: { readonly entityId: number; readonly actionId: string | number; readonly jumpBoost: number }): void;
  };
  const actions: { readonly entityId: number; readonly actionId: string | number; readonly jumpBoost: number }[] = [];
  client.write = (name, packet) => {
    if (name === 'entity_action') actions.push(packet);
  };
  const bot = new EventEmitter() as EventEmitter & Pick<Bot, 'registry' | 'supportFeature' | 'setControlState'> & {
    protocolVersion: number;
    version: string;
    _client: typeof client;
    entity: { id: number };
    blockAt: () => null;
  };
  Object.assign(bot, {
    registry,
    supportFeature: registry.supportFeature,
    protocolVersion: 775,
    version: '26.1',
    _client: client,
    entity: { id: 7 },
    blockAt: () => null,
  });
  return { bot: bot as unknown as Bot, actions };
}

function serializeEntityAction(
  packet: { readonly entityId: number; readonly actionId: string | number; readonly jumpBoost: number } | undefined,
): { readonly actionName: string | number; readonly actionId: number } {
  assert.ok(packet);
  const options = { state: protocol.states.PLAY, isServer: false, version: '26.1' };
  const serializer = protocol.createSerializer(options);
  const deserializer = protocol.createDeserializer({ ...options, isServer: true });
  const encoded = serializer.createPacketBuffer({ name: 'entity_action', params: packet });
  const parsed = deserializer.parsePacketBuffer(encoded);
  return {
    actionName: parsed.data.params.actionId,
    actionId: parsed.buffer[2] ?? -1,
  };
}

function supports(bot: Bot, feature: string): boolean {
  return (bot.supportFeature as (featureName: string) => boolean)(feature);
}
