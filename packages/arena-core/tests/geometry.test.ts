import { deepStrictEqual, equal, throws } from 'node:assert/strict';
import { test } from 'node:test';

import {
  blockPosition,
  InvalidBlockPositionError,
  InvalidWorldBorderError,
  isNearOrOutsideBorder,
  isOutsideBorder,
  offsetBlockPosition,
  squaredDistance,
  worldBorder,
} from '../src/index.js';

test('block positions reject coordinates outside the safe integer range', () => {
  throws(
    () => blockPosition(Number.MAX_SAFE_INTEGER + 1, 0, 0),
    (error) => error instanceof InvalidBlockPositionError && error.axis === 'x',
  );
  throws(() => blockPosition(0, Number.NaN, 0), {
    name: 'InvalidBlockPositionError',
  });
});

test('checked offsets report coordinate overflow explicitly', () => {
  const maximum = blockPosition(Number.MAX_SAFE_INTEGER, 64, 0);
  const minimum = blockPosition(Number.MIN_SAFE_INTEGER, 64, 0);

  deepStrictEqual(offsetBlockPosition(maximum, 1, 0, 0), {
    ok: false,
    error: 'coordinate-overflow',
  });
  deepStrictEqual(offsetBlockPosition(minimum, -1, 0, 0), {
    ok: false,
    error: 'coordinate-overflow',
  });
  deepStrictEqual(offsetBlockPosition(maximum, -1, 0, 0), {
    ok: true,
    value: blockPosition(Number.MAX_SAFE_INTEGER - 1, 64, 0),
  });
  deepStrictEqual(offsetBlockPosition(blockPosition(0, Number.MAX_SAFE_INTEGER, 0), 0, 1, 0), {
    ok: false,
    error: 'coordinate-overflow',
  });
  deepStrictEqual(offsetBlockPosition(blockPosition(0, 0, Number.MIN_SAFE_INTEGER), 0, 0, -1), {
    ok: false,
    error: 'coordinate-overflow',
  });
  throws(() => offsetBlockPosition(blockPosition(0, 0, 0), 0.5, 0, 0), {
    name: 'InvalidBlockOffsetError',
  });
});

test('geometry uses exact distances for safe integer coordinates', () => {
  const low = blockPosition(Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER);
  const high = blockPosition(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);

  equal(squaredDistance(low, high), 3n * (18_014_398_509_481n ** 2n));
});

test('world borders use horizontal distance and the inward safety margin', () => {
  const border = worldBorder(0, 0, 10);

  equal(isNearOrOutsideBorder(border, blockPosition(9, 100, 0), 2), true);
  equal(isNearOrOutsideBorder(border, blockPosition(7, -100, 0), 2), false);
  equal(isOutsideBorder(border, blockPosition(11, 0, 0)), true);
});

test('world borders reject a zero radius with a typed field error', () => {
  throws(
    () => worldBorder(0, 0, 0),
    (error) => error instanceof InvalidWorldBorderError && error.field === 'radiusBlocks',
  );
});
