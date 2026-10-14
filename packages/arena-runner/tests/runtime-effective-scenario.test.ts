import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { compileScenario, type ScenarioIr } from '@arena/spec';
import { externalSeats, withExternalSeat } from '../src/effective-scenario.js';
import { RunnerError } from '../src/errors.js';
import { encodeScenarioWorldPlan } from '../src/prepare.js';

const repositoryRoot = process.cwd();

function compile(scenario: string, map: string): ScenarioIr {
  return compileScenario(
    readFileSync(join(repositoryRoot, `scenarios/${scenario}.toml`), 'utf8'),
    readFileSync(join(repositoryRoot, `maps/${map}.toml`), 'utf8'),
  );
}

function rejectsWith(operation: () => unknown, kind: string): void {
  assert.throws(operation, (error: unknown) => error instanceof RunnerError
    && error.category === 'invalid_input' && error.source.kind === kind);
}

test('substituting an external seat changes scenario identity and leaves the source scenario intact', () => {
  const base = compile('hunger-24', 'hunger-24');
  const first = withExternalSeat(base, { seat: 0, username: 'Alex_9' });
  const moved = withExternalSeat(base, { seat: 1, username: 'Alex_9' });
  const renamed = withExternalSeat(base, { seat: 0, username: 'Alex_8' });
  assert.notEqual(first.semanticId, base.semanticId);
  assert.notEqual(first.semanticId, moved.semanticId);
  assert.notEqual(first.semanticId, renamed.semanticId);
  assert.equal(withExternalSeat(base, { seat: 0, username: 'Alex_9' }).semanticId, first.semanticId);
  assert.deepEqual(externalSeats(first), [{ seat: 0, username: 'Alex_9' }]);
  assert.deepEqual(externalSeats(base), []);
  assert.equal(first.roster.competitors, 24);
});

test('external seat requests are validated against the roster before any run is staged', () => {
  const base = compile('hunger-24', 'hunger-24');
  rejectsWith(() => withExternalSeat(base, { seat: 24, username: 'Alex_9' }), 'external_seat_outside_roster');
  rejectsWith(() => withExternalSeat(base, { seat: -1, username: 'Alex_9' }), 'external_seat_outside_roster');
  rejectsWith(() => withExternalSeat(base, { seat: 0, username: 'a' }), 'invalid_external_username');
  rejectsWith(() => withExternalSeat(base, { seat: 0, username: 'has space' }), 'invalid_external_username');
  rejectsWith(() => withExternalSeat(base, { seat: 0, username: 'ArenaBot7' }), 'reserved_external_username');
  rejectsWith(() => withExternalSeat(base, { seat: 0, username: 'arenaspec1' }), 'reserved_external_username');
  const once = withExternalSeat(base, { seat: 0, username: 'Alex_9' });
  rejectsWith(() => withExternalSeat(once, { seat: 0, username: 'Steve_2' }), 'external_seat_already_assigned');
  rejectsWith(() => withExternalSeat(once, { seat: 1, username: 'alex_9' }), 'duplicate_external_username');
});

test('external seats require hunger games on natural terrain', () => {
  rejectsWith(() => withExternalSeat(compile('civilization-six', 'civilization-six'), { seat: 0, username: 'Alex_9' }),
    'external_seat_requires_hunger_games');
});

test('world plan schema follows the effective roster', () => {
  const six = compileScenario(
    readFileSync(join(repositoryRoot, 'scenarios/hunger-six.toml'), 'utf8').replace('schema = 3', 'schema = 2'),
    readFileSync(join(repositoryRoot, 'maps/hunger-six.toml'), 'utf8'),
  );
  const plain = JSON.parse(encodeScenarioWorldPlan('plan-run', six).toString('utf8'));
  assert.equal(plain.schema, 2);
  const substituted = JSON.parse(encodeScenarioWorldPlan('plan-run',
    withExternalSeat(six, { seat: 2, username: 'Alex_9' })).toString('utf8'));
  assert.equal(substituted.schema, 3);
  assert.deepEqual(substituted.roster[2], { seat: 2, kind: 'external', username: 'Alex_9' });
  assert.equal(substituted.roster[0].kind, 'bot');
  const wide = JSON.parse(encodeScenarioWorldPlan('plan-run', compile('hunger-24', 'hunger-24')).toString('utf8'));
  assert.equal(wide.schema, 3);
  assert.equal(wide.roster.length, 24);
});
