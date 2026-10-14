import { RunnerError } from '../errors.js';
import { canonicalJson } from '../canonical.js';
import { createOwnedDirectory, OwnedFilesError, readOwnedFile, stageOwnedFile } from '../owned-files/index.js';
import type { HeldoutLedgerEntry, LeagueStore, StoredMatch } from './harness.js';

const MAX_RECORD_BYTES = 1024 * 1024;
const LEDGER_DIRECTORY = 'evaluation/heldout-ledger';

export class OwnedLeagueStore implements LeagueStore {
  readonly #helperPath: string;
  readonly #ownedRoot: Buffer;
  readonly #directory: string;
  #prepared = false;

  constructor(options: Readonly<{ helperPath: string; ownedRoot: Buffer; leagueId: string }>) {
    this.#helperPath = options.helperPath;
    this.#ownedRoot = options.ownedRoot;
    this.#directory = `.work/arena/league/${options.leagueId}`;
  }

  async readMatch(matchId: string): Promise<StoredMatch | undefined> {
    const bytes = await this.#read(`${this.#directory}/matches/${matchId}.json`);
    if (bytes === undefined) return undefined;
    return parseJson(bytes, 'league match record') as StoredMatch;
  }

  async writeMatch(match: StoredMatch): Promise<void> {
    await this.#ensureDirectories();
    await this.#stage(`${this.#directory}/matches/${match.match_id}.json`, canonicalJson(match));
  }

  async readLedger(seeds: readonly number[]): Promise<readonly HeldoutLedgerEntry[]> {
    const entries: HeldoutLedgerEntry[] = [];
    for (const seed of seeds) {
      const bytes = await this.#read(`${LEDGER_DIRECTORY}/${seed}.json`);
      if (bytes === undefined) continue;
      const parsed = parseJson(bytes, 'held-out ledger') as Partial<HeldoutLedgerEntry>;
      if (parsed.seed !== seed || typeof parsed.set !== 'string' || typeof parsed.league !== 'string'
          || typeof parsed.candidate_set_digest !== 'string') {
        throw new RunnerError('corrupt_evidence', 'held-out ledger', { kind: 'invalid_ledger_entry', field: String(seed) });
      }
      entries.push(parsed as HeldoutLedgerEntry);
    }
    return entries;
  }

  async appendLedger(entries: readonly HeldoutLedgerEntry[]): Promise<void> {
    await this.#ensureDirectories();
    for (const entry of entries) {
      await this.#stage(`${LEDGER_DIRECTORY}/${entry.seed}.json`, canonicalJson(entry));
    }
  }

  async writeReport(report: object): Promise<string> {
    await this.#ensureDirectories();
    for (let index = 1; index < 10_000; index += 1) {
      const path = `${this.#directory}/report-${String(index).padStart(4, '0')}.json`;
      try {
        await this.#stage(path, canonicalJson(report));
        return path;
      } catch (error) {
        if (error instanceof OwnedFilesError && error.category === 'conflict') continue;
        throw error;
      }
    }
    throw new RunnerError('runtime_failure', 'league report', { kind: 'report_index_exhausted' });
  }

  async #ensureDirectories(): Promise<void> {
    if (this.#prepared) return;
    for (const path of [`${this.#directory}/matches`, LEDGER_DIRECTORY]) {
      try {
        await createOwnedDirectory({ helperPath: this.#helperPath, ownedRoot: this.#ownedRoot, relativePath: Buffer.from(path) });
      } catch (error) {
        if (!(error instanceof OwnedFilesError) || error.category !== 'conflict') throw error;
      }
    }
    this.#prepared = true;
  }

  async #stage(path: string, contents: string): Promise<void> {
    await stageOwnedFile({
      helperPath: this.#helperPath, ownedRoot: this.#ownedRoot, relativePath: Buffer.from(path),
      contents: Buffer.from(contents, 'utf8'), maxBytes: MAX_RECORD_BYTES,
    });
  }

  async #read(path: string): Promise<Buffer | undefined> {
    try {
      return await readOwnedFile({
        helperPath: this.#helperPath, ownedRoot: this.#ownedRoot, relativePath: Buffer.from(path), maxBytes: MAX_RECORD_BYTES,
      });
    } catch (error) {
      if (error instanceof OwnedFilesError && error.category === 'not_found') return undefined;
      throw error;
    }
  }
}

function parseJson(bytes: Buffer, resource: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new RunnerError('corrupt_evidence', resource, { kind: 'invalid_json' });
  }
}
