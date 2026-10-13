import { deepStrictEqual, equal, notEqual, throws } from 'node:assert/strict';
import { test } from 'node:test';

import {
  DeterministicRandom,
  RandomStream,
  seatId,
} from '../src/index.js';

test('SplitMix64 matches the pinned reference vectors', () => {
  const random = new DeterministicRandom(0n);

  deepStrictEqual(
    [random.nextU64(), random.nextU64(), random.nextU64(), random.nextU64()],
    [
      0xe220_a839_7b1d_cdafn,
      0x6e78_9e6a_a1b9_65f4n,
      0x06c4_5d18_8009_454fn,
      0xf88b_b8a8_724c_81ecn,
    ],
  );
});

test('seat streams are stable, purpose-separated, and distinct for all 256 seats', () => {
  const seed = 481_516n;
  const policyValues = new Set<bigint>();
  const searchValues = new Set<bigint>();

  for (let value = 0; value <= 255; value += 1) {
    const seat = seatId(value);
    const policyValue = DeterministicRandom.forStream(seed, RandomStream.policy(seat)).nextU64();
    const searchValue = DeterministicRandom.forStream(seed, RandomStream.search(seat)).nextU64();
    equal(
      DeterministicRandom.forStream(seed, RandomStream.policy(seat)).nextU64(),
      policyValue,
    );
    equal(
      DeterministicRandom.forStream(seed, RandomStream.search(seat)).nextU64(),
      searchValue,
    );
    policyValues.add(policyValue);
    searchValues.add(searchValue);
  }

  equal(policyValues.size, 256);
  equal(searchValues.size, 256);
  notEqual(
    DeterministicRandom.forStream(seed, RandomStream.policy(seatId(0))).nextU64(),
    DeterministicRandom.forStream(seed, RandomStream.search(seatId(0))).nextU64(),
  );
  equal(seatId(255), 255);
  throws(() => seatId(256));
});
