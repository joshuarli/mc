import { RunnerError } from '../errors.js';

export interface BenchWorld {
  readonly seed: number;
  readonly level: number;
  readonly authoritativeMaxTicks: number;
}

export const BENCH_VIEW_DISTANCE_CHUNKS = 4;
export const BENCH_SIMULATION_DISTANCE_CHUNKS = 3;

export function benchSpawnColumns(level: number): readonly { readonly x: number; readonly z: number }[] {
  if (!Number.isSafeInteger(level) || level < 1 || level > 256) {
    throw new RunnerError('invalid_input', 'bench level', { kind: 'invalid_bench_level' });
  }
  const columns = Math.ceil(Math.sqrt(level));
  const spacing = Math.max(8, Math.min(48, Math.floor(640 / Math.max(1, columns - 1))));
  const origin = 512 - Math.floor((columns - 1) * spacing / 2);
  return Array.from({ length: level }, (_, seat) => ({
    x: origin + (seat % columns) * spacing,
    z: origin + Math.floor(seat / columns) * spacing,
  }));
}

export function benchMapSource(world: BenchWorld): string {
  const spawns = benchSpawnColumns(world.level);
  const lines = ['schema = 2', `name = "bench-${world.level}"`, 'terrain = "vanilla"',
    'dimensions = { width = 1024, depth = 1024 }', ''];
  for (const [seat, column] of spawns.entries()) {
    lines.push('[[operations]]', 'kind = "spawn"', `seat = ${seat}`, `position = { x = ${column.x}, z = ${column.z} }`, '');
  }
  const containers = Math.max(2, Math.floor(world.level / 2));
  for (let index = 0; index < containers; index += 1) {
    const base = spawns[index % spawns.length]!;
    lines.push('[[operations]]', 'kind = "loot_container"',
      `position = { x = ${base.x + 4 + (index % 3)}, z = ${base.z + 3 + (index % 2)} }`,
      'inventory = ["minecraft:bread", "minecraft:stone_sword"]', '');
  }
  return lines.join('\n');
}

export function benchScenarioSource(template: string, world: BenchWorld, mapPath: string, policyPath: string): string {
  const replacements: readonly [RegExp, string][] = [
    [/^name = ".*"$/m, `name = "bench-${world.level}"`],
    [/^seed = \d+$/m, `seed = ${world.seed}`],
    [/^map = ".*"$/m, `map = "${mapPath}"`],
    [/^policy = ".*"$/m, `policy = "${policyPath}"`],
    [/^competitors = \d+$/m, `competitors = ${world.level}`],
    [/^spectator_capacity = \d+$/m, 'spectator_capacity = 0'],
    [/^view_distance_chunks = \d+$/m, `view_distance_chunks = ${BENCH_VIEW_DISTANCE_CHUNKS}`],
    [/^simulation_distance_chunks = \d+$/m, `simulation_distance_chunks = ${BENCH_SIMULATION_DISTANCE_CHUNKS}`],
    [/^countdown_ticks = \d+$/m, 'countdown_ticks = 100'],
    [/^grace_ticks = \d+$/m, 'grace_ticks = 200'],
    [/^authoritative_max_ticks = \d+$/m, `authoritative_max_ticks = ${world.authoritativeMaxTicks}`],
    [/^initial_diameter_blocks = \d+$/m, 'initial_diameter_blocks = 1000'],
    [/^shrink_start_tick = \d+$/m, `shrink_start_tick = ${world.authoritativeMaxTicks - 400}`],
    [/^shrink_end_tick = \d+$/m, `shrink_end_tick = ${world.authoritativeMaxTicks - 20}`],
    [/^final_diameter_blocks = \d+$/m, 'final_diameter_blocks = 64'],
  ];
  let text = template;
  for (const [pattern, replacement] of replacements) {
    if (text.match(new RegExp(pattern.source, 'gm'))?.length !== 1) {
      throw new RunnerError('invalid_input', 'bench scenario', { kind: 'scenario_field_not_unique' });
    }
    text = text.replace(pattern, replacement);
  }
  return text;
}
