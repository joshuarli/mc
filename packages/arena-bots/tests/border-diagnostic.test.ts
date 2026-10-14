import assert from 'node:assert/strict';
import test from 'node:test';
import { BORDER_UNKNOWN_DIAGNOSTIC_THRESHOLD } from '@arena/core';
import { createCombatArena } from './combat-arena.js';

test('a fractional border center is reported with its exact reason after the decision threshold', async () => {
  const arena = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [],
    border: { x: 0.5, z: 0.5, diameter: 400 },
  });
  try {
    for (let index = 0; index < BORDER_UNKNOWN_DIAGNOSTIC_THRESHOLD; index += 1) {
      assert.equal(arena.observe().border.kind, 'unknown');
    }
    assert.deepEqual(arena.diagnostics, []);
    assert.deepEqual(arena.decide().intent, { kind: 'hold', reason: 'borderUnknown' });
    assert.deepEqual(arena.diagnostics, [{
      kind: 'borderUnknown',
      reason: 'fractionalCenter',
      consecutiveObservations: BORDER_UNKNOWN_DIAGNOSTIC_THRESHOLD + 1,
    }]);
  } finally {
    await arena.close();
  }
});

test('an integer border center is known immediately and raises no diagnostic', async () => {
  const arena = createCombatArena({
    self: { x: 0.5, y: 1, z: 0.5 },
    opponents: [],
    border: { x: 1, z: -2, diameter: 400 },
  });
  try {
    for (let index = 0; index < BORDER_UNKNOWN_DIAGNOSTIC_THRESHOLD + 5; index += 1) {
      assert.equal(arena.observe().border.kind, 'current');
    }
    assert.deepEqual(arena.diagnostics, []);
  } finally {
    await arena.close();
  }
});
