import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { basename, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  decodeControlFrame,
  encodeControlFrame,
  type ControlMessage,
} from '../src/control/index.js';
import { RunnerError } from '../src/errors.js';
import { createRunDirectory, readOwnedFile } from '../src/owned-files/index.js';
import { parseSegment } from '../src/trace.js';
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

async function createTrace(t: TestContext): Promise<Readonly<{
  trace: RuntimeTraceBuilder;
  ownedRoot: Buffer;
}>> {
  const ownedRoot = await readTestRootForTrace(t);
  const runDirectoryPath = Buffer.from('run', 'ascii');
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

function preparePayload(): Extract<ControlMessage, { readonly type: 'prepare' }>['payload'] {
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
    roster: [{
      kind: 'bot',
      seat: 0,
      participant_id: 'seat-0',
      username: 'ArenaBot0',
      offline_uuid: '00000000-0000-3000-8000-000000000000',
    }],
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
