import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { compileScenario } from '@arena/spec';
import { RunnerError } from '../src/errors.js';
import { createRuntimeRoster } from '../src/runtime/roster.js';
import { RuntimeCompetitorClient } from '../src/runtime/clients.js';

const repositoryRoot = process.cwd();

test('pinned Mineflayer waits for plugin injection before adapter setup and cancels cleanly', async (t) => {
  const listener = await createTcpListener(t);
  const abort = new AbortController();
  const connection = createCompetitor(listener.port, abort.signal);
  const accepted = waitForAcceptedConnection(listener.server);
  const operation = connection.connect();
  await waitForAcceptedConnectionOrFailure(accepted, operation);

  await delay(25);
  abort.abort(new Error('runtime client test cancellation'));
  const started = performance.now();
  await assert.rejects(operation, (error: unknown) => error instanceof RunnerError
    && error.category === 'cancelled'
    && error.source.kind === 'cancelled');
  assert.ok(performance.now() - started < 6_000, 'cancelled startup should close its TCP client promptly');
});

test('Mineflayer cancellation before plugin injection is bounded', async (t) => {
  const listener = await createTcpListener(t);
  const abort = new AbortController();
  const connection = createCompetitor(listener.port, abort.signal);
  const started = performance.now();
  const operation = connection.connect();
  queueMicrotask(() => abort.abort(new Error('cancel before plugin injection')));

  await assert.rejects(operation, (error: unknown) => error instanceof RunnerError
    && error.category === 'cancelled'
    && error.source.kind === 'cancelled');
  assert.ok(performance.now() - started < 6_000, 'pre-injection cancellation should release the bot promptly');
});

test('Mineflayer disconnect during startup performs bounded cleanup', async (t) => {
  const listener = await createTcpListener(t, true);
  const connection = createCompetitor(listener.port, new AbortController().signal);
  const accepted = waitForAcceptedConnection(listener.server);
  const operation = connection.connect();
  const started = performance.now();
  await waitForAcceptedConnectionOrFailure(accepted, operation);

  await assert.rejects(operation, (error: unknown) => error instanceof RunnerError
    && error.source.kind !== 'client_adapter_failed');
  assert.ok(performance.now() - started < 6_000, 'disconnect cleanup should not wait for the spawn deadline');
});

test('Mineflayer cleanup after a peer half-close releases the child process', () => {
  const source = [
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    "const net = require('node:net');",
    "const path = require('node:path');",
    `const { compileScenario } = require(${JSON.stringify(join(repositoryRoot, '.work/build/packages/arena-spec/src/index.js'))});`,
    `const { createRuntimeRoster } = require(${JSON.stringify(join(repositoryRoot, '.work/build/packages/arena-runner/src/runtime/roster.js'))});`,
    `const { RuntimeCompetitorClient } = require(${JSON.stringify(join(repositoryRoot, '.work/build/packages/arena-runner/src/runtime/clients.js'))});`,
    '(async () => {',
    '  const root = process.cwd();',
    "  const scenario = compileScenario(fs.readFileSync(path.join(root, 'scenarios/duel.toml'), 'utf8'), fs.readFileSync(path.join(root, 'maps/duel.toml'), 'utf8'));",
    '  const identity = createRuntimeRoster(scenario).competitorIdentities[0];',
    '  const peers = new Set();',
    '  let peerSentFin = false;',
    "  const server = net.createServer({ allowHalfOpen: true }, (socket) => {",
    '    peers.add(socket);',
    "    socket.once('close', () => peers.delete(socket));",
    "    socket.once('data', () => { peerSentFin = true; socket.end(); });",
    '  });',
    "  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });",
    '  const address = server.address();',
    "  assert.ok(address && typeof address === 'object', 'local listener must have a TCP address');",
    '  const connection = new RuntimeCompetitorClient(0, identity, {',
    "    host: '127.0.0.1', port: address.port, scenario, signal: new AbortController().signal,",
    '  });',
    '  await assert.rejects(connection.connect());',
    "  assert.equal(peerSentFin, true, 'the server must receive protocol bytes and send FIN');",
    '  for (const peer of peers) peer.destroy();',
    '  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));',
    '})().catch((error) => { console.error(error); process.exitCode = 1; });',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=commonjs', '-e', source], {
    cwd: repositoryRoot,
    env: { ...process.env, TMPDIR: join(repositoryRoot, '.work/tmp') },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 8_000,
  });
  const childErrorCode = (child.error as NodeJS.ErrnoException | undefined)?.code;

  assert.equal(
    childErrorCode,
    undefined,
    `Mineflayer cleanup kept its child alive: ${childErrorCode ?? ''}\n${child.stderr}`,
  );
  assert.equal(child.status, 0, `Mineflayer child failed: ${child.stderr}`);
});

function createCompetitor(port: number, signal: AbortSignal): RuntimeCompetitorClient {
  const scenario = compileScenario(
    readFileSync(join(repositoryRoot, 'scenarios/duel.toml'), 'utf8'),
    readFileSync(join(repositoryRoot, 'maps/duel.toml'), 'utf8'),
  );
  const roster = createRuntimeRoster(scenario);
  return new RuntimeCompetitorClient(0, roster.competitorIdentities[0]!, {
    host: '127.0.0.1',
    port,
    scenario,
    signal,
  });
}

async function createTcpListener(
  t: TestContext,
  closeOnConnect = false,
): Promise<Readonly<{ server: Server; port: number }>> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (closeOnConnect) socket.destroy();
  });
  server.on('error', (error) => { throw error; });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('local listener did not bind TCP');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return Object.freeze({ server, port: address.port });
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function waitForAcceptedConnection(server: Server): Promise<void> {
  return new Promise((resolve) => server.once('connection', () => resolve()));
}

async function waitForAcceptedConnectionOrFailure(
  accepted: Promise<void>,
  operation: Promise<void>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      accepted,
      operation.then(
        () => Promise.reject(new Error('Mineflayer connected without a spawn packet')),
        (error: unknown) => Promise.reject(error),
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Mineflayer did not reach the local TCP listener')), 2_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
