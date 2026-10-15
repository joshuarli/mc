import {
  agentObservation,
  assertValidatedAgentObservation,
  legacyAgentObservation,
  type AgentObservation,
  type AgentObservationInput,
  type AgentState,
  type Knowledge,
} from './observation.js';
import {
  PolicyParams,
  openingPolicyContext,
  openingStyleCycle,
  policyFeedbackBatch,
  policyMemory,
  policyMemoryV1,
  type PolicyMemory,
  type PolicyMemoryInput,
  type PolicyMemoryInputV1,
  type PolicyFeedback,
  type PolicyFeedbackBatch,
  type PolicyParamValues,
  type OpeningPolicyContext,
  type OpeningPolicyState,
  type OpeningStyle,
  type OpeningStyleCycle,
} from './policy.js';
import { DeterministicRandom } from './random.js';

const U64_MAX = 0xffff_ffff_ffff_ffffn;

export interface PolicyReplayInputV1 {
  readonly schema: 'policy-input-v1';
  readonly observation: AgentObservationInput;
  readonly memory: PolicyMemoryInputV1;
  readonly params: PolicyParamValues;
  readonly rng_state: string;
}

export interface PolicyReplayInputV2 {
  readonly schema: 'policy-input-v2';
  readonly observation: AgentObservationInput;
  readonly memory: PolicyMemoryInput;
  readonly feedback: readonly PolicyFeedback[];
  readonly params: PolicyParamValues;
  readonly rng_state: string;
}

export interface PolicyReplayInputV3 {
  readonly schema: 'policy-input-v3';
  readonly observation: AgentObservationInput;
  readonly memory: PolicyMemoryInput;
  readonly feedback: readonly PolicyFeedback[];
  readonly params: PolicyParamValues;
  readonly opening: Readonly<{
    readonly seed: string;
    readonly style: OpeningStyle;
    readonly cycle: OpeningStyleCycle;
    readonly state: OpeningPolicyState;
  }>;
  readonly rng_state: string;
}

export interface PolicyReplayInputV4 {
  readonly schema: 'policy-input-v4';
  readonly observation: AgentObservationInput;
  readonly memory: PolicyMemoryInput;
  readonly feedback: readonly PolicyFeedback[];
  readonly params: PolicyParamValues;
  readonly opening: PolicyReplayInputV3['opening'] | null;
  readonly rng_state: string;
}

export interface PolicyReplayInputV5 extends Omit<PolicyReplayInputV4, 'schema'> {
  readonly schema: 'policy-input-v5';
}

export interface RehydratedPolicyReplayInputV4 {
  readonly schema: 'policy-input-v4';
  readonly observation: AgentObservation;
  readonly memory: PolicyMemory;
  readonly feedback: readonly PolicyFeedback[];
  readonly params: PolicyParams;
  readonly opening: RehydratedPolicyReplayInputV3['opening'] | null;
  readonly random: DeterministicRandom;
}

export interface RehydratedPolicyReplayInputV5 extends Omit<RehydratedPolicyReplayInputV4, 'schema'> {
  readonly schema: 'policy-input-v5';
}

export interface RehydratedPolicyReplayInputV1 {
  readonly schema: 'policy-input-v1';
  readonly observation: AgentObservation;
  readonly memory: PolicyMemoryInputV1;
  readonly params: PolicyParams;
  readonly random: DeterministicRandom;
}

export interface RehydratedPolicyReplayInputV2 {
  readonly schema: 'policy-input-v2';
  readonly observation: AgentObservation;
  readonly memory: PolicyMemory;
  readonly feedback: readonly PolicyFeedback[];
  readonly params: PolicyParams;
  readonly random: DeterministicRandom;
}

export interface RehydratedPolicyReplayInputV3 {
  readonly schema: 'policy-input-v3';
  readonly observation: AgentObservation;
  readonly memory: PolicyMemory;
  readonly feedback: readonly PolicyFeedback[];
  readonly params: PolicyParams;
  readonly opening: Readonly<{
    readonly seed: bigint;
    readonly style: OpeningStyle;
    readonly cycle: OpeningStyleCycle;
    readonly state: OpeningPolicyState;
  }>;
  readonly random: DeterministicRandom;
}

export type RehydratedPolicyReplayInput =
  | RehydratedPolicyReplayInputV1
  | RehydratedPolicyReplayInputV2
  | RehydratedPolicyReplayInputV3
  | RehydratedPolicyReplayInputV4
  | RehydratedPolicyReplayInputV5;

export type PolicyReplayInputErrorCode =
  | 'invalid-shape'
  | 'unsupported-schema'
  | 'invalid-unicode'
  | 'unsafe-number'
  | 'invalid-rng-state'
  | 'invalid-observation'
  | 'invalid-memory'
  | 'invalid-feedback'
  | 'invalid-opening'
  | 'invalid-params';

export class PolicyReplayInputError extends TypeError {
  readonly code: PolicyReplayInputErrorCode;
  readonly field: string;

  constructor(code: PolicyReplayInputErrorCode, field: string, cause?: unknown) {
    if (cause === undefined) {
      super(`${field} is invalid: ${code}`);
    } else {
      super(`${field} is invalid: ${code}`, { cause });
    }
    this.code = code;
    this.field = field;
    this.name = 'PolicyReplayInputError';
  }
}

export interface PolicyReplayInputSource {
  readonly observation: AgentObservation;
  readonly memory: PolicyMemory;
  readonly feedback: readonly PolicyFeedback[];
  readonly params: PolicyParams;
  readonly random: DeterministicRandom;
}

export interface OpeningPolicyReplayInputSource extends PolicyReplayInputSource {
  readonly opening: Readonly<{
    readonly seed: bigint;
    readonly style: OpeningStyle;
    readonly cycle: OpeningStyleCycle;
    readonly state: OpeningPolicyState;
  }>;
}

/** Captures v2 decision inputs with the RNG state from before the decision. */
export function normalizePolicyReplayInput(source: PolicyReplayInputSource): PolicyReplayInputV2 {
  assertValidatedAgentObservation(source.observation);
  const observation = stripS2ObservationFields(source.observation);
  const memory = policyMemory(source.memory);
  const params = PolicyParams.create(source.params.values).values;

  return Object.freeze({
    schema: 'policy-input-v2',
    observation,
    memory,
    feedback: policyFeedbackBatch(source.feedback),
    params,
    rng_state: source.random.snapshotState().toString(10),
  });
}

export function normalizePolicyReplayInputV4(source: PolicyReplayInputSource): PolicyReplayInputV4 {
  const base = normalizePolicyReplayInput(source);
  return Object.freeze({
    schema: 'policy-input-v4',
    observation: base.observation,
    memory: base.memory,
    feedback: base.feedback,
    params: base.params,
    opening: null,
    rng_state: base.rng_state,
  });
}

export function normalizeOpeningPolicyReplayInputV4(source: OpeningPolicyReplayInputSource): PolicyReplayInputV4 {
  const base = normalizeOpeningPolicyReplayInput(source);
  return Object.freeze({
    schema: 'policy-input-v4',
    observation: base.observation,
    memory: base.memory,
    feedback: base.feedback,
    params: base.params,
    opening: base.opening,
    rng_state: base.rng_state,
  });
}

export function normalizePolicyReplayInputV5(source: PolicyReplayInputSource): PolicyReplayInputV5 {
  const base = normalizePolicyReplayInputV4(source);
  return Object.freeze({
    ...base,
    schema: 'policy-input-v5',
    observation: addS2ObservationFields(source.observation),
  });
}

export function normalizeOpeningPolicyReplayInputV5(source: OpeningPolicyReplayInputSource): PolicyReplayInputV5 {
  const base = normalizeOpeningPolicyReplayInputV4(source);
  return Object.freeze({
    ...base,
    schema: 'policy-input-v5',
    observation: addS2ObservationFields(source.observation),
  });
}

export function normalizeOpeningPolicyReplayInput(source: OpeningPolicyReplayInputSource): PolicyReplayInputV3 {
  const base = normalizePolicyReplayInput(source);
  const opening = parseSection('invalid-opening', 'opening', () => normalizeOpening(source.opening));
  return Object.freeze({
    schema: 'policy-input-v3',
    observation: base.observation,
    memory: base.memory,
    feedback: base.feedback,
    params: base.params,
    opening,
    rng_state: base.rng_state,
  });
}

/** Rebuilds branded domain values from a parsed JSON-compatible replay input. */
export function rehydratePolicyReplayInput(value: unknown): RehydratedPolicyReplayInput {
  assertJsonTree(value, 'input', new Set());
  const input = readRecord(value, 'input');
  const schema = input.schema;
  if (schema === 'policy-input-v1') {
    assertExactFields(input, ['schema', 'observation', 'memory', 'params', 'rng_state'], 'input');
  } else if (schema === 'policy-input-v2') {
    assertExactFields(input, ['schema', 'observation', 'memory', 'feedback', 'params', 'rng_state'], 'input');
  } else if (schema === 'policy-input-v3' || schema === 'policy-input-v4' || schema === 'policy-input-v5') {
    assertExactFields(input, ['schema', 'observation', 'memory', 'feedback', 'params', 'opening', 'rng_state'], 'input');
  } else {
    throw new PolicyReplayInputError('unsupported-schema', 'input.schema');
  }

  const observation = parseSection('invalid-observation', 'observation', () => (
    schema === 'policy-input-v5'
      ? parseS2Observation(input.observation)
      : schema === 'policy-input-v4'
      ? parsePreS2Observation(input.observation)
      : legacyAgentObservation(input.observation as AgentObservationInput)
  ));
  if (schema !== 'policy-input-v4' && schema !== 'policy-input-v5'
      && Object.hasOwn(readRecord(input.memory, 'memory'), 'knowledge')) {
    throw new PolicyReplayInputError('invalid-memory', 'memory.knowledge');
  }
  const memory = schema === 'policy-input-v1'
    ? parseSection('invalid-memory', 'memory', () => policyMemoryV1(input.memory as PolicyMemoryInputV1))
    : parseSection('invalid-memory', 'memory', () => policyMemory(input.memory as PolicyMemoryInput));
  const params = parseSection('invalid-params', 'params', () => (
    PolicyParams.create(input.params as PolicyParamValues)
  ));
  const randomState = parseU64Decimal(input.rng_state, 'rng_state');
  const random = DeterministicRandom.fromState(randomState);
  if (schema === 'policy-input-v1') {
    return Object.freeze({ schema, observation, memory: memory as PolicyMemoryInputV1, params, random });
  }
  const feedback = parseSection('invalid-feedback', 'feedback', () => (
    policyFeedbackBatch(input.feedback as PolicyFeedbackBatch)
  ));
  if (schema === 'policy-input-v2') {
    return Object.freeze({ schema, observation, memory: memory as PolicyMemory, feedback, params, random });
  }
  if ((schema === 'policy-input-v4' || schema === 'policy-input-v5') && input.opening === null) {
    return Object.freeze({
      schema, observation, memory: memory as PolicyMemory, feedback, params, opening: null, random,
    });
  }
  const opening = parseSection('invalid-opening', 'opening', () => parseOpening(input.opening));
  return Object.freeze({ schema, observation, memory: memory as PolicyMemory, feedback, params, opening, random });
}

function addS2ObservationFields(source: AgentObservation): AgentObservationInput {
  const agent = mapKnowledge(source.agent, (state) => ({
    ...state,
    combatStatus: state.combatStatus ?? null,
    foodStacks: state.foodStacks.map((stack) => ({ ...stack, itemKind: stack.itemKind ?? 'unknown' })),
  }));
  return Object.freeze({
    tick: source.tick,
    sequence: source.sequence,
    agent,
    border: source.border,
    opponents: source.opponents,
    loot: source.loot,
  });
}

function stripS2ObservationFields(source: AgentObservation): AgentObservationInput {
  const agent = mapKnowledge(source.agent, (state) => {
    const { combatStatus: _combatStatus, ...legacyState } = state;
    return {
      ...legacyState,
      foodStacks: state.foodStacks.map((stack) => {
        const { itemKind: _itemKind, ...legacyStack } = stack;
        return legacyStack;
      }),
    };
  });
  return Object.freeze({
    tick: source.tick,
    sequence: source.sequence,
    agent,
    border: source.border,
    opponents: source.opponents,
    loot: source.loot,
  });
}

function mapKnowledge(
  knowledge: Knowledge<AgentState>,
  map: (state: AgentState) => AgentState,
): Knowledge<AgentState> {
  if (knowledge.kind === 'unknown') return knowledge;
  if (knowledge.kind === 'current') return Object.freeze({ kind: 'current', value: map(knowledge.value) });
  return Object.freeze({ kind: 'stale', value: map(knowledge.value), observedAt: knowledge.observedAt });
}

function parseS2Observation(value: unknown): AgentObservation {
  const input = readRecord(value, 'observation');
  assertExactFields(input, ['tick', 'sequence', 'agent', 'border', 'opponents', 'loot'], 'observation');
  const knowledge = readRecord(input.agent, 'observation.agent');
  if (knowledge.kind !== 'unknown') {
    const state = readRecord(knowledge.value, 'observation.agent.value');
    if (!Object.hasOwn(state, 'combatStatus')) throw new PolicyReplayInputError('invalid-observation', 'observation.agent.value.combatStatus');
    if (Array.isArray(state.foodStacks)) {
      for (const [index, entry] of state.foodStacks.entries()) {
        if (!Object.hasOwn(readRecord(entry, `observation.agent.value.foodStacks.${index}`), 'itemKind')) {
          throw new PolicyReplayInputError('invalid-observation', `observation.agent.value.foodStacks.${index}.itemKind`);
        }
      }
    }
  }
  return parseSection('invalid-observation', 'observation', () => agentObservation(value as AgentObservationInput));
}

function parsePreS2Observation(value: unknown): AgentObservation {
  const input = readRecord(value, 'observation');
  const agent = readRecord(input.agent, 'observation.agent');
  if (agent.kind !== 'unknown') {
    const state = readRecord(agent.value, 'observation.agent.value');
    if (Object.hasOwn(state, 'combatStatus')) {
      throw new PolicyReplayInputError('invalid-observation', 'observation.agent.value.combatStatus');
    }
    if (Array.isArray(state.foodStacks)) {
      for (const [index, entry] of state.foodStacks.entries()) {
        if (Object.hasOwn(readRecord(entry, `observation.agent.value.foodStacks.${index}`), 'itemKind')) {
          throw new PolicyReplayInputError('invalid-observation', `observation.agent.value.foodStacks.${index}.itemKind`);
        }
      }
    }
  }
  return parseSection('invalid-observation', 'observation', () => agentObservation(value as AgentObservationInput));
}

function normalizeOpening(input: OpeningPolicyReplayInputSource['opening']): PolicyReplayInputV3['opening'] {
  if (typeof input.seed !== 'bigint' || input.seed < 0n || input.seed > U64_MAX) {
    throw new RangeError('opening seed must be an unsigned 64-bit bigint');
  }
  const context = openingPolicyContext({ style: input.style, state: input.state });
  const cycle = openingStyleCycle(input.cycle);
  return Object.freeze({
    seed: input.seed.toString(10),
    style: context.style,
    cycle,
    state: context.state,
  });
}

function parseOpening(value: unknown): RehydratedPolicyReplayInputV3['opening'] {
  const opening = readRecord(value, 'opening');
  assertExactFields(opening, ['seed', 'style', 'cycle', 'state'], 'opening');
  const seed = parseU64Decimal(opening.seed, 'opening.seed');
  const style = opening.style;
  if (style !== 'explorer' && style !== 'scavenger' && style !== 'hunter') {
    throw new PolicyReplayInputError('invalid-opening', 'opening.style');
  }
  try {
    const cycle = openingStyleCycle(opening.cycle as OpeningStyleCycle);
    const context = openingPolicyContext({ style, state: opening.state as OpeningPolicyState });
    return Object.freeze({ seed, style, cycle, state: context.state });
  } catch (cause) {
    if (cause instanceof PolicyReplayInputError) throw cause;
    throw new PolicyReplayInputError('invalid-opening', 'opening', cause);
  }
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
  code: 'invalid-observation' | 'invalid-memory' | 'invalid-feedback' | 'invalid-opening' | 'invalid-params',
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
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new PolicyReplayInputError('invalid-unicode', field);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new PolicyReplayInputError('invalid-unicode', field);
    }
  }
}
