import { CANDIDATE_IDS, InvalidCandidateError, validateCandidateParams, type CandidateId } from '@arena/core';
import { RunnerError } from '../errors.js';
import { parseTomlSubset, type TomlTable, type TomlValue } from './toml-subset.js';

export type SeedRole = 'regression' | 'development' | 'heldout';

export interface SeedSet {
  readonly name: string;
  readonly role: SeedRole;
  readonly first: number;
  readonly last: number;
}

export interface SeedManifest {
  readonly sets: readonly SeedSet[];
}

export interface CandidateSpec {
  readonly id: CandidateId;
  readonly params: Readonly<Record<string, number>>;
}

export interface OpponentSpec extends CandidateSpec {
  readonly label: string;
}

export type CandidateEntry =
  | Readonly<{ kind: 'inline'; spec: CandidateSpec }>
  | Readonly<{ kind: 'profile'; path: string }>;

export interface LeagueManifestDraft extends Omit<LeagueManifest, 'candidates' | 'opponents'> {
  readonly candidateEntries: readonly CandidateEntry[];
  readonly opponentEntries: readonly CandidateEntry[];
}

export interface LeagueManifest {
  readonly id: string;
  readonly scenario: string;
  readonly seeds: string;
  readonly seedSet: string;
  readonly candidates: readonly CandidateSpec[];
  readonly opponents: readonly OpponentSpec[];
  readonly analysis: Readonly<{ method: 'bootstrap' | 'tInterval'; resamples: number; bootstrapSeed: number }>;
  readonly promotion: Readonly<{
    minMean: number;
    minLowerBound: number;
    maxSurvivalRegression: number;
    maxAttackIssueRegression: number;
    minAttacksForGate: number;
  }>;
}

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function parseSeedManifest(source: string): SeedManifest {
  const resource = 'seed manifest';
  const root = parseTomlSubset(source, resource);
  exact(root, ['schema', 'set'], ['schema', 'set'], resource);
  if (root.schema !== 1) throw invalid(resource, 'unsupported_schema');
  const entries = list(root.set, resource, 'set');
  const names = new Set<string>();
  const sets: SeedSet[] = [];
  const seen = new Map<number, string>();
  for (const entry of entries) {
    const table = asTable(entry, resource, 'set');
    exact(table, ['name', 'role', 'first', 'last'], ['name', 'role', 'first', 'last'], resource);
    const name = string(table.name, resource, 'name');
    if (!ID.test(name) || names.has(name)) throw invalid(resource, 'invalid_set_name');
    names.add(name);
    if (table.role !== 'regression' && table.role !== 'development' && table.role !== 'heldout') {
      throw invalid(resource, 'invalid_role');
    }
    const first = integer(table.first, resource, 'first');
    const last = integer(table.last, resource, 'last');
    if (first < 0 || last < first || last - first >= 1024) throw invalid(resource, 'invalid_seed_range');
    for (let seed = first; seed <= last; seed += 1) {
      const owner = seen.get(seed);
      if (owner !== undefined) throw invalid(resource, 'seed_in_two_sets');
      seen.set(seed, name);
    }
    sets.push(Object.freeze({ name, role: table.role, first, last }));
  }
  return Object.freeze({ sets: Object.freeze(sets) });
}

export function seedsOf(set: SeedSet): readonly number[] {
  return Array.from({ length: set.last - set.first + 1 }, (_, index) => set.first + index);
}

export function parseLeagueManifest(source: string): LeagueManifestDraft {
  const resource = 'league manifest';
  const root = parseTomlSubset(source, resource);
  exact(root, ['schema', 'id', 'scenario', 'seeds', 'seed_set', 'candidate', 'opponent', 'analysis', 'promotion'],
    ['schema', 'id', 'scenario', 'seeds', 'seed_set', 'candidate', 'opponent', 'analysis', 'promotion'], resource);
  if (root.schema !== 1) throw invalid(resource, 'unsupported_schema');
  const id = string(root.id, resource, 'id');
  if (!ID.test(id)) throw invalid(resource, 'invalid_id');
  const candidateEntries = list(root.candidate, resource, 'candidate').map((entry) => candidateEntry(entry, resource));
  const opponentEntries = list(root.opponent, resource, 'opponent').map((entry) => candidateEntry(entry, resource));
  if (candidateEntries.length === 0 || candidateEntries.length > 5) throw invalid(resource, 'candidate_count');
  if (opponentEntries.length === 0 || opponentEntries.length > 6) throw invalid(resource, 'opponent_count');

  const analysis = asTable(root.analysis, resource, 'analysis');
  exact(analysis, ['method', 'confidence', 'resamples', 'bootstrap_seed'], ['method', 'confidence'], resource);
  if (analysis.method !== 'bootstrap' && analysis.method !== 'tInterval') throw invalid(resource, 'invalid_analysis_method');
  if (analysis.confidence !== 0.95) throw invalid(resource, 'unsupported_confidence');
  const resamples = analysis.resamples === undefined ? 2000 : integer(analysis.resamples, resource, 'resamples');
  if (resamples < 200 || resamples > 20_000) throw invalid(resource, 'invalid_resamples');
  const bootstrapSeed = analysis.bootstrap_seed === undefined ? 1 : integer(analysis.bootstrap_seed, resource, 'bootstrap_seed');

  const promotion = asTable(root.promotion, resource, 'promotion');
  exact(promotion, ['min_mean', 'min_lower_bound', 'max_survival_regression', 'max_attack_issue_regression',
    'min_attacks_for_gate'], ['min_mean', 'min_lower_bound', 'max_survival_regression', 'max_attack_issue_regression',
    'min_attacks_for_gate'], resource);
  const fraction = (value: TomlValue | undefined, name: string): number => {
    if (typeof value !== 'number' || value < 0 || value > 1) throw invalid(resource, `invalid_${name}`);
    return value;
  };
  return Object.freeze({
    id,
    scenario: string(root.scenario, resource, 'scenario'),
    seeds: string(root.seeds, resource, 'seeds'),
    seedSet: string(root.seed_set, resource, 'seed_set'),
    candidateEntries: Object.freeze(candidateEntries),
    opponentEntries: Object.freeze(opponentEntries),
    analysis: Object.freeze({ method: analysis.method, resamples, bootstrapSeed }),
    promotion: Object.freeze({
      minMean: fraction(promotion.min_mean, 'min_mean'),
      minLowerBound: fraction(promotion.min_lower_bound, 'min_lower_bound'),
      maxSurvivalRegression: fraction(promotion.max_survival_regression, 'max_survival_regression'),
      maxAttackIssueRegression: fraction(promotion.max_attack_issue_regression, 'max_attack_issue_regression'),
      minAttacksForGate: integer(promotion.min_attacks_for_gate, resource, 'min_attacks_for_gate'),
    }),
  });
}

export function resolveLeagueManifest(
  draft: LeagueManifestDraft,
  profiles: ReadonlyMap<string, CandidateSpec>,
): LeagueManifest {
  const resource = 'league manifest';
  const resolve = (entry: CandidateEntry): CandidateSpec => {
    if (entry.kind === 'inline') return entry.spec;
    const spec = profiles.get(entry.path);
    if (spec === undefined) throw invalid(resource, 'candidate_profile_missing');
    return spec;
  };
  const candidates = draft.candidateEntries.map(resolve);
  const opponents = draft.opponentEntries.map((entry) => {
    const spec = resolve(entry);
    return Object.freeze({ ...spec, label: opponentLabel(spec) });
  });
  const labels = candidates.map(opponentLabel);
  if (new Set(labels).size !== labels.length) throw invalid(resource, 'duplicate_candidate');
  const opponentLabels = opponents.map((opponent) => opponent.label);
  if (new Set(opponentLabels).size !== opponentLabels.length) throw invalid(resource, 'duplicate_opponent');
  if (!opponents.some((opponent) => opponent.id === 'baseline')) throw invalid(resource, 'frozen_baseline_missing');
  const { candidateEntries: _candidates, opponentEntries: _opponents, ...rest } = draft;
  return Object.freeze({ ...rest, candidates: Object.freeze(candidates), opponents: Object.freeze(opponents) });
}

export function profileSpec(profile: Readonly<{ id: CandidateId; params: Readonly<Record<string, number>> }>): CandidateSpec {
  return Object.freeze({ id: profile.id, params: Object.freeze({ ...profile.params }) });
}

export function opponentLabel(spec: CandidateSpec): string {
  const entries = Object.entries(spec.params).sort(([a], [b]) => a < b ? -1 : 1);
  return entries.length === 0 ? spec.id : `${spec.id}+${entries.map(([name, value]) => `${name}=${value}`).join(',')}`;
}

function candidateEntry(value: TomlValue, resource: string): CandidateEntry {
  const table = asTable(value, resource, 'candidate');
  if (Object.hasOwn(table, 'profile')) {
    exact(table, ['profile'], ['profile'], resource);
    return Object.freeze({ kind: 'profile', path: string(table.profile, resource, 'profile') });
  }
  return Object.freeze({ kind: 'inline', spec: candidateSpec(table, resource) });
}

function candidateSpec(table: TomlTable, resource: string): CandidateSpec {
  exact(table, ['id', 'params'], ['id'], resource);
  const id = string(table.id, resource, 'id');
  if (!(CANDIDATE_IDS as readonly string[]).includes(id)) throw invalid(resource, 'unknown_candidate');
  const params: Record<string, number> = {};
  if (table.params !== undefined) {
    for (const [name, entry] of Object.entries(asTable(table.params, resource, 'params'))) {
      if (typeof entry !== 'number') throw invalid(resource, 'invalid_parameter');
      params[name] = entry;
    }
  }
  try {
    validateCandidateParams(id as CandidateId, params);
  } catch (error) {
    if (error instanceof InvalidCandidateError) throw invalid(resource, error.code);
    throw error;
  }
  return Object.freeze({ id: id as CandidateId, params: Object.freeze(params) });
}

function exact(table: TomlTable, allowed: readonly string[], required: readonly string[], resource: string): void {
  for (const key of Object.keys(table)) if (!allowed.includes(key)) throw invalid(resource, 'unknown_field');
  for (const key of required) if (!Object.hasOwn(table, key)) throw invalid(resource, 'missing_field');
}

function list(value: TomlValue | undefined, resource: string, field: string): readonly TomlValue[] {
  if (!Array.isArray(value)) throw invalid(resource, `invalid_${field}`);
  return value;
}

function asTable(value: TomlValue | undefined, resource: string, field: string): TomlTable {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(resource, `invalid_${field}`);
  }
  return value as TomlTable;
}

function string(value: TomlValue | undefined, resource: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw invalid(resource, `invalid_${field}`);
  return value;
}

function integer(value: TomlValue | undefined, resource: string, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalid(resource, `invalid_${field}`);
  return value;
}

function invalid(resource: string, kind: string): RunnerError {
  return new RunnerError('invalid_input', resource, { kind });
}
