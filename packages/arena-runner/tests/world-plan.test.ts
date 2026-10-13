import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { compileMap } from '@arena/spec';
import { encodeWorldPlanV1, WorldPlanError } from '../src/world-plan.js';

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
