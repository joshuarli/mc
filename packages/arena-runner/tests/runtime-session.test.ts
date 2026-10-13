import assert from 'node:assert/strict';
import { createConnection, type Socket } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import {
  decodeControlFrame,
  encodeControlFrame,
  MAX_CONTROL_FRAME_BYTES,
  type ControlCapability,
} from '../src/control/index.js';
import { bindControlListener, ControlSessionError, createControlToken } from '../src/runtime/session.js';

const RUN_ID = 'runtime-session-test';
const TOKEN = 'test-token-that-is-never-logged';
const CAPABILITIES = ['hunger_games_v1'] as const;

test('runtime control tokens carry 32 random bytes in base64url form', () => {
  const first = createControlToken();
  const second = createControlToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(first, 'base64url').byteLength, 32);
  assert.notEqual(first, second);
});

test('control listener authenticates one loopback plugin and sequences commands', async (t) => {
  const listener = await bindControlListener({
    runId: RUN_ID,
    token: TOKEN,
    capabilities: CAPABILITIES,
  });
  const port = listener.address.port;
  assert.equal(listener.address.host, '127.0.0.1');
  assert.ok(port > 0);
  const client = connectTo(port);
  const reader = new TestFrameReader(client);
  t.after(async () => {
    client.destroy();
    await listener.close();
  });

  const accepting = listener.accept();
  await once(client, 'connect');
  client.write(encodeControlFrame({
    protocol: 1,
    run_id: RUN_ID,
    sequence: 1n,
    type: 'hello',
    payload: { token: TOKEN, capabilities: CAPABILITIES },
  }));

  const helloAck = decodeControlFrame(await reader.readFrame());
  assert.equal(helloAck.type, 'ack');
  if (helloAck.type !== 'ack') throw new Error('expected hello acknowledgment');
  assert.equal(helloAck.correlation, 1n);

  client.write(encodeControlFrame({
    protocol: 1,
    run_id: RUN_ID,
    sequence: 2n,
    correlation: helloAck.sequence,
    type: 'ready',
    payload: {
      server: { name: 'Paper', version: 'test', minecraft_version: 'test', protocol_version: 1 },
      plugin: { name: 'Arena', version: 'test' },
      capabilities: CAPABILITIES,
    },
  }));

  const session = await accepting;
  const reconnect = connectTo(port);
  const [reconnectError] = await once(reconnect, 'error') as [NodeJS.ErrnoException];
  assert.equal(reconnectError.code, 'ECONNREFUSED');
  reconnect.destroy();

  const startCommand = await session.send({ type: 'start', payload: {} });
  const startSequence = startCommand.sequence;
  assert.equal(startSequence, 2n);
  const start = decodeControlFrame(await reader.readFrame());
  assert.equal(start.type, 'start');
  assert.equal(start.sequence, 2n);

  client.write(Buffer.concat([
    encodeControlFrame({
      protocol: 1,
      run_id: RUN_ID,
      sequence: 3n,
      correlation: startSequence,
      type: 'ack',
      payload: {},
    }),
    encodeControlFrame({
      protocol: 1,
      run_id: RUN_ID,
      sequence: 4n,
      type: 'outcome',
      payload: {
        kind: 'winner',
        winner_seat: 0,
        survivors: [0],
        at: { domain: 'match', value: 1n },
      },
    }),
  ]));
  const messages = session.messages();
  const acknowledgment = await messages.next();
  assert.equal(acknowledgment.done, false);
  assert.equal(acknowledgment.value?.type, 'ack');
  if (acknowledgment.value?.type === 'ack') {
    assert.equal(acknowledgment.value.correlation, startSequence);
  }
  const outcome = await messages.next();
  assert.equal(outcome.done, false);
  assert.equal(outcome.value?.type, 'outcome');
  assert.equal((await messages.next()).done, true);
  await session.close();
});

test('control listener snapshots the supported capabilities at bind time', async (t) => {
  const capabilities: ControlCapability[] = ['hunger_games_v1'];
  const listener = await bindControlListener({
    runId: RUN_ID,
    token: TOKEN,
    capabilities,
  });
  capabilities.length = 0;
  const client = connectTo(listener.address.port);
  const reader = new TestFrameReader(client);
  t.after(async () => {
    client.destroy();
    await listener.close();
  });

  const accepting = listener.accept();
  await once(client, 'connect');
  client.write(encodeControlFrame({
    protocol: 1,
    run_id: RUN_ID,
    sequence: 1n,
    type: 'hello',
    payload: { token: TOKEN, capabilities: CAPABILITIES },
  }));
  const helloAck = decodeControlFrame(await reader.readFrame());
  if (helloAck.type !== 'ack') throw new Error('expected hello acknowledgment');
  client.write(encodeControlFrame({
    protocol: 1,
    run_id: RUN_ID,
    sequence: 2n,
    correlation: helloAck.sequence,
    type: 'ready',
    payload: {
      server: { name: 'Paper', version: 'test', minecraft_version: 'test', protocol_version: 1 },
      plugin: { name: 'Arena', version: 'test' },
      capabilities: CAPABILITIES,
    },
  }));

  const session = await accepting;
  await session.close();
});

test('control listener rejects a plugin with the wrong token and closes its socket', async (t) => {
  const listener = await bindControlListener({
    runId: RUN_ID,
    token: TOKEN,
    capabilities: CAPABILITIES,
  });
  const client = connectTo(listener.address.port);
  const clientClosed = once(client, 'close');
  t.after(async () => {
    client.destroy();
    await listener.close();
  });

  const accepting = listener.accept();
  await once(client, 'connect');
  client.write(encodeControlFrame({
    protocol: 1,
    run_id: RUN_ID,
    sequence: 1n,
    type: 'hello',
    payload: { token: 'wrong-token', capabilities: CAPABILITIES },
  }));

  await assert.rejects(accepting, (error: unknown) =>
    isRuntimeSessionError(error) && error.code === 'authentication_failed');
  await clientClosed;
});

test('control session closes the connection on an uncorrelated acknowledgment', async (t) => {
  const listener = await bindControlListener({
    runId: RUN_ID,
    token: TOKEN,
    capabilities: CAPABILITIES,
  });
  const client = connectTo(listener.address.port);
  const reader = new TestFrameReader(client);
  t.after(async () => {
    client.destroy();
    await listener.close();
  });

  const accepting = listener.accept();
  await once(client, 'connect');
  client.write(encodeControlFrame({
    protocol: 1,
    run_id: RUN_ID,
    sequence: 1n,
    type: 'hello',
    payload: { token: TOKEN, capabilities: CAPABILITIES },
  }));
  const helloAck = decodeControlFrame(await reader.readFrame());
  if (helloAck.type !== 'ack') throw new Error('expected hello acknowledgment');
  client.write(encodeControlFrame({
    protocol: 1,
    run_id: RUN_ID,
    sequence: 2n,
    correlation: helloAck.sequence,
    type: 'ready',
    payload: {
      server: { name: 'Paper', version: 'test', minecraft_version: 'test', protocol_version: 1 },
      plugin: { name: 'Arena', version: 'test' },
      capabilities: CAPABILITIES,
    },
  }));

  const session = await accepting;
  t.after(async () => {
    await session.close();
  });
  const sequence = (await session.send({ type: 'start', payload: {} })).sequence;
  await reader.readFrame();
  const messages = session.messages();
  client.write(encodeControlFrame({
    protocol: 1,
    run_id: RUN_ID,
    sequence: 3n,
    correlation: sequence + 1n,
    type: 'ack',
    payload: {},
  }));

  await assert.rejects(messages.next(), (error: unknown) =>
    isRuntimeSessionError(error) && error.code === 'invalid_acknowledgment');
  if (!client.closed) await once(client, 'close');
  await assert.rejects(session.send({ type: 'start', payload: {} }), (error: unknown) =>
    isRuntimeSessionError(error) && error.code === 'control_closed');
});

test('canceling plugin acceptance releases the loopback listener', async () => {
  const listener = await bindControlListener({
    runId: RUN_ID,
    token: TOKEN,
    capabilities: CAPABILITIES,
  });
  const address = listener.address;
  const controller = new AbortController();
  const accepting = listener.accept(controller.signal);
  controller.abort();

  await assert.rejects(accepting, (error: unknown) =>
    isRuntimeSessionError(error) && error.code === 'cancelled');
  await listener.close();

  const probe = connectTo(address.port);
  const [error] = await once(probe, 'error') as [NodeJS.ErrnoException];
  assert.equal(error.code, 'ECONNREFUSED');
  probe.destroy();
});

test('closing the listener cancels a connection waiting for its authenticated hello', async (t) => {
  const listener = await bindControlListener({
    runId: RUN_ID,
    token: TOKEN,
    capabilities: CAPABILITIES,
  });
  const client = connectTo(listener.address.port);
  t.after(() => client.destroy());
  const accepting = listener.accept();
  await once(client, 'connect');

  await listener.close();
  await assert.rejects(accepting, (error: unknown) => error instanceof ControlSessionError);
});

test('canceling before accept destroys a plugin connection already waiting', { timeout: 2_000 }, async (t) => {
  const listener = await bindControlListener({
    runId: RUN_ID,
    token: TOKEN,
    capabilities: CAPABILITIES,
  });
  const client = connectTo(listener.address.port);
  let clientError: NodeJS.ErrnoException | undefined;
  client.on('error', (error: NodeJS.ErrnoException) => { clientError = error; });
  const clientClosed = new Promise<void>((resolve) => client.once('close', () => resolve()));
  t.after(async () => {
    await listener.close();
    client.destroy();
  });

  await once(client, 'connect');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(listener.accept(controller.signal), (error: unknown) =>
    isRuntimeSessionError(error) && error.code === 'cancelled');
  await clientClosed;
  assert.ok(clientError === undefined || clientError.code === 'ECONNRESET');
});

function connectTo(port: number): Socket {
  return createConnection({ host: '127.0.0.1', port });
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
      const next = await this.#iterator.next();
      if (next.done) throw new Error('socket closed before a complete control frame');
      this.#buffer = Buffer.concat([this.#buffer, Buffer.from(next.value)]);
      if (bodyLength === undefined && this.#buffer.byteLength >= 4) {
        bodyLength = this.#buffer.readUInt32BE(0);
        if (bodyLength === 0 || bodyLength > MAX_CONTROL_FRAME_BYTES) throw new Error('invalid control frame length');
      }
    }
    const frame = this.#buffer.subarray(0, bodyLength + 4);
    this.#buffer = this.#buffer.subarray(bodyLength + 4);
    return frame;
  }
}

function isRuntimeSessionError(error: unknown): error is Error & { readonly code: string } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string';
}
