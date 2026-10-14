import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { compileScenario } from '@arena/spec';
import { withExternalSeat } from '../src/effective-scenario.js';
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

test('runtime roster reserves one existing spectator seat for an external client when requested', () => {
  const scenario = compileHungerSixScenario(4);
  const automated = createRuntimeRoster(scenario);
  const reserved = createRuntimeRoster(scenario, { spectatorMode: 'reserveExternalSlot' });

  assert.equal(automated.competitors.length, 6);
  assert.deepEqual(automated.spectators.map(({ username }) => username), [
    'ArenaSpec0', 'ArenaSpec1', 'ArenaSpec2', 'ArenaSpec3',
  ]);
  assert.equal(reserved.competitors.length, 6);
  assert.deepEqual(reserved.spectators.map(({ username }) => username), [
    'ArenaSpec0', 'ArenaSpec1', 'ArenaSpec2',
  ]);
});

test('runtime roster rejects reserving an external spectator slot at zero capacity', () => {
  assert.throws(() => createRuntimeRoster(compileDuelScenario(0), {
    spectatorMode: 'reserveExternalSlot',
  }), (error: unknown) =>
    error instanceof RunnerError
      && error.category === 'invalid_input'
      && error.source.kind === 'external_spectator_requires_capacity');
});

function compileDuelScenario(spectatorCapacity: number) {
  const scenarioSource = readFileSync(join(repositoryRoot, 'scenarios/duel.toml'), 'utf8')
    .replace('spectator_capacity = 2', `spectator_capacity = ${spectatorCapacity}`);
  const mapSource = readFileSync(join(repositoryRoot, 'maps/duel.toml'), 'utf8');
  return compileScenario(scenarioSource, mapSource);
}

function compileHungerSixScenario(spectatorCapacity: number) {
  const scenarioSource = readFileSync(join(repositoryRoot, 'scenarios/hunger-six.toml'), 'utf8')
    .replace('spectator_capacity = 4', `spectator_capacity = ${spectatorCapacity}`);
  const mapSource = readFileSync(join(repositoryRoot, 'maps/hunger-six.toml'), 'utf8');
  return compileScenario(scenarioSource, mapSource);
}


test('civilization preparation preserves fixed border, canonical factions and public objectives', () => {
  const scenario = compileScenario(
    readFileSync(join(repositoryRoot, 'scenarios/civilization-six.toml'), 'utf8'),
    readFileSync(join(repositoryRoot, 'maps/civilization-six.toml'), 'utf8'),
  );
  assert.equal(scenario.mode, 'civilization');
  const roster = createRuntimeRoster(scenario);
  const prepare = createPreparePayload(scenario, roster.competitors);
  assert.equal(prepare.mode, 'civilization');
  if (prepare.mode !== 'civilization' || scenario.mode !== 'civilization') assert.fail('civilization mode lost');
  assert.deepEqual(prepare.settings.border, { kind: 'fixed', diameter_blocks: 192 });
  assert.deepEqual(prepare.settings.civilization.factions.map((faction) => ({
    id: faction.id, members: faction.members.map((member) => ({ ...member })),
  })), scenario.civilization.factions);
  assert.deepEqual(prepare.settings.civilization.starting_kit, scenario.civilization.startingKit);
  assert.deepEqual(prepare.settings.civilization.capture_zone.min, scenario.civilization.captureZone.min);
  assert.deepEqual(prepare.settings.civilization.blueprint.anchors.tide,
    { position: scenario.civilization.blueprint.anchors.tide.position, rotation_degrees: 180 });
  assert.equal(roster.competitors.length, 6);
  assert.equal('shrink_start_tick' in prepare.settings.border, false);
});

function compileHunger24Scenario() {
  return compileScenario(
    readFileSync(join(repositoryRoot, 'scenarios/hunger-24.toml'), 'utf8'),
    readFileSync(join(repositoryRoot, 'maps/hunger-24.toml'), 'utf8'),
  );
}

test('schema 3 roster builds 24 bot seats and prepares with the generalized roster', () => {
  const scenario = compileHunger24Scenario();
  const roster = createRuntimeRoster(scenario);
  assert.equal(roster.competitors.length, 24);
  assert.equal(roster.botCompetitors.length, 24);
  assert.equal(roster.externalCompetitors.length, 0);
  const prepare = createPreparePayload(scenario, roster.competitors);
  assert.equal(prepare.mode, 'hunger_games');
  assert.equal('roster_version' in prepare ? prepare.roster_version : undefined, 2);
  assert.equal(prepare.roster.length, 24);
});

test('an external seat gets its reserved username and offline UUID in the generalized prepare roster', () => {
  const scenario = withExternalSeat(compileHunger24Scenario(), { seat: 5, username: 'Alex_9' });
  const roster = createRuntimeRoster(scenario);
  assert.deepEqual(roster.externalCompetitors.map(({ seat, username }) => [seat, username]), [[5, 'Alex_9']]);
  assert.equal(roster.botCompetitors.length, 23);
  assert.equal(roster.botCompetitors.some((competitor) => competitor.seat === 5), false);
  assert.equal(roster.competitorIdentities[5]!.username, 'Alex_9');
  assert.equal(roster.competitorIdentities[5]!.offlineUuid, roster.externalCompetitors[0]!.offline_uuid);
  assert.match(roster.externalCompetitors[0]!.offline_uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const prepare = createPreparePayload(scenario, roster.competitors);
  assert.equal('roster_version' in prepare ? prepare.roster_version : undefined, 2);
  assert.equal(prepare.roster[5]!.kind, 'external');
});

test('schema 2 scenarios keep the legacy bot roster unless an external seat is substituted', () => {
  const scenario = compileHungerSixScenario(4);
  const legacy = createPreparePayload(scenario, createRuntimeRoster(scenario).competitors);
  assert.equal('roster_version' in legacy, false);
  const substituted = withExternalSeat(scenario, { seat: 0, username: 'Josh' });
  const prepare = createPreparePayload(substituted, createRuntimeRoster(substituted).competitors);
  assert.equal('roster_version' in prepare ? prepare.roster_version : undefined, 2);
});
