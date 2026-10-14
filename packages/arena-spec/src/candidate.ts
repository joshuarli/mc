import {
  CANDIDATE_IDS,
  CANDIDATE_PARAMETER_RANGES,
  CANDIDATE_TUNABLES,
  InvalidCandidateError,
  candidateSemanticId,
  candidateVersion,
  validateCandidateParams,
  type CandidateId,
  type CandidateParamValues,
  type CandidateTunable,
} from "@arena/core";

import { SpecError, SpecErrorKind } from "./errors.js";
import * as raw from "./raw.js";

const PARAMETER_KEYS: Readonly<Record<CandidateTunable, string>> = Object.freeze({
  eatAtHungerOrBelow: "eat_at_hunger_or_below",
  retreatAtHealthHalfHeartsOrBelow: "retreat_at_health_half_hearts_or_below",
  borderMarginBlocks: "border_margin_blocks",
  fightRangeBlocks: "fight_range_blocks",
  opponentMemoryTicks: "opponent_memory_ticks",
  lootHysteresisBlocks: "loot_hysteresis_blocks",
  searchRadiusBlocks: "search_radius_blocks",
  lootFirstRangeBlocks: "loot_first_range_blocks",
  kiteRangeBlocks: "kite_range_blocks",
});

const ROOT_FIELDS = ["schema", "candidate", "version", "parameters"] as const;
const PARAMETER_FIELDS = CANDIDATE_TUNABLES.map((name) => PARAMETER_KEYS[name]);

/** A validated league candidate profile: registry parameters and the registry's semantic identity. */
export interface CandidateProfileIr {
  readonly id: CandidateId;
  readonly version: number;
  readonly params: CandidateParamValues;
  readonly semanticId: string;
}

/** Compiles a schema-1 `policies/candidates/<id>.toml` source against the core candidate registry. */
export function compileCandidateProfile(source: string): CandidateProfileIr {
  const root = raw.asTable(raw.parseDocument(source, "candidate"), "candidate");
  raw.checkFields(root, ROOT_FIELDS, ROOT_FIELDS, "candidate");

  const schema = raw.integer(raw.field(root, "schema", "candidate"), "candidate.schema");
  if (schema !== 1n) {
    throw new SpecError(SpecErrorKind.InvalidValue, "candidate.schema", "only candidate schema 1 is supported",
      root.get("schema")?.sourceLocation);
  }
  const idText = raw.string(raw.field(root, "candidate", "candidate"), "candidate.candidate");
  const id = CANDIDATE_IDS.find((candidate) => candidate === idText);
  if (id === undefined) {
    throw new SpecError(SpecErrorKind.InvalidValue, "candidate.candidate", `unknown candidate \`${idText}\``,
      root.get("candidate")?.sourceLocation);
  }
  const version = raw.integer(raw.field(root, "version", "candidate"), "candidate.version");
  if (version !== BigInt(candidateVersion(id))) {
    throw new SpecError(SpecErrorKind.InvalidValue, "candidate.version",
      `candidate \`${id}\` is registered at version ${candidateVersion(id)}`, root.get("version")?.sourceLocation);
  }

  const table = raw.asTable(raw.field(root, "parameters", "candidate"), "candidate.parameters");
  raw.checkFields(table, PARAMETER_FIELDS, PARAMETER_FIELDS, "candidate.parameters");
  const values: Partial<Record<CandidateTunable, number>> = {};
  for (const name of CANDIDATE_TUNABLES) {
    const key = PARAMETER_KEYS[name];
    const path = `candidate.parameters.${key}`;
    const value = raw.integer(raw.field(table, key, "candidate.parameters"), path);
    const range = CANDIDATE_PARAMETER_RANGES[name];
    if (value < BigInt(range.min) || value > BigInt(range.max)) {
      throw new SpecError(SpecErrorKind.Range, path, `must be between ${range.min} and ${range.max}`,
        table.get(key)?.sourceLocation);
    }
    values[name] = Number(value);
  }

  let params: CandidateParamValues;
  try {
    params = validateCandidateParams(id, values);
  } catch (error) {
    if (!(error instanceof InvalidCandidateError)) throw error;
    throw new SpecError(SpecErrorKind.InvalidValue, "candidate.parameters",
      `candidate \`${id}\` does not accept these parameters: ${error.message}`, undefined, error);
  }
  return Object.freeze({ id, version: candidateVersion(id), params, semanticId: candidateSemanticId(id, params) });
}
