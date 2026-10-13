import {
  InvalidPolicyParamsError,
  PolicyParams,
  type PolicyParameterVersion,
  type PolicyParamValues,
  type InvalidPolicyParamsCode,
} from "@arena/core";

import { CanonicalHasher, type SemanticId } from "./hash.js";
import { SpecError, SpecErrorKind } from "./errors.js";
import * as raw from "./raw.js";

const POLICY_FIELDS = [
  "version",
  "eat_at_hunger_or_below",
  "retreat_at_health_half_hearts_or_below",
  "border_margin_blocks",
  "fight_range_blocks",
  "opponent_memory_ticks",
  "loot_hysteresis_blocks",
  "search_radius_blocks",
] as const;
type PolicyValueField = Exclude<(typeof POLICY_FIELDS)[number], "version">;

const INVALID_PARAMETER_FIELDS: Readonly<Record<InvalidPolicyParamsCode, {
  readonly field: (typeof POLICY_FIELDS)[number];
  readonly kind: typeof SpecErrorKind.InvalidValue | typeof SpecErrorKind.Range;
  readonly message: string;
}>> = {
  "unsupported-version": {
    field: "version",
    kind: SpecErrorKind.InvalidValue,
    message: "only policy version 1 is supported",
  },
  "hunger-threshold-out-of-range": {
    field: "eat_at_hunger_or_below",
    kind: SpecErrorKind.Range,
    message: "value is outside the policy-supported range",
  },
  "retreat-threshold-out-of-range": {
    field: "retreat_at_health_half_hearts_or_below",
    kind: SpecErrorKind.Range,
    message: "value is outside the policy-supported range",
  },
  "border-margin-out-of-range": {
    field: "border_margin_blocks",
    kind: SpecErrorKind.Range,
    message: "value is outside the policy-supported range",
  },
  "fight-range-out-of-range": {
    field: "fight_range_blocks",
    kind: SpecErrorKind.Range,
    message: "value is outside the policy-supported range",
  },
  "opponent-memory-out-of-range": {
    field: "opponent_memory_ticks",
    kind: SpecErrorKind.Range,
    message: "value is outside the policy-supported range",
  },
  "loot-hysteresis-out-of-range": {
    field: "loot_hysteresis_blocks",
    kind: SpecErrorKind.Range,
    message: "value is outside the policy-supported range",
  },
  "search-radius-out-of-range": {
    field: "search_radius_blocks",
    kind: SpecErrorKind.Range,
    message: "value is outside the policy-supported range",
  },
};

/** Validated baseline policy parameters with a canonical parameter identity. */
export interface PolicyIr {
  readonly version: PolicyParameterVersion;
  readonly params: PolicyParams;
  readonly semanticId: SemanticId;
}

/** Compiles schema-v1 TOML into immutable, core-validated policy parameters. */
export function compilePolicy(source: string): PolicyIr {
  const root = raw.asTable(raw.parseDocument(source, "policy"), "policy");
  raw.checkFields(root, POLICY_FIELDS, POLICY_FIELDS, "policy");

  const version = integerField(root, "version");
  if (version !== 1n) {
    throw new SpecError(
      SpecErrorKind.InvalidValue,
      "policy.version",
      "only policy version 1 is supported",
      root.get("version")?.sourceLocation,
    );
  }

  const exactValues = {
    eatAtHungerOrBelow: integerField(root, "eat_at_hunger_or_below"),
    retreatAtHealthHalfHeartsOrBelow: integerField(root, "retreat_at_health_half_hearts_or_below"),
    borderMarginBlocks: integerField(root, "border_margin_blocks"),
    fightRangeBlocks: integerField(root, "fight_range_blocks"),
    opponentMemoryTicks: integerField(root, "opponent_memory_ticks"),
    lootHysteresisBlocks: integerField(root, "loot_hysteresis_blocks"),
    searchRadiusBlocks: integerField(root, "search_radius_blocks"),
  };
  const values: PolicyParamValues = {
    version: 1,
    eatAtHungerOrBelow: Number(exactValues.eatAtHungerOrBelow),
    retreatAtHealthHalfHeartsOrBelow: Number(exactValues.retreatAtHealthHalfHeartsOrBelow),
    borderMarginBlocks: Number(exactValues.borderMarginBlocks),
    fightRangeBlocks: Number(exactValues.fightRangeBlocks),
    opponentMemoryTicks: Number(exactValues.opponentMemoryTicks),
    lootHysteresisBlocks: Number(exactValues.lootHysteresisBlocks),
    searchRadiusBlocks: Number(exactValues.searchRadiusBlocks),
  };

  let params: PolicyParams;
  try {
    params = PolicyParams.create(values);
  } catch (error) {
    if (!(error instanceof InvalidPolicyParamsError)) throw error;
    const failure = INVALID_PARAMETER_FIELDS[error.code];
    throw new SpecError(
      failure.kind,
      `policy.${failure.field}`,
      failure.message,
      root.get(failure.field)?.sourceLocation,
      error,
    );
  }

  const exactFields: readonly (readonly [PolicyValueField, bigint])[] = [
    ["eat_at_hunger_or_below", exactValues.eatAtHungerOrBelow],
    ["retreat_at_health_half_hearts_or_below", exactValues.retreatAtHealthHalfHeartsOrBelow],
    ["border_margin_blocks", exactValues.borderMarginBlocks],
    ["fight_range_blocks", exactValues.fightRangeBlocks],
    ["opponent_memory_ticks", exactValues.opponentMemoryTicks],
    ["loot_hysteresis_blocks", exactValues.lootHysteresisBlocks],
    ["search_radius_blocks", exactValues.searchRadiusBlocks],
  ];
  const inexactValue = exactFields.find(([, value]) => !Number.isSafeInteger(Number(value)));
  if (inexactValue !== undefined) {
    const field = inexactValue[0];
    throw new SpecError(
      SpecErrorKind.Range,
      `policy.${field}`,
      "integer cannot be represented exactly by policy parameters",
      root.get(field)?.sourceLocation,
    );
  }

  return Object.freeze({
    version: 1,
    params,
    semanticId: hashPolicy(params),
  });
}

function integerField(table: raw.RawTable, key: (typeof POLICY_FIELDS)[number]): bigint {
  const path = `policy.${key}`;
  const value = raw.field(table, key, "policy");
  if (value.kind !== "integer") {
    throw new SpecError(SpecErrorKind.InvalidValue, path, "must be a TOML integer", table.get(key)?.sourceLocation);
  }
  return value.value;
}

function hashPolicy(params: PolicyParams): SemanticId {
  const { values } = params;
  const hash = new CanonicalHasher("arena.policy.ir.v1\0");
  hash.u8(values.version);
  hash.u8(values.eatAtHungerOrBelow);
  hash.u8(values.retreatAtHealthHalfHeartsOrBelow);
  hash.u8(values.borderMarginBlocks);
  hash.u8(values.fightRangeBlocks);
  hash.u8(values.opponentMemoryTicks);
  hash.u8(values.lootHysteresisBlocks);
  hash.u8(values.searchRadiusBlocks);
  return hash.finish();
}
