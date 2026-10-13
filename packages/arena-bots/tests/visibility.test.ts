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
