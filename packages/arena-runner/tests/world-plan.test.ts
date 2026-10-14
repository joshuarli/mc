import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { compileMap } from '@arena/spec';
import { encodeWorldPlan, encodeWorldPlanV1, encodeWorldPlanV2, WorldPlanError } from '../src/world-plan.js';

const repositoryRoot = process.cwd();
const worldPlanFixture = join(repositoryRoot, 'tests/fixtures/world-plan/world-plan-v1.json');

const fixtureMap = `
schema = 1
name = "fixture"
dimensions = { width = 4, depth = 4, min_y = 0, max_y = 3 }
operations = [
  { kind = "cuboid", from = { x = 0, y = 0, z = 0 }, to = { x = 2, y = 0, z = 2 }, block = "minecraft:stone" },
  { kind = "spawn", seat = 0, position = { x = 0, y = 1, z = 0 } },
  { kind = "loot_container", position = { x = 2, y = 1, z = 2 }, inventory = ["minecraft:apple"] }
]
`;

const naturalFixtureMap = `
schema = 2
name = "natural-fixture"
terrain = "vanilla"
dimensions = { width = 1024, depth = 1024 }
operations = [
  { kind = "spawn", seat = 0, position = { x = 512, z = 500 } },
  { kind = "spawn", seat = 1, position = { x = 512, z = 524 } },
  { kind = "loot_container", position = { x = 510, z = 512 }, inventory = ["minecraft:apple"] }
]
`;

const worldPlanV2FixtureMap = `
schema = 2
name = "fixture"
terrain = "vanilla"
dimensions = { width = 1024, depth = 1024 }
operations = [
  { kind = "spawn", seat = 0, position = { x = 0, z = 0 } },
  { kind = "loot_container", position = { x = 2, z = 2 }, inventory = ["minecraft:apple"] }
]
`;

test('world-plan-v1 preserves the Java MapPlanReader field shape and canonical arrays', async () => {
  const map = compileMap(fixtureMap);
  const encoded = encodeWorldPlanV1('fixture-run', map);
  const fixture = JSON.parse(await readFile(worldPlanFixture, 'utf8')) as object;

  assert.equal(encoded.toString('utf8'), JSON.stringify(fixture));
  assert.equal(JSON.parse(encoded.toString('utf8')).map_semantic_id, map.semanticId);
});

test('world-plan-v1 rejects run identifiers outside the Java schema', () => {
  const map = compileMap(fixtureMap);

  assert.throws(() => encodeWorldPlanV1('-invalid', map), (error: unknown) => {
    assert.ok(error instanceof WorldPlanError);
    assert.equal(error.kind, 'invalid_run_id');
    return true;
  });
});

test('world-plan-v1 rejects sparse spawn seats instead of normalizing them', () => {
  const map = compileMap(fixtureMap.replace('seat = 0', 'seat = 2'));

  assert.throws(() => encodeWorldPlanV1('fixture-run', map), (error: unknown) => {
    assert.ok(error instanceof WorldPlanError);
    assert.equal(error.kind, 'noncontiguous_spawn_seats');
    return true;
  });
});

test('world-plan-v1 rejects natural maps instead of inventing surface heights', () => {
  const map = compileMap(naturalFixtureMap);

  assert.throws(() => encodeWorldPlanV1('fixture-run', map), (error: unknown) => {
    assert.ok(error instanceof WorldPlanError);
    assert.equal(error.kind, 'unsupported_terrain');
    return true;
  });
});
test('world-plan-v2 matches the Java fixture and canonical natural-map semantic ID', async () => {
  const map = compileMap(worldPlanV2FixtureMap);
  if (map.terrain !== 'vanilla') assert.fail('natural map required');
  const encoded = encodeWorldPlanV2('fixture-run', 18_446_744_073_709_551_615n, map);
  const fixture = JSON.parse(await readFile(join(repositoryRoot, 'tests/fixtures/world-plan/world-plan-v2.json'), 'utf8')) as object;

  assert.equal(map.semanticId, '873116af0230b7c6f7ba3eeb1a999ebc3952d15ab771a77f5da12959ed8d126b');
  assert.equal(encoded.toString('utf8'), JSON.stringify(fixture));
});

test('world-plan-v2 dispatch preserves schema 1 and rejects non-u64 seeds', () => {
  const planned = compileMap(fixtureMap);
  const natural = compileMap(worldPlanV2FixtureMap);
  assert.equal(encodeWorldPlan('fixture-run', 4n, planned).toString('utf8'),
    encodeWorldPlanV1('fixture-run', planned).toString('utf8'));
  if (natural.terrain !== 'vanilla') assert.fail('natural map required');

  assert.throws(() => encodeWorldPlanV2('fixture-run', 18_446_744_073_709_551_616n, natural),
    (error: unknown) => error instanceof WorldPlanError && error.kind === 'invalid_world_seed');
});

test('world-plan-v2 rejects natural footprints outside the fixed world dimensions', () => {
  const map = compileMap(worldPlanV2FixtureMap.replace('width = 1024, depth = 1024', 'width = 64, depth = 64'));
  if (map.terrain !== 'vanilla') assert.fail('natural map required');

  assert.throws(() => encodeWorldPlanV2('fixture-run', 4n, map),
    (error: unknown) => error instanceof WorldPlanError && error.kind === 'invalid_natural_dimensions');
});
