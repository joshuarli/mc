import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { Bot } from 'mineflayer';
import { compileScenario } from '@arena/spec';
import { createCivilizationRuntimeGameplayAdapter } from '../src/runtime/civilization-adapter.js';

const repositoryRoot = process.cwd();
const packageRequire = createRequire(import.meta.url);
const mineflayerRequire = createRequire(packageRequire.resolve('mineflayer'));
const loadRegistry = mineflayerRequire('prismarine-registry') as (version: string) => Bot['registry'];
const registry = loadRegistry('26.1.2');

test('civilization runtime adapter gives its client the raw context input', async () => {
  const scenario = compileScenario(
    readFileSync(join(repositoryRoot, 'scenarios/civilization-six.toml'), 'utf8'),
    readFileSync(join(repositoryRoot, 'maps/civilization-six.toml'), 'utf8'),
  );
  if (scenario.mode !== 'civilization') throw new Error('civilization scenario required');
  const bot = makeBot();
  const gameplay = createCivilizationRuntimeGameplayAdapter(bot, scenario, 5, publicRoster());

  try {
    assert.equal(gameplay.mode, 'civilization');
    assert.equal(gameplay.context.seat, 5);
  } finally {
    await gameplay.client.close();
  }

  assert.equal(bot.listenerCount('spawn'), 0);
  assert.equal(bot.listenerCount('health'), 0);
  assert.equal(bot._client.listenerCount('window_items'), 0);
  assert.equal(bot._client.listenerCount('entity_velocity'), 0);
  assert.equal(bot._client.listenerCount('spawn_entity'), 0);
});

function makeBot(): Bot {
  const bot = new EventEmitter() as EventEmitter & {
    _client: EventEmitter;
    protocolVersion: string;
    registry: Bot['registry'];
    physics: { playerHalfWidth: number };
    supportFeature: Bot['supportFeature'];
    hasPlugin(plugin: unknown): boolean;
    pathfinder: {
      thinkTimeout: number;
      tickTimeout: number;
      searchRadius: number;
      setMovements(movements: unknown): void;
      setGoal(goal: unknown, dynamic?: boolean): void;
      isMoving(): boolean;
      stop(): void;
    };
  };
  Object.assign(bot, {
    _client: new EventEmitter(),
    protocolVersion: '775',
    registry,
    physics: { playerHalfWidth: 0.3 },
    supportFeature: registry.supportFeature,
    hasPlugin: () => true,
    pathfinder: {
      thinkTimeout: 5_000,
      tickTimeout: 40,
      searchRadius: -1,
      setMovements: () => undefined,
      setGoal: () => undefined,
      isMoving: () => false,
      stop: () => undefined,
    },
  });
  return bot as unknown as Bot;
}

function publicRoster() {
  return Array.from({ length: 6 }, (_, seat) => ({
    seat,
    username: `ArenaBot${seat}`,
    offlineUuid: `00000000-0000-3000-8000-${String(seat + 1).padStart(12, '0')}`,
  }));
}
