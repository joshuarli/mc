import assert from 'node:assert/strict';
import test from 'node:test';
import { isInsidePerceptionCone } from '../src/visibility.js';

const viewer = {
  position: { x: 0, y: 0, z: 0 },
  eyeHeight: 1.6,
  yaw: 0,
  pitch: 0,
};

test('applies range, horizontal field of view, and vertical field of view', () => {
  assert.equal(isInsidePerceptionCone(viewer, {
    position: { x: 0, y: 0, z: -39 },
    height: 1.8,
  }), true);
  assert.equal(isInsidePerceptionCone(viewer, {
    position: { x: 0, y: 0, z: -41 },
    height: 1.8,
  }), false);
  assert.equal(isInsidePerceptionCone(viewer, {
    position: { x: 10, y: 0, z: 0 },
    height: 1.8,
  }), false);
  assert.equal(isInsidePerceptionCone(viewer, {
    position: { x: 0, y: 0, z: 10 },
    height: 1.8,
  }), false);
  assert.equal(isInsidePerceptionCone(viewer, {
    position: { x: 0, y: 20, z: -10 },
    height: 1.8,
  }), false);
});

test('accepts targets above and below when aligned with Mineflayer lookAt pitch', () => {
  const above = { position: { x: 0, y: 7.1, z: -4 }, height: 1.8 };
  const abovePitch = mineflayerLookAtPitch(viewer, above);
  assert.ok(abovePitch > 0);
  assert.equal(isInsidePerceptionCone({ ...viewer, pitch: abovePitch }, above), true);
  assert.equal(isInsidePerceptionCone({ ...viewer, pitch: -abovePitch }, above), false);

  const below = { position: { x: 0, y: -5.7, z: -4 }, height: 1.8 };
  const belowPitch = mineflayerLookAtPitch(viewer, below);
  assert.ok(belowPitch < 0);
  assert.equal(isInsidePerceptionCone({ ...viewer, pitch: belowPitch }, below), true);
  assert.equal(isInsidePerceptionCone({ ...viewer, pitch: -belowPitch }, below), false);
});

test('a level view misses a deep target while an aligned downward view includes it', () => {
  const eyeHeight = 1.62;
  const viewer = {
    position: { x: 0, y: 62, z: 0 },
    eyeHeight,
    yaw: 0,
    pitch: 0,
  };
  const player = { position: { x: 0, y: 43, z: -9 }, height: 1.8 };
  assert.equal(isInsidePerceptionCone(viewer, player), false);

  const eyeY = viewer.position.y + eyeHeight;
  const lookTarget = { x: 0, y: eyeY - 12, z: -8 };
  const dx = lookTarget.x - viewer.position.x;
  const dy = lookTarget.y - eyeY;
  const dz = lookTarget.z - viewer.position.z;
  assert.equal(isInsidePerceptionCone({
    ...viewer,
    yaw: Math.atan2(-dx, -dz),
    pitch: Math.atan2(dy, Math.hypot(dx, dz)),
  }, player), true);
});

test('rejects incomplete or non-finite positions', () => {
  assert.equal(isInsidePerceptionCone(viewer, {
    position: { x: Number.NaN, y: 0, z: 1 },
    height: 1.8,
  }), false);
  assert.equal(isInsidePerceptionCone({ ...viewer, yaw: Number.POSITIVE_INFINITY }, {
    position: { x: 0, y: 0, z: 1 },
    height: 1.8,
  }), false);
});

function mineflayerLookAtPitch(
  view: typeof viewer,
  target: { readonly position: { readonly x: number; readonly y: number; readonly z: number }; readonly height: number },
): number {
  const dx = target.position.x - view.position.x;
  const dy = target.position.y + target.height / 2 - (view.position.y + view.eyeHeight);
  const dz = target.position.z - view.position.z;
  return Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
}
