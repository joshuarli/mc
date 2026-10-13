import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { compileScenario } from '@arena/spec';
import { RunnerError } from '../src/errors.js';
import { createPreparePayload, createRuntimeRoster } from '../src/runtime/roster.js';

const repositoryRoot = process.cwd();

test('runtime roster keeps stable bot identities and fills the configured spectator capacity', () => {
  const scenario = compileDuelScenario(2);
  const first = createRuntimeRoster(scenario);
  const second = createRuntimeRoster(scenario);

  assert.deepEqual(first.competitors.map(({ seat, username }) => [seat, username]), [
    [0, 'ArenaBot0'],
    [1, 'ArenaBot1'],
  ]);
  assert.deepEqual(first.spectators.map(({ username }) => username), ['ArenaSpec0', 'ArenaSpec1']);
  assert.deepEqual(first.competitorIdentities, second.competitorIdentities);
  assert.deepEqual(first.spectators, second.spectators);
  assert.equal(new Set([
    ...first.competitorIdentities.map(({ offlineUuid }) => offlineUuid),
    ...first.spectators.map(({ offlineUuid }) => offlineUuid),
  ]).size, 4);
  for (const identity of [...first.competitorIdentities, ...first.spectators]) {
    assert.match(identity.offlineUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  assert.deepEqual(createPreparePayload(scenario, first.competitors).roster, first.competitors);
});

test('runtime roster rejects spectator counts beyond the four-client budget', () => {
  assert.throws(() => createRuntimeRoster(compileDuelScenario(5)), (error: unknown) =>
    error instanceof RunnerError
      && error.category === 'invalid_input'
      && error.source.kind === 'runtime_client_limit_exceeded');
});

function compileDuelScenario(spectatorCapacity: number) {
  const scenarioSource = readFileSync(join(repositoryRoot, 'scenarios/duel.toml'), 'utf8')
    .replace('spectator_capacity = 2', `spectator_capacity = ${spectatorCapacity}`);
  const mapSource = readFileSync(join(repositoryRoot, 'maps/duel.toml'), 'utf8');
  return compileScenario(scenarioSource, mapSource);
}
