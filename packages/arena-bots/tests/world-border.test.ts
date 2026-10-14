import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ClientWorldBorder } from '../src/world-border.js';

test('tracks only client-received border values and their lerp', () => {
  const client = new EventEmitter();
  let now = 10;
  const border = new ClientWorldBorder(client, () => now);

  assert.deepEqual(border.snapshot(), { kind: 'unknown' });

  client.emit('initialize_world_border', {
    x: 0,
    z: 0,
    oldDiameter: 20,
    newDiameter: 10,
    speed: 1000,
  });
  assert.deepEqual(border.snapshot(), {
    kind: 'current',
    value: { centerX: 0, centerZ: 0, radiusBlocks: 10 },
  });

  now += 500;
  assert.deepEqual(border.snapshot(), {
    kind: 'current',
    value: { centerX: 0, centerZ: 0, radiusBlocks: 7 },
  });

  now += 500;
  assert.deepEqual(border.snapshot(), {
    kind: 'current',
    value: { centerX: 0, centerZ: 0, radiusBlocks: 5 },
  });

  client.emit('world_border_center', { x: 1.5, z: 0 });
  assert.deepEqual(border.snapshot(), { kind: 'unknown' });

  client.emit('end', {});
  assert.deepEqual(border.snapshot(), { kind: 'unknown' });
  border.close();
});
