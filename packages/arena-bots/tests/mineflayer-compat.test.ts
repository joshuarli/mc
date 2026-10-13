import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import { bindEntityActionStringMapperFeature, bindPlayerCollisionDimensions } from '../src/mineflayer-compat.js';
import { createMineflayerArenaClient } from '../src/index.js';

const require = createRequire(import.meta.url);
const mineflayerRequire = createRequire(require.resolve('mineflayer'));
const injectPhysics = mineflayerRequire('./lib/plugins/physics.js') as (
  bot: object,
  options: { readonly physicsEnabled: boolean },
) => void;
const minecraftData = mineflayerRequire('minecraft-data') as (version: string) => {
  readonly version: { readonly version: number };
  supportFeature(feature: string): boolean;
  readonly blocksByName: {
    readonly air: { readonly id: number };
    readonly stone: { readonly id: number };
  };
};
const { PlayerState } = mineflayerRequire('prismarine-physics') as {
  readonly PlayerState: new (bot: object, controls: PhysicsControls) => object;
};
const { Vec3 } = mineflayerRequire('vec3') as {
  readonly Vec3: new (x: number, y: number, z: number) => PhysicsPosition;
};
const PrismarineBlock = mineflayerRequire('prismarine-block') as (
  version: string,
) => new (type: number, biomeId: number, metadata: number) => PhysicsBlock;
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

test('protocol 775 injected physics keeps a jump clear of a full cube', async () => {
  const { bot, world } = makePhysicsBot();
  injectPhysics(bot, { physicsEnabled: false });
  const client = createMineflayerArenaClient(bot);
  const paperPlayerHalfWidth = Math.fround(0.6) / 2;

  try {
    const physics = bot.physics as unknown as InjectedPhysics;
    const controls: PhysicsControls = {
      forward: false,
      back: false,
      left: false,
      right: false,
      jump: true,
      sprint: false,
      sneak: false,
    };
    physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot);

    const position = bot.entity.position;
    assert.equal(position.x, 31 - paperPlayerHalfWidth);
    assert.ok(position.y > 65.4, 'the jump should still rise above the floor');
    assert.equal(bot.entity.onGround, false);
    assert.ok(position.x + paperPlayerHalfWidth <= 31, 'the Paper-sized bounding box must not overlap the target cube');
    assert.equal(physics.playerHeight, 1.8);
  } finally {
    await client.close();
  }
});

test('player collision width binding is protocol-scoped, idempotent, and isolated per bot', () => {
  const first = makePhysicsBot().bot;
  const second = makePhysicsBot().bot;
  injectPhysics(first, { physicsEnabled: false });
  injectPhysics(second, { physicsEnabled: false });
  const secondPhysics = second.physics;
  const playerHeight = first.physics.playerHeight;

  bindPlayerCollisionDimensions(first);
  bindPlayerCollisionDimensions(first);

  assert.equal((first.physics as unknown as InjectedPhysics).playerHalfWidth, Math.fround(0.6) / 2);
  assert.equal(first.physics.playerHeight, playerHeight);
  assert.equal((second.physics as unknown as InjectedPhysics).playerHalfWidth, 0.3);
  assert.equal(second.physics, secondPhysics);

  const otherProtocol = makePhysicsBot().bot;
  injectPhysics(otherProtocol, { physicsEnabled: false });
  otherProtocol.protocolVersion = '776';
  const otherPhysics = otherProtocol.physics;
  bindPlayerCollisionDimensions(otherProtocol);
  assert.equal(otherProtocol.physics, otherPhysics);
  assert.equal((otherProtocol.physics as unknown as InjectedPhysics).playerHalfWidth, 0.3);

  const mismatched = makePhysicsBot().bot;
  injectPhysics(mismatched, { physicsEnabled: false });
  mismatched.registry = Object.create(mismatched.registry, {
    version: { value: { ...mismatched.registry.version, version: 776 } },
  }) as Bot['registry'];
  assert.throws(() => bindPlayerCollisionDimensions(mismatched), /protocol version does not match its registry/);

  const missingPhysics = makeBot().bot;
  assert.throws(() => bindPlayerCollisionDimensions(missingPhysics), /physics is unavailable/);

  const unexpectedWidth = makePhysicsBot().bot;
  injectPhysics(unexpectedWidth, { physicsEnabled: false });
  (unexpectedWidth.physics as unknown as { playerHalfWidth: number }).playerHalfWidth = 0.31;
  assert.throws(() => bindPlayerCollisionDimensions(unexpectedWidth), /half width does not match/);
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

interface PhysicsPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  clone(): PhysicsPosition;
  offset(x: number, y: number, z: number): PhysicsPosition;
  floored(): PhysicsPosition;
}

interface PhysicsControls {
  readonly forward: boolean;
  readonly back: boolean;
  readonly left: boolean;
  readonly right: boolean;
  readonly jump: boolean;
  readonly sprint: boolean;
  readonly sneak: boolean;
}

interface PhysicsBlock {
  readonly position: PhysicsPosition;
  readonly shapes: readonly (readonly number[])[];
}

interface PhysicsWorld {
  getBlock(position: PhysicsPosition): PhysicsBlock;
}

interface InjectedPhysics {
  readonly playerHeight: number;
  readonly playerHalfWidth: number;
  simulatePlayer(
    playerState: object,
    world: PhysicsWorld,
  ): { apply(bot: Bot): void };
}

function makePhysicsBot(): { readonly bot: Bot; readonly world: PhysicsWorld } {
  const registry = minecraftData('26.1');
  const Block = PrismarineBlock('26.1');
  const bot = makeBot().bot;
  const world: PhysicsWorld = {
    getBlock: (position) => {
      const x = Math.floor(position.x);
      const y = Math.floor(position.y);
      const z = Math.floor(position.z);
      const solid = y === 64 || (x === 31 && y === 65 && z === 21);
      const block = new Block(solid ? registry.blocksByName.stone.id : registry.blocksByName.air.id, 0, 0);
      Object.assign(block, { position: new Vec3(x, y, z) });
      return block;
    },
  };
  const state = {
    position: new Vec3(30.409184866947346, 65, 21.495385857614927),
    velocity: new Vec3(0.3, 0, 0),
    onGround: true,
    isInWater: false,
    isInLava: false,
    isInWeb: false,
    isCollidedHorizontally: false,
    isCollidedVertically: false,
    elytraFlying: false,
    yaw: 0,
    pitch: 0,
    effects: {},
    attributes: {},
  };
  Object.assign(bot, {
    entity: state,
    inventory: { slots: Array(46).fill(null) },
    jumpTicks: 0,
    jumpQueued: true,
    fireworkRocketDuration: 0,
    blockAt: (position: PhysicsPosition) => world.getBlock(position),
    hasPlugin: () => true,
    pathfinder: {
      goal: null,
      thinkTimeout: 0,
      tickTimeout: 0,
      searchRadius: 0,
      setMovements: () => undefined,
      setGoal: () => undefined,
      isMoving: () => false,
      stop: () => undefined,
    },
  });
  return { bot, world };
}
