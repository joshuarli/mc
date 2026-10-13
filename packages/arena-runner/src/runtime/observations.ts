import { OwnedFilesError, readOwnedFile } from '../owned-files/index.js';
import { RunnerError } from '../errors.js';
import { parseStrictJson, strictJsonNumberToken, type StrictJsonValue } from '../control/strict-json.js';

const MAX_STATS_BYTES = 16 * 1024 * 1024;
const STATS_DIRECTORY = Buffer.from('/server/world/players/stats/', 'ascii');
const STATS_SUFFIX = Buffer.from('.json', 'ascii');

export interface PlayerIdentity {
  readonly username: string;
  readonly offlineUuid: string;
}

export interface StoppedPlayerStats extends PlayerIdentity {
  readonly status: 'present' | 'absent';
  readonly deaths: number | null;
  readonly playerKills: number | null;
}

/** Reads Minecraft statistics through the owned-files helper after the server has stopped. */
export async function readStoppedPlayerStats(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  runDirectoryPath: Buffer;
  players: readonly PlayerIdentity[];
  signal?: AbortSignal;
}>): Promise<readonly StoppedPlayerStats[]> {
  const results: StoppedPlayerStats[] = [];
  for (const player of options.players) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(player.offlineUuid)) {
      throw new RunnerError('runtime_failure', 'player statistics', { kind: 'invalid_offline_uuid' });
    }
    const relativePath = Buffer.concat([
      options.runDirectoryPath,
      STATS_DIRECTORY,
      Buffer.from(player.offlineUuid, 'ascii'),
      STATS_SUFFIX,
    ]);
    let bytes: Buffer;
    try {
      bytes = await readOwnedFile({
        helperPath: options.helperPath,
        ownedRoot: options.ownedRoot,
        relativePath,
        maxBytes: MAX_STATS_BYTES,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (error instanceof OwnedFilesError && error.category === 'not_found') {
        results.push(Object.freeze({
          ...player,
          status: 'absent',
          deaths: null,
          playerKills: null,
        }));
        continue;
      }
      throw mapStatsReadError(error);
    }

    const stats = parseStats(bytes);
    results.push(Object.freeze({
      ...player,
      status: 'present',
      deaths: readCounter(stats, 'minecraft:deaths'),
      playerKills: readCounter(stats, 'minecraft:player_kills'),
    }));
  }
  return Object.freeze(results);
}

function parseStats(bytes: Buffer): Readonly<Record<string, StrictJsonValue>> {
  let value: StrictJsonValue;
  try {
    value = parseStrictJson(bytes);
  } catch (error) {
    throw new RunnerError('corrupt_evidence', 'player statistics', {
      kind: error instanceof Error && 'code' in error ? String(error.code) : 'invalid_json',
    });
  }
  const root = asObject(value);
  const sections = asObject(root?.stats);
  if (root === undefined || sections === undefined) {
    throw new RunnerError('corrupt_evidence', 'player statistics', { kind: 'invalid_format' });
  }
  const customValue = sections['minecraft:custom'];
  if (customValue === undefined) return Object.freeze({});
  const custom = asObject(customValue);
  if (custom === undefined) {
    throw new RunnerError('corrupt_evidence', 'player statistics', { kind: 'invalid_format' });
  }
  return custom;
}

function readCounter(stats: Readonly<Record<string, StrictJsonValue>>, key: string): number {
  const value = stats[key];
  if (value === undefined) return 0;
  if (typeof value !== 'number') {
    throw new RunnerError('corrupt_evidence', 'player statistics', { kind: 'invalid_counter' });
  }
  const token = strictJsonNumberToken(stats, key);
  if (token === undefined || !/^(?:0|[1-9][0-9]*)$/.test(token)
      || !Number.isSafeInteger(value) || value < 0) {
    throw new RunnerError('corrupt_evidence', 'player statistics', { kind: 'invalid_counter' });
  }
  return value;
}

function asObject(value: StrictJsonValue | undefined): Readonly<Record<string, StrictJsonValue>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, StrictJsonValue>>
    : undefined;
}

function mapStatsReadError(error: unknown): RunnerError {
  if (!(error instanceof OwnedFilesError)) {
    return new RunnerError('runtime_failure', 'player statistics', { kind: 'read_failed' });
  }
  if (error.category === 'too_large' || error.category === 'unsupported_file_type' || error.category === 'symlink_rejected') {
    return new RunnerError('corrupt_evidence', 'player statistics', { kind: error.category });
  }
  const category = error.category === 'helper_start' ? 'missing_prerequisite' : 'runtime_failure';
  return new RunnerError(category, 'player statistics', {
    kind: error.category,
    ...(error.errno === undefined ? {} : { os_code: error.errno }),
  });
}
