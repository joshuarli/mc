import { deepStrictEqual, throws } from 'node:assert/strict';
import { test } from 'node:test';

import { skillProgress, type SkillOutcome } from '../src/index.js';

test('skill progress excludes pending and succeeded states', () => {
  throws(() => skillProgress(0, 4));
  throws(() => skillProgress(4, 4));
  throws(() => skillProgress(1, 0));

  deepStrictEqual(skillProgress(3, 4), { completedSteps: 3, totalSteps: 4 });
});

test('skill outcomes keep progress, failure, and cancellation distinct', () => {
  const outcomes: readonly SkillOutcome[] = [
    { kind: 'pending' },
    { kind: 'progress', progress: skillProgress(1, 4) },
    { kind: 'succeeded' },
    { kind: 'failed', cause: 'timedOut' },
    { kind: 'cancelled', reason: 'agentEliminated' },
  ];

  deepStrictEqual(outcomes.map(({ kind }) => kind), [
    'pending',
    'progress',
    'succeeded',
    'failed',
    'cancelled',
  ]);
});
