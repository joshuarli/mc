import { readFileSync } from 'node:fs';
import { deepStrictEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';

import { PolicyParams } from '../src/index.js';

test('baseline profile matches the typed policy defaults', () => {
  const source = readFileSync(`${process.cwd()}/policies/baseline.toml`, 'utf8');
  const entries = source.trim().split('\n').map((line) => {
    const match = /^([a-z][a-z0-9_]*) = ([0-9]+)$/.exec(line);
    if (match === null) {
      throw new TypeError(`invalid baseline profile entry: ${line}`);
    }
    return [match[1], Number(match[2])] as const;
  });
  const profileValues = Object.fromEntries(entries);
  equal(Object.keys(profileValues).length, entries.length);

  const typedValues = Object.fromEntries(
    Object.entries(PolicyParams.baseline().values).map(([key, value]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      value,
    ]),
  );
  deepStrictEqual(profileValues, typedValues);
});
