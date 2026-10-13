import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import test, { type TestContext } from 'node:test';
import {
  decodeControlFrame,
  encodeControlFrame,
  type ControlMessage,
} from '../src/control/index.js';
import { parseSegment } from '../src/trace.js';
import { RunnerError } from '../src/errors.js';
import {
  RuntimeTraceBuilder,
} from '../src/runtime/trace.js';
import {
  bindControlListener,
  createControlToken,
  type ControlSession,
} from '../src/runtime/session.js';

const RUN_ID = 'runtime-trace-test';
const CAPABILITIES = ['hunger_games_v1'] as const;

test('runtime trace retains authenticated lifecycle events and terminal outcome', async (t) => {
  const { session, client } = await authenticatedSession(t);
  const trace = new RuntimeTraceBuilder(RUN_ID);
  trace.recordReady(session.ready);
  const prepare = await session.send({ type: 'prepare', payload: preparePayload() });
  trace.recordRunnerCommand(prepare);

  client.write(Buffer.concat([
    frame({
      protocol: 1,
      run_id: RUN_ID,
      sequence: 3n,
      correlation: prepare.sequence,
      type: 'ack',
      payload: {},
    }),
    frame(clockMessage(4n, 'waiting')),
    frame({ protocol: 1, run_id: RUN_ID, sequence: 5n, type: 'heartbeat', payload: {} }),
    frame(clockMessage(6n, 'waiting')),
    frame({
      protocol: 1,
      run_id: RUN_ID,
      sequence: 7n,
      type: 'outcome',
      payload: {
        kind: 'abort',
        reason: 'operator',
        survivors: [],
        at: null,
      },
    }),
  ]));
  const messages = session.messages();
  for (let count = 0; count < 5; count += 1) {
    const message = await messages.next();
    assert.equal(message.done, false);
    trace.record(message.value!);
  }

  const bytes = trace.finalize();
  const segment = parseSegment(bytes);
  assert.equal(segment.runId, RUN_ID);
  assert.equal(segment.firstSequence, 1n);
  assert.equal(segment.lastSequence, 6n);
  assert.deepEqual(segment.records.map((record) => [record.direction, record.type]), [
    ['plugin', 'ready'],
    ['runner', 'prepare'],
    ['plugin', 'ack'],
    ['plugin', 'public_clock'],
    ['plugin', 'public_clock'],
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
  assert.equal(trace.finalize().equals(bytes), true);
  assert.throws(() => trace.record(clockMessage(8n, 'aborted')), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'trace_finalized');
});

test('runtime trace requires an authenticated authoritative outcome', async (t) => {
  const { session } = await authenticatedSession(t);
  const trace = new RuntimeTraceBuilder(RUN_ID);
  trace.recordReady(session.ready);

  assert.throws(() => trace.finalize(), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'outcome_missing');
});

test('runtime trace rejects fabricated readiness, commands, and plugin events', async (t) => {
  const { session } = await authenticatedSession(t);
  const trace = new RuntimeTraceBuilder(RUN_ID);

  assert.throws(() => trace.recordReady(readyEnvelope()), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'unauthenticated_readiness_envelope');
  trace.recordReady(session.ready);
  assert.throws(() => trace.recordRunnerCommand(prepareEnvelope()), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'unauthenticated_runner_command');
  assert.throws(() => trace.record(clockMessage(3n, 'waiting')), (error: unknown) =>
    error instanceof RunnerError && error.source.kind === 'unauthenticated_plugin_message');
});

test('runtime trace excludes handshake credentials', async (t) => {
  const { session, client, token } = await authenticatedSession(t);
  const trace = new RuntimeTraceBuilder(RUN_ID);
  trace.recordReady(session.ready);
  const prepare = await session.send({ type: 'prepare', payload: preparePayload() });
  trace.recordRunnerCommand(prepare);
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
      payload: { kind: 'abort', reason: 'operator', survivors: [], at: null },
    }),
  ]));
  const messages = session.messages();
  trace.record((await messages.next()).value!);
  trace.record((await messages.next()).value!);

  const bytes = trace.finalize();
  assert.equal(bytes.toString('utf8').includes(token), false);
  assert.equal(bytes.toString('utf8').includes('hello'), false);
});

test('runtime trace stops at its bounded record limit', async (t) => {
  const { session, client } = await authenticatedSession(t);
  const trace = new RuntimeTraceBuilder(RUN_ID);
  trace.recordReady(session.ready);
  const prepare = await session.send({ type: 'prepare', payload: preparePayload() });
  trace.recordRunnerCommand(prepare);
  const messages = session.messages();
  client.write(frame({
    protocol: 1,
    run_id: RUN_ID,
    sequence: 3n,
    correlation: prepare.sequence,
    type: 'ack',
    payload: {},
  }));
  trace.record((await messages.next()).value!);

  let failure: unknown;
  let sequence = 4n;
  for (let batch = 0; batch < 120 && failure === undefined; batch += 1) {
    const frames: Buffer[] = [];
    for (let item = 0; item < 500; item += 1) {
      frames.push(frame({
        protocol: 1,
        run_id: RUN_ID,
        sequence,
        type: 'public_state',
        payload: { at: { domain: 'match', value: sequence }, alive_seats: [0, 1] },
      }));
      sequence += 1n;
    }
    client.write(Buffer.concat(frames));
    for (let item = 0; item < frames.length; item += 1) {
      const next = await messages.next();
      assert.equal(next.done, false);
      try {
        trace.record(next.value!);
      } catch (error) {
        failure = error;
        break;
      }
    }
  }

  assert.ok(failure instanceof RunnerError);
  assert.equal(failure.source.kind, 'trace_limit_exceeded');
});

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
