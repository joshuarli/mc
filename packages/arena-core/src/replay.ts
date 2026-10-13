import {
  agentObservation,
  assertValidatedAgentObservation,
  type AgentObservation,
  type AgentObservationInput,
} from './observation.js';
import {
  PolicyParams,
  policyMemory,
  type PolicyMemory,
  type PolicyMemoryInput,
  type PolicyParamValues,
} from './policy.js';
import { DeterministicRandom } from './random.js';

const U64_MAX = 0xffff_ffff_ffff_ffffn;

export interface PolicyReplayInputV1 {
  readonly schema: 'policy-input-v1';
  readonly observation: AgentObservationInput;
  readonly memory: PolicyMemoryInput;
  readonly params: PolicyParamValues;
  readonly rng_state: string;
}

export interface RehydratedPolicyReplayInput {
  readonly observation: AgentObservation;
  readonly memory: PolicyMemory;
  readonly params: PolicyParams;
  readonly random: DeterministicRandom;
}

export type PolicyReplayInputErrorCode =
  | 'invalid-shape'
  | 'unsupported-schema'
  | 'invalid-unicode'
  | 'unsafe-number'
  | 'invalid-rng-state'
  | 'invalid-observation'
  | 'invalid-memory'
  | 'invalid-params';

export class PolicyReplayInputError extends TypeError {
  constructor(readonly code: PolicyReplayInputErrorCode, readonly field: string, cause?: unknown) {
    if (cause === undefined) {
      super(`${field} is invalid: ${code}`);
    } else {
      super(`${field} is invalid: ${code}`, { cause });
    }
    this.name = 'PolicyReplayInputError';
  }
}

export interface PolicyReplayInputSource {
  readonly observation: AgentObservation;
  readonly memory: PolicyMemory;
  readonly params: PolicyParams;
  readonly random: DeterministicRandom;
}

/** Captures the validated decision inputs with the RNG state from before the decision. */
export function normalizePolicyReplayInput(source: PolicyReplayInputSource): PolicyReplayInputV1 {
  assertValidatedAgentObservation(source.observation);
  const observation: AgentObservationInput = Object.freeze({
    tick: source.observation.tick,
    sequence: source.observation.sequence,
    agent: source.observation.agent,
    border: source.observation.border,
    opponents: source.observation.opponents,
    loot: source.observation.loot,
  });
  const memory = policyMemory(source.memory);
  const params = PolicyParams.create(source.params.values).values;

  return Object.freeze({
    schema: 'policy-input-v1',
    observation,
    memory,
    params,
    rng_state: source.random.snapshotState().toString(10),
  });
}

/** Rebuilds branded domain values from a parsed JSON-compatible replay input. */
export function rehydratePolicyReplayInput(value: unknown): RehydratedPolicyReplayInput {
  assertJsonTree(value, 'input', new Set());
  const input = readRecord(value, 'input');
  assertExactFields(input, ['schema', 'observation', 'memory', 'params', 'rng_state'], 'input');

  if (input.schema !== 'policy-input-v1') {
    throw new PolicyReplayInputError('unsupported-schema', 'input.schema');
  }

  const observation = parseSection('invalid-observation', 'observation', () => (
    agentObservation(input.observation as AgentObservationInput)
  ));
  const memory = parseSection('invalid-memory', 'memory', () => (
    policyMemory(input.memory as PolicyMemoryInput)
  ));
  const params = parseSection('invalid-params', 'params', () => (
    PolicyParams.create(input.params as PolicyParamValues)
  ));
  const randomState = parseU64Decimal(input.rng_state, 'rng_state');

  return Object.freeze({ observation, memory, params, random: DeterministicRandom.fromState(randomState) });
}

function parseU64Decimal(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new PolicyReplayInputError('invalid-rng-state', field);
  }
  const state = BigInt(value);
  if (state > U64_MAX) {
    throw new PolicyReplayInputError('invalid-rng-state', field);
  }
  return state;
}

function parseSection<T>(
  code: 'invalid-observation' | 'invalid-memory' | 'invalid-params',
  field: string,
  parse: () => T,
): T {
  try {
    return parse();
  } catch (cause) {
    if (cause instanceof PolicyReplayInputError) {
      throw cause;
    }
    throw new PolicyReplayInputError(code, field, cause);
  }
}

function readRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PolicyReplayInputError('invalid-shape', field);
  }
  return value as Record<string, unknown>;
}

function assertExactFields(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new PolicyReplayInputError('invalid-shape', field);
  }
}

function assertJsonTree(value: unknown, field: string, seen: Set<object>): void {
  if (value === null || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'string') {
    assertWellFormedUnicode(value, field);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new PolicyReplayInputError('unsafe-number', field);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new PolicyReplayInputError('invalid-shape', field);
  }
  if (seen.has(value)) {
    throw new PolicyReplayInputError('invalid-shape', field);
  }
  seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new PolicyReplayInputError('invalid-shape', field);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes('length')) {
      throw new PolicyReplayInputError('invalid-shape', field);
    }
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        throw new PolicyReplayInputError('invalid-shape', `${field}[${index}]`);
      }
      assertJsonTree(descriptor.value, `${field}[${index}]`, seen);
    }
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PolicyReplayInputError('invalid-shape', field);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new PolicyReplayInputError('invalid-shape', field);
    }
    assertWellFormedUnicode(key, field);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new PolicyReplayInputError('invalid-shape', `${field}.${key}`);
    }
    assertJsonTree(descriptor.value, `${field}.${key}`, seen);
  }
}

function assertWellFormedUnicode(value: string, field: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new PolicyReplayInputError('invalid-unicode', field);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new PolicyReplayInputError('invalid-unicode', field);
    }
  }
}
