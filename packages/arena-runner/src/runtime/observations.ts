import { MAX_OWNED_READ_BYTES, OwnedFilesError, readOwnedFile } from '../owned-files/index.js';
import { RunnerError } from '../errors.js';
import { parseStrictJson, strictJsonNumberToken, type StrictJsonValue } from '../control/strict-json.js';

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

export interface StoppedPlayerStatsFile {
  readonly stats: StoppedPlayerStats;
  readonly contents: Buffer | null;
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
    const file = await readStoppedPlayerStatsFile({
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      runDirectoryPath: options.runDirectoryPath,
      player,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    results.push(file.stats);
  }
  return Object.freeze(results);
}

/** Reads and validates one stopped stats file while retaining its exact bytes for archival. */
export async function readStoppedPlayerStatsFile(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  runDirectoryPath: Buffer;
  player: PlayerIdentity;
  signal?: AbortSignal;
}>): Promise<StoppedPlayerStatsFile> {
  const { player } = options;
  const relativePath = stoppedPlayerStatsPath(options.runDirectoryPath, player.offlineUuid);
  let contents: Buffer;
  try {
    contents = await readOwnedFile({
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      relativePath,
      maxBytes: MAX_OWNED_READ_BYTES,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (error instanceof OwnedFilesError && error.category === 'not_found') {
      return Object.freeze({
        stats: Object.freeze({
          ...player,
          status: 'absent',
          deaths: null,
          playerKills: null,
        }),
        contents: null,
      });
    }
    throw mapStatsReadError(error);
  }

  const stats = parseStats(contents);
  return Object.freeze({
    stats: Object.freeze({
      ...player,
      status: 'present',
      deaths: readCounter(stats, 'minecraft:deaths'),
      playerKills: readCounter(stats, 'minecraft:player_kills'),
    }),
    contents,
  });
}

export function stoppedPlayerStatsPath(runDirectoryPath: Buffer, offlineUuid: string): Buffer {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(offlineUuid)) {
    throw new RunnerError('runtime_failure', 'player statistics', { kind: 'invalid_offline_uuid' });
  }
  return Buffer.concat([
    runDirectoryPath,
    STATS_DIRECTORY,
    Buffer.from(offlineUuid, 'ascii'),
    STATS_SUFFIX,
  ]);
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
