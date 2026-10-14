import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  CANDIDATE_IDS,
  candidateDefaults,
  candidateSemanticId,
  candidateVersion,
  type CandidateId,
} from "@arena/core";
import { SpecError, SpecErrorKind, compileCandidateProfile } from "../src/index.js";

const profile = (id: string): string => readFileSync(resolve(process.cwd(), `policies/candidates/${id}.toml`), "utf8");
const TACTICAL = CANDIDATE_IDS.filter((id) => id !== "baseline");

test("candidate_profiles_match_the_registry_defaults_and_semantic_ids", () => {
  assert.equal(TACTICAL.length, 4);
  for (const id of TACTICAL) {
    const compiled = compileCandidateProfile(profile(id));
    assert.equal(compiled.id, id);
    assert.equal(compiled.version, candidateVersion(id));
    assert.deepEqual(compiled.params, candidateDefaults(id));
    assert.equal(compiled.semanticId, candidateSemanticId(id, candidateDefaults(id)));
  }
});

test("candidate_profile_applies_tuned_parameters_and_changes_identity", () => {
  const tuned = compileCandidateProfile(
    profile("ranged-kiter").replace("kite_range_blocks = 3", "kite_range_blocks = 2"),
  );
  assert.equal(tuned.params.kiteRangeBlocks, 2);
  assert.notEqual(tuned.semanticId, candidateSemanticId("ranged-kiter", candidateDefaults("ranged-kiter")));
});

test("candidate_profile_rejects_unknown_ids_keys_versions_and_out_of_range_values", () => {
  const base = profile("melee-duelist");
  const reject = (source: string, path: string, kind?: SpecErrorKind): void => {
    const error = specError(() => compileCandidateProfile(source));
    assert.equal(error.path, path, source);
    if (kind !== undefined) assert.equal(error.kind, kind);
  };
  reject(base.replace('candidate = "melee-duelist"', 'candidate = "berserker"'), "candidate.candidate", SpecErrorKind.InvalidValue);
  reject(base.replace("schema = 1", "schema = 2"), "candidate.schema", SpecErrorKind.InvalidValue);
  reject(base.replace("version = 1", "version = 2"), "candidate.version", SpecErrorKind.InvalidValue);
  reject(base.replace("fight_range_blocks = 7", "fight_range_blocks = 9"), "candidate.parameters.fight_range_blocks", SpecErrorKind.Range);
  reject(base.replace("fight_range_blocks = 7\n", ""), "candidate.parameters.fight_range_blocks", SpecErrorKind.MissingField);
  reject(base + "extra_knob = 1\n", "candidate.parameters.extra_knob", SpecErrorKind.UnknownField);
  reject(base.replace("[parameters]", "extra = 1\n\n[parameters]"), "candidate.extra", SpecErrorKind.UnknownField);
  reject(base.replace("search_radius_blocks = 8", 'search_radius_blocks = "8"'), "candidate.parameters.search_radius_blocks", SpecErrorKind.InvalidValue);
});

test("candidate_profile_rejects_tactical_knobs_on_the_frozen_baseline", () => {
  const baseline = profile("melee-duelist").replace('candidate = "melee-duelist"', 'candidate = "baseline"');
  const error = specError(() => compileCandidateProfile(baseline));
  assert.equal(error.kind, SpecErrorKind.InvalidValue);
  const id: CandidateId = "baseline";
  const defaults = candidateDefaults(id);
  const accepted = compileCandidateProfile(`schema = 1\ncandidate = "baseline"\nversion = 1\n\n[parameters]\n${
    Object.entries({
      eat_at_hunger_or_below: defaults.eatAtHungerOrBelow,
      retreat_at_health_half_hearts_or_below: defaults.retreatAtHealthHalfHeartsOrBelow,
      border_margin_blocks: defaults.borderMarginBlocks,
      fight_range_blocks: defaults.fightRangeBlocks,
      opponent_memory_ticks: defaults.opponentMemoryTicks,
      loot_hysteresis_blocks: defaults.lootHysteresisBlocks,
      search_radius_blocks: defaults.searchRadiusBlocks,
      loot_first_range_blocks: defaults.lootFirstRangeBlocks,
      kite_range_blocks: defaults.kiteRangeBlocks,
    }).map(([key, value]) => `${key} = ${value}`).join("\n")}\n`);
  assert.equal(accepted.id, "baseline");
});

function specError(operation: () => unknown): SpecError {
  try {
    operation();
  } catch (error) {
    if (error instanceof SpecError) return error;
    throw error;
  }
  assert.fail("expected a specification error");
}
