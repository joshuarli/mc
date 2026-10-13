import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import type { Bot } from 'mineflayer';
import type { MineflayerArenaClient } from '@arena/bots';
import { LivePolicyLoop } from '../src/runtime/live-policy-loop.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { basename, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  agentObservation,
  agentState,
  blockPosition,
  currentKnowledge,
  decide,
  decidePolicyReplayV1,
  type PolicyReplayInputV1,
  DeterministicRandom,
  emptyEquipment,
  emptyPolicyMemory,
  normalizePolicyReplayInput,
  observationSequence,
  PolicyParams,
  rehydratePolicyReplayInput,
  tick,
  unknownKnowledge,
  worldBorder,
} from '@arena/core';
import {
  decodeControlFrame,
  encodeControlFrame,
  type ControlMessage,
} from '../src/control/index.js';
import { canonicalJson } from '../src/canonical.js';
import { RunnerError } from '../src/errors.js';
import { createRunDirectory, readOwnedFile } from '../src/owned-files/index.js';
import { makePolicyEffectRecord, replayPolicyJson } from '../src/policy-replay.js';
import { parseSegment } from '../src/trace.js';
import { failureArtifactPath, parseOperationalFailureArtifact, readOperationalFailureArtifact } from '../src/runtime/failure-artifact.js';
import { RuntimeTraceBuilder } from '../src/runtime/trace.js';
import {
  bindControlListener,
  createControlToken,
  type ControlSession,
} from '../src/runtime/session.js';

const RUN_ID = 'runtime-trace-test';
const CAPABILITIES = ['hunger_games_v1'] as const;
const repositoryRoot = basename(process.cwd()) === 'arena-runner' ? resolve(process.cwd(), '../..') : process.cwd();
const helperPath = process.env.ARENA_FS_HELPER ?? resolve(repositoryRoot, '.work/arena-fs/arena-fs');

test('runtime trace retains authenticated lifecycle events and stages schema-2 evidence', async (t) => {
  const { session, client, token } = await authenticatedSession(t);
  const { trace, ownedRoot } = await createTrace(t);
  await trace.recordReady(session.ready);
  const prepare = await session.send({ type: 'prepare', payload: preparePayload() });
  await trace.recordRunnerCommand(prepare);

  client.write(Buffer.concat([
    frame({
      protocol: 1,
      run_id: RUN_ID,
      sequence: 3n,
      correlation: prepare.sequence,
      type: 'ack',
      payload: {},
    }),
    frame({
      protocol: 1,
      run_id: RUN_ID,
      sequence: 4n,
      type: 'outcome',
      payload: { kind: 'abort', reason: 'operator', survivors: [0], at: null },
    }),
  ]));
  const messages = session.messages();
  for (let count = 0; count < 2; count += 1) {
    const message = await messages.next();
    assert.equal(message.done, false);
    await trace.recordControlMessage(message.value!);
  }

  const finalized = await trace.finalize();
  assert.equal(finalized.segments.length, 1);
  assert.equal(finalized.totalByteLength, finalized.segments[0]!.byteLength);
  assert.equal(finalized.segments[0]!.relativePath.toString('utf8'), 'run/trace-v2-000001.json');
  const bytes = await readOwnedFile({
    helperPath,
    ownedRoot,
    relativePath: finalized.segments[0]!.relativePath,
    maxBytes: finalized.segments[0]!.byteLength,
  });
  const segment = parseSegment(bytes);
  assert.equal(segment.runId, RUN_ID);
  assert.equal(segment.firstSequence, 1n);
  assert.equal(segment.lastSequence, 4n);
  assert.deepEqual(segment.records.map((record) => [record.direction, record.type]), [
    ['plugin', 'ready'],
    ['runner', 'prepare'],
    ['plugin', 'ack'],
    ['plugin', 'outcome'],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(segment.records[0])), {
    direction: 'plugin',
    protocol: 1,
    run_id: RUN_ID,
    sequence: '2',
    correlation: '1',
    type: 'ready',
    payload: session.ready.payload,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(segment.records[1])), {
    direction: 'runner',
    protocol: 1,
    run_id: RUN_ID,
    sequence: '2',
    type: 'prepare',
    payload: JSON.parse(JSON.stringify(preparePayload(), (_key: string, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value)),
  });
  assert.equal(bytes.toString('utf8').includes(token), false);
  assert.equal(bytes.toString('utf8').includes('hello'), false);
  assert.deepEqual(await trace.finalize(), finalized);
  await assert.rejects(trace.recordControlMessage(clockMessage(5n, 'aborted')), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'trace_finalized');
});

test('runtime trace checkpoints persist earlier segments and hold the outcome until finalize', async (t) => {
  const { session, client } = await authenticatedSession(t);
  const { trace, ownedRoot } = await createTrace(t);
  await trace.recordReady(session.ready);
  const prepare = await session.send({ type: 'prepare', payload: preparePayload() });
  await trace.recordRunnerCommand(prepare);

  await trace.checkpoint(200);
  const firstPath = Buffer.from('run/trace-v2-000001.json', 'ascii');
  const firstBytes = await readOwnedFile({ helperPath, ownedRoot, relativePath: firstPath, maxBytes: 1024 * 1024 });
  const first = parseSegment(firstBytes);
  assert.deepEqual(first.records.map((record) => record.type), ['ready', 'prepare']);

  client.write(Buffer.concat([
    frame({
      protocol: 1,
      run_id: RUN_ID,
      sequence: 3n,
      correlation: prepare.sequence,
      type: 'ack',
      payload: {},
    }),
    frame({
      protocol: 1,
      run_id: RUN_ID,
      sequence: 4n,
      type: 'outcome',
      payload: { kind: 'abort', reason: 'operator', survivors: [0], at: null },
    }),
  ]));
  const messages = session.messages();
  await trace.recordControlMessage((await messages.next()).value!);
  await trace.recordControlMessage((await messages.next()).value!);

  const result = await trace.finalize();
  assert.equal(result.segments.length, 2);
  assert.deepEqual(result.segments.map((segment) => segment.relativePath.toString('utf8')), [
    'run/trace-v2-000001.json',
    'run/trace-v2-000002.json',
  ]);
  const finalBytes = await readOwnedFile({
    helperPath,
    ownedRoot,
    relativePath: result.segments[1]!.relativePath,
    maxBytes: 1024 * 1024,
  });
  assert.deepEqual(parseSegment(finalBytes).records.map((record) => record.type), ['ack', 'outcome']);
});

test('runtime trace persists actual pending records in a strict operational failure artifact', async (t) => {
  const { session, client } = await authenticatedSession(t);
  const runDirectoryPath = Buffer.from(`.work/arena/runs/${RUN_ID}`, 'ascii');
  const { trace, ownedRoot } = await createTrace(t, runDirectoryPath);
  await trace.recordReady(session.ready);
  const prepare = await session.send({ type: 'prepare', payload: preparePayload() });
  await trace.recordRunnerCommand(prepare);
  await trace.checkpoint(200);

  client.write(frame({
    protocol: 1,
    run_id: RUN_ID,
    sequence: 3n,
    type: 'public_clock',
    payload: { phase: 'waiting', tick: null, border_diameter_blocks: 100 },
  }));
  const clock = (await session.messages().next()).value!;
  await trace.recordControlMessage(clock);
  const persisted = await trace.persistFailurePartial(
    {
      category: 'runtime_failure',
      resource: 'Paper server',
      source: { kind: 'control_ready_timeout' },
    },
    { status: 'succeeded', source: null },
  );

  const failurePath = failureArtifactPath(RUN_ID);
  assert.deepEqual(persisted.artifactPath, failurePath);
  const artifact = await readOperationalFailureArtifact({ helperPath, ownedRoot, runId: RUN_ID });
  assert.deepEqual(artifact, {
    schema: 1,
    run_id: RUN_ID,
    primary: {
      category: 'runtime_failure',
      resource: 'Paper server',
      source: { kind: 'control_ready_timeout' },
    },
    cleanup: { status: 'succeeded', source: null },
    trace_checkpoint_segments: [
      {
        path: Buffer.concat([runDirectoryPath, Buffer.from('/trace-v2-000001.json', 'ascii')]).toString('ascii'),
        identity: persisted.artifact.trace_checkpoint_segments[0]!.identity,
        byte_length: persisted.artifact.trace_checkpoint_segments[0]!.byte_length,
      },
      {
        path: Buffer.concat([runDirectoryPath, Buffer.from('/trace-v2-000002.json', 'ascii')]).toString('ascii'),
        identity: persisted.artifact.trace_checkpoint_segments[1]!.identity,
        byte_length: persisted.artifact.trace_checkpoint_segments[1]!.byte_length,
      },
    ],
  });
  const pendingPath = Buffer.concat([runDirectoryPath, Buffer.from('/trace-v2-000002.json', 'ascii')]);
  const pendingBytes = await readOwnedFile({ helperPath, ownedRoot, relativePath: pendingPath, maxBytes: 1024 * 1024 });
  assert.deepEqual(parseSegment(pendingBytes).records.map((record) => record.type), ['public_clock']);
  assert.equal(persisted.artifact.trace_checkpoint_segments.length, 2);
});

test('operational failure artifact reader rejects unknown fields with its strict invalid label', () => {
  const artifact = {
    schema: 1,
    run_id: RUN_ID,
    primary: { category: 'runtime_failure', resource: 'Paper server', source: { kind: 'timeout' } },
    cleanup: { status: 'succeeded', source: null },
    trace_checkpoint_segments: [],
    unexpected: true,
  };
  assert.throws(() => parseOperationalFailureArtifact(JSON.stringify(artifact), RUN_ID), (error: unknown) =>
    error instanceof RunnerError
      && error.category === 'corrupt_evidence'
      && error.source.kind === 'invalid_operational_failure_artifact');
});

test('operational failure artifact reader rejects rounded fractional integers and oversized identities', () => {
  const artifact = (schema: string, byteLength: string, device = '1') =>
    `{"schema":${schema},"run_id":"${RUN_ID}","primary":{"category":"runtime_failure","resource":"Paper server","source":{"kind":"timeout"}},"cleanup":{"status":"succeeded","source":null},"trace_checkpoint_segments":[{"path":".work/arena/runs/${RUN_ID}/trace-v2-000001.json","identity":{"device":"${device}","inode":"2"},"byte_length":${byteLength}}]}`;

  for (const [json, field] of [
    [artifact('1.00000000000000001', '1'), 'invalid_schema'],
    [artifact('1', '1.00000000000000001'), 'invalid_trace_checkpoint_segment'],
    [artifact('1', '1', '18446744073709551616'), 'invalid_trace_checkpoint_segment'],
  ] as const) {
    assert.throws(() => parseOperationalFailureArtifact(json, RUN_ID), (error: unknown) =>
      error instanceof RunnerError
        && error.category === 'corrupt_evidence'
        && error.source.kind === 'invalid_operational_failure_artifact'
        && error.source.field === field);
  }
});

test('runtime trace requires authenticated readiness and an authoritative outcome', async (t) => {
  const { session } = await authenticatedSession(t);
  const { trace } = await createTrace(t);
  await assert.rejects(trace.recordReady(readyEnvelope()), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'unauthenticated_readiness_envelope');

  const { trace: validTrace } = await createTrace(t);
  await validTrace.recordReady(session.ready);
  await assert.rejects(validTrace.finalize(), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'outcome_missing');
});

test('runtime trace rejects fabricated commands and plugin events', async (t) => {
  const { session } = await authenticatedSession(t);
  const { trace: unauthenticatedCommandTrace } = await createTrace(t);
  await unauthenticatedCommandTrace.recordReady(session.ready);
  await assert.rejects(unauthenticatedCommandTrace.recordRunnerCommand(prepareEnvelope()), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'unauthenticated_runner_command');

  const { trace: unauthenticatedEventTrace } = await createTrace(t);
  await unauthenticatedEventTrace.recordReady(session.ready);
  await assert.rejects(unauthenticatedEventTrace.recordControlMessage(clockMessage(3n, 'waiting')), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'unauthenticated_plugin_message');
});

test('runtime trace rejects checkpoints outside the 200-observation cadence', async (t) => {
  const { trace } = await createTrace(t);
  await assert.rejects(trace.checkpoint(400), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'invalid_trace_checkpoint');
});

test('runtime trace records a pending skill cancellation after authoritative outcome', async (t) => {
  const { session, client } = await authenticatedSession(t);
  const { trace, ownedRoot } = await createTrace(t);
  const messages = await beginOneSeatRun(trace, session, client);
  const decision = policyDecisionRecord(1n);
  await trace.recordPolicyDecision(decision);
  await endOneSeatRun(trace, session, client, messages);

  const effect = makePolicyEffectRecord(BigInt(decision.sequence), { kind: 'cancelled', reason: 'shutdown' }, []);
  await trace.recordPolicyEffect(effect);
  await trace.checkpoint(200);
  await trace.checkpoint(400);
  const finalized = await trace.finalize();
  assert.equal(finalized.segments.length, 1);
  const records: string[] = [];
  for (const segment of finalized.segments) {
    const bytes = await readOwnedFile({
      helperPath,
      ownedRoot,
      relativePath: segment.relativePath,
      maxBytes: segment.byteLength,
    });
    records.push(...parseSegment(bytes).records.map((record) => record.schema === 'policy-effect-v1'
      ? 'policy-effect-v1'
      : typeof record.type === 'string' ? record.type : 'unknown'));
  }
  assert.equal(records.at(-2), 'outcome');
  assert.equal(records.at(-1), 'policy-effect-v1');
});

test('runtime trace rejects new decisions and unmatched effects after outcome', async (t) => {
  const first = await authenticatedSession(t);
  const firstTrace = await createTrace(t);
  const firstMessages = await beginOneSeatRun(firstTrace.trace, first.session, first.client);
  await endOneSeatRun(firstTrace.trace, first.session, first.client, firstMessages);
  await assert.rejects(
    firstTrace.trace.recordPolicyEffect(makePolicyEffectRecord(99n, { kind: 'cancelled', reason: 'shutdown' }, [])),
    (error: unknown) => error instanceof RunnerError && error.source.kind === 'unmatched_policy_effect',
  );

  const second = await authenticatedSession(t);
  const secondTrace = await createTrace(t);
  const secondMessages = await beginOneSeatRun(secondTrace.trace, second.session, second.client);
  await secondTrace.trace.recordPolicyDecision(policyDecisionRecord(1n));
  await endOneSeatRun(secondTrace.trace, second.session, second.client, secondMessages);
  await assert.rejects(
    secondTrace.trace.recordPolicyDecision(policyDecisionRecord(2n)),
    (error: unknown) => error instanceof RunnerError && error.source.kind === 'policy_decision_after_outcome',
  );

  const third = await authenticatedSession(t);
  const thirdTrace = await createTrace(t);
  const thirdMessages = await beginOneSeatRun(thirdTrace.trace, third.session, third.client);
  const decision = policyDecisionRecord(1n);
  await thirdTrace.trace.recordPolicyDecision(decision);
  await endOneSeatRun(thirdTrace.trace, third.session, third.client, thirdMessages);
  const effect = makePolicyEffectRecord(BigInt(decision.sequence), { kind: 'cancelled', reason: 'shutdown' }, []);
  await thirdTrace.trace.recordPolicyEffect(effect);
  await assert.rejects(
    thirdTrace.trace.recordPolicyEffect(effect),
    (error: unknown) => error instanceof RunnerError && error.source.kind === 'duplicate_policy_effect',
  );
});

test('runtime trace cannot finalize while a policy skill result is still pending', async (t) => {
  const { session, client } = await authenticatedSession(t);
  const { trace } = await createTrace(t);
  const messages = await beginOneSeatRun(trace, session, client);
  await trace.recordPolicyDecision(policyDecisionRecord(1n));
  await endOneSeatRun(trace, session, client, messages);
  await assert.rejects(trace.finalize(), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'policy_skill_result_pending');
});

test('live runtime persists exact decision watermarks with a pending effect and keeps outcome private until join', async (t) => {
  const { session, client } = await authenticatedSession(t);
  const { trace, ownedRoot } = await createTrace(t);
  const messages = await beginOneSeatRun(trace, session, client, 6);
  let finish!: (outcome: import('@arena/core').SkillOutcome) => void;
  const skill = new Promise<import('@arena/core').SkillOutcome>((resolve) => { finish = resolve; });
  const bot = Object.assign(new EventEmitter(), { health: 20, game: { gameMode: 'survival' } }) as unknown as Bot;
  const policyClient: MineflayerArenaClient = {
    observe: (value) => agentObservation({
      tick: tick(value), sequence: observationSequence(value + 1),
      agent: currentKnowledge(agentState({ position: blockPosition(99, 64, 0), healthHalfHearts: 40, hungerPoints: 20,
        foodStacks: [], equipped: emptyEquipment(), upgrades: [] })),
      border: currentKnowledge(worldBorder(0, 0, 100)), opponents: currentKnowledge([]), loot: unknownKnowledge(),
    }),
    run: () => skill,
    cancel: async (reason) => { finish({ kind: 'cancelled', reason }); },
    close: async () => {},
  };
  const failures: unknown[] = [];
  const loop = new LivePolicyLoop({ trace, params: PolicyParams.baseline(), seed: 1n, strategyIntervalTicks: 1n,
    recordPolicy: true, competitors: () => [
      { seat: 0, bot, client: policyClient },
      ...Array.from({ length: 5 }, (_, index) => ({ seat: index + 1,
        bot: Object.assign(new EventEmitter(), { health: 20, game: { gameMode: 'survival' } }) as unknown as Bot,
        client: { ...policyClient, run: async () => ({ kind: 'succeeded' as const }), cancel: async () => {} },
      })),
    ], fail: (error) => failures.push(error) });
  const flush = async (sequence: bigint) => {
    client.write(frame({ protocol: 1, run_id: RUN_ID, sequence, type: 'heartbeat', payload: {} }));
    await recordNextMessage(trace, messages);
  };
  for (let value = 0; value < 34; value += 1) loop.onTick(value);
  await flush(7n);
  const readSegment = async (index: number) => parseSegment(await readOwnedFile({ helperPath, ownedRoot,
    relativePath: Buffer.from(`run/trace-v2-${String(index).padStart(6, '0')}.json`), maxBytes: 1024 * 1024 }));
  const first = await readSegment(1);
  assert.equal(first.records.filter((record) => record.schema === 'policy-replay-v2').length, 200);
  assert.equal(first.records.some((record) => record.schema === 'policy-effect-v1'), false);
  for (let value = 34; value < 68; value += 1) loop.onTick(value);
  await flush(8n);
  const second = await readSegment(2);
  assert.equal(second.records.filter((record) => record.schema === 'policy-replay-v2').length, 200);
  assert.equal(second.records.some((record) => record.schema === 'policy-effect-v1' && record.decision_sequence === '1'), false);
  loop.stopLaunching();
  await endOneSeatRun(trace, session, client, messages, 9n, [0, 1, 2, 3, 4, 5]);
  await assert.rejects(readSegment(3));
  await loop.stopAndJoin();
  const result = await trace.finalize();
  assert.equal(result.segments.length, 3);
  const terminal = await readSegment(3);
  assert.deepEqual(terminal.records.filter((record) => record.schema === 'policy-effect-v1' && record.decision_sequence === '1').map((record) => canonicalJson(record.skill)),
    [canonicalJson({ kind: 'cancelled', reason: 'shutdown' })]);
  assert.equal(terminal.records.some((record) => record.type === 'outcome'), true);
  const records = [...first.records, ...second.records, ...terminal.records];
  assert.equal(records.some((record) => record.schema === 'policy-effect-v1' && record.decision_sequence !== '1'), true);
  const replay = replayPolicyJson({ run_id: RUN_ID, first_sequence: '1', last_sequence: String(records.length), segments: [], records });
  assert.equal(replay.decision_count, 408);
  assert.equal(replay.verified, true);
  assert.deepEqual(failures, []);
});

async function createTrace(t: TestContext, runDirectoryPath = Buffer.from('run', 'ascii')): Promise<Readonly<{
  trace: RuntimeTraceBuilder;
  ownedRoot: Buffer;
}>> {
  const ownedRoot = await readTestRootForTrace(t);
  await createRunDirectory({ helperPath, ownedRoot, relativePath: runDirectoryPath });
  return Object.freeze({
    trace: new RuntimeTraceBuilder({
      runId: RUN_ID,
      helperPath,
      ownedRoot,
      preparedRun: { runId: RUN_ID, runDirectoryPath },
    }),
    ownedRoot,
  });
}

async function readTestRootForTrace(t: TestContext): Promise<Buffer> {
  const root = await mkdtemp(join(repositoryRoot, '.work/tmp/runtime-trace-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return Buffer.from(root, 'utf8');
}

async function authenticatedSession(t: TestContext): Promise<Readonly<{
  session: ControlSession;
  client: Socket;
  token: string;
}>> {
  const token = createControlToken();
  const listener = await bindControlListener({ runId: RUN_ID, token, capabilities: CAPABILITIES });
  const client = createConnection({ host: '127.0.0.1', port: listener.address.port });
  const reader = new TestFrameReader(client);
  let session: ControlSession | undefined;
  t.after(async () => {
    client.destroy();
    await session?.close();
    await listener.close();
  });

  const accepting = listener.accept();
  await once(client, 'connect');
  client.write(frame({
    protocol: 1,
    run_id: RUN_ID,
    sequence: 1n,
    type: 'hello',
    payload: { token, capabilities: CAPABILITIES },
  }));
  const acknowledgment = decodeControlFrame(await reader.readFrame());
  assert.equal(acknowledgment.type, 'ack');
  if (acknowledgment.type !== 'ack') throw new Error('expected hello acknowledgment');
  client.write(frame({
    ...readyEnvelope(),
    correlation: acknowledgment.sequence,
  }));
  session = await accepting;
  return Object.freeze({ session, client, token });
}

async function beginOneSeatRun(
  trace: RuntimeTraceBuilder,
  session: ControlSession,
  client: Socket,
  seats = 1,
): Promise<AsyncGenerator<ControlMessage>> {
  await trace.recordReady(session.ready);
  const messages = session.messages();
  const prepare = await session.send({ type: 'prepare', payload: preparePayload(seats) });
  await trace.recordRunnerCommand(prepare);
  client.write(frame({
    protocol: 1,
    run_id: RUN_ID,
    sequence: 3n,
    correlation: prepare.sequence,
    type: 'ack',
    payload: {},
  }));
  await recordNextMessage(trace, messages);

  const start = await session.send({ type: 'start', payload: {} });
  await trace.recordRunnerCommand(start);
  client.write(frame({
    protocol: 1,
    run_id: RUN_ID,
    sequence: 4n,
    correlation: start.sequence,
    type: 'ack',
    payload: {},
  }));
  await recordNextMessage(trace, messages);

  client.write(Buffer.concat([
    frame({
      protocol: 1,
      run_id: RUN_ID,
      sequence: 5n,
      type: 'public_clock',
      payload: { phase: 'active', tick: { domain: 'match', value: 0n }, border_diameter_blocks: 100 },
    }),
    frame({
      protocol: 1,
      run_id: RUN_ID,
      sequence: 6n,
      type: 'public_state',
      payload: { at: { domain: 'match', value: 0n }, alive_seats: Array.from({ length: seats }, (_, seat) => seat) },
    }),
  ]));
  await recordNextMessage(trace, messages);
  await recordNextMessage(trace, messages);
  return messages;
}

async function endOneSeatRun(
  trace: RuntimeTraceBuilder,
  session: ControlSession,
  client: Socket,
  messages: AsyncGenerator<ControlMessage>,
  firstSequence = 7n,
  survivors = [0],
): Promise<void> {
  const abort = await session.send({ type: 'abort', payload: { reason: 'operator' } });
  await trace.recordRunnerCommand(abort);
  client.write(Buffer.concat([
    frame({
      protocol: 1,
      run_id: RUN_ID,
      sequence: firstSequence,
      correlation: abort.sequence,
      type: 'ack',
      payload: {},
    }),
    frame({
      protocol: 1,
      run_id: RUN_ID,
      sequence: firstSequence + 1n,
      type: 'public_clock',
      payload: { phase: 'aborted', tick: { domain: 'match', value: 0n }, border_diameter_blocks: 100 },
    }),
    frame({
      protocol: 1,
      run_id: RUN_ID,
      sequence: firstSequence + 2n,
      type: 'outcome',
      payload: { kind: 'abort', reason: 'operator', survivors, at: { domain: 'match', value: 0n } },
    }),
  ]));
  await recordNextMessage(trace, messages);
  await recordNextMessage(trace, messages);
  await recordNextMessage(trace, messages);
}

async function recordNextMessage(
  trace: RuntimeTraceBuilder,
  messages: AsyncGenerator<ControlMessage>,
): Promise<void> {
  const next = await messages.next();
  assert.equal(next.done, false);
  await trace.recordControlMessage(next.value!);
}

function policyDecisionRecord(sequence: bigint) {
  const observation = agentObservation({
    tick: tick(10),
    sequence: observationSequence(1),
    agent: currentKnowledge(agentState({
      position: blockPosition(0, 64, 0),
      healthHalfHearts: 40,
      hungerPoints: 20,
      foodStacks: [],
      equipped: emptyEquipment(),
      upgrades: [],
    })),
    border: currentKnowledge(worldBorder(0, 0, 100)),
    opponents: currentKnowledge([]),
    loot: unknownKnowledge(),
  });
  const normalized = normalizePolicyReplayInput({
    observation,
    memory: emptyPolicyMemory(),
    feedback: [],
    params: PolicyParams.baseline(),
    random: DeterministicRandom.fromState(1n),
  });
  const input: PolicyReplayInputV1 = { schema: 'policy-input-v1', observation: normalized.observation,
    memory: { lastGoal: normalized.memory.lastGoal, lastOpponent: normalized.memory.lastOpponent },
    params: normalized.params, rng_state: normalized.rng_state };
  const restored = rehydratePolicyReplayInput(input);
  if (restored.schema !== 'policy-input-v1') throw new Error('expected legacy input');
  const decision = decidePolicyReplayV1(restored.observation, restored.memory, restored.params, restored.random);
  assert.notEqual(decision.intent.kind, 'hold');
  return { schema: 'policy-replay-v1' as const, sequence: sequence.toString(), seat: 0, input, decision, rng_state_after: restored.random.snapshotState().toString() };
}

class TestFrameReader {
  readonly #iterator: AsyncIterator<Buffer>;
  #buffer = Buffer.alloc(0);

  constructor(socket: Socket) {
    this.#iterator = socket[Symbol.asyncIterator]();
  }

  async readFrame(): Promise<Buffer> {
    let bodyLength: number | undefined;
    while (bodyLength === undefined || this.#buffer.byteLength < bodyLength + 4) {
      const chunk = await this.#iterator.next();
      if (chunk.done) throw new Error('socket ended before a complete control frame');
      this.#buffer = Buffer.concat([this.#buffer, chunk.value]);
      if (this.#buffer.byteLength >= 4) bodyLength = this.#buffer.readUInt32BE(0);
    }
    const frame = this.#buffer.subarray(0, bodyLength! + 4);
    this.#buffer = this.#buffer.subarray(bodyLength! + 4);
    return frame;
  }
}

function readyEnvelope(): Extract<ControlMessage, { readonly type: 'ready' }> {
  return {
    protocol: 1,
    run_id: RUN_ID,
    sequence: 2n,
    correlation: 1n,
    type: 'ready',
    payload: {
      server: { name: 'Paper', version: 'test', minecraft_version: 'test', protocol_version: 1 },
      plugin: { name: 'Arena', version: 'test' },
      capabilities: CAPABILITIES,
    },
  };
}

function clockMessage(sequence: bigint, phase: 'waiting' | 'aborted'): ControlMessage {
  return {
    protocol: 1,
    run_id: RUN_ID,
    sequence,
    type: 'public_clock',
    payload: { phase, tick: null, border_diameter_blocks: 100 },
  };
}

function preparePayload(seats = 1): Extract<ControlMessage, { readonly type: 'prepare' }>['payload'] {
  return {
    map_semantic_id: '0'.repeat(64),
    scenario_semantic_id: '1'.repeat(64),
    seed: 4n,
    mode: 'hunger_games',
    settings: {
      match: {
        countdown_ticks: 0n,
        grace_ticks: 0n,
        authoritative_max_ticks: 20n,
        respawn: false,
        block_breaking: true,
        block_placing: true,
        natural_mobs: false,
        natural_random_ticks: false,
      },
      border: {
        initial_diameter_blocks: 100,
        shrink_start_tick: 0n,
        shrink_end_tick: 10n,
        final_diameter_blocks: 10,
      },
    },
    roster: Array.from({ length: seats }, (_, seat) => ({
      kind: 'bot' as const,
      seat,
      participant_id: `seat-${seat}`,
      username: `ArenaBot${seat}`,
      offline_uuid: `00000000-0000-3000-8000-${String(seat).padStart(12, '0')}`,
    })),
  };
}

function prepareEnvelope(): Extract<ControlMessage, { readonly type: 'prepare' }> {
  return {
    protocol: 1,
    run_id: RUN_ID,
    sequence: 2n,
    type: 'prepare',
    payload: preparePayload(),
  };
}

function frame(message: ControlMessage): Buffer {
  return Buffer.from(encodeControlFrame(message));
}
