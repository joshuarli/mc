import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';
import { startOwnedServerProcess } from '../src/runtime/process.js';

test('owned server sends one console stop and shares its exit completion', async () => {
  const server = await startOwnedServerProcess({
    executable: process.execPath,
    args: ['-e', "process.stdin.on('data', chunk => { if (chunk.toString().trim() === 'stop') process.exit(0); });"],
    cwd: process.cwd(),
    env: { ...process.env },
  });

  const [firstShutdown, secondShutdown] = await Promise.all([
    server.shutdown(),
    server.shutdown(),
  ]);
  assert.ok(server.pid > 0);
  assert.deepEqual(firstShutdown, { code: 0, signal: null });
  assert.deepEqual(secondShutdown, firstShutdown);
  assert.deepEqual(await server.exited, firstShutdown);
});

test('owned server shutdown reports an exit that happened before cleanup', async () => {
  const server = await startOwnedServerProcess({
    executable: process.execPath,
    args: ['-e', 'process.exit(7);'],
    cwd: process.cwd(),
    env: { ...process.env },
  });

  const exit = await server.exited;
  assert.deepEqual(exit, { code: 7, signal: null });
  assert.deepEqual(await server.shutdown(), exit);
});

test('owned server relays stdout and stderr without ending supplied streams', async () => {
  const stdout = captureOutput();
  const stderr = captureOutput();
  const server = await startOwnedServerProcess({
    executable: process.execPath,
    args: ['-e', "process.stdout.write('stdout line\\n'); process.stderr.write('stderr line\\n');"],
    cwd: process.cwd(),
    env: { ...process.env },
    output: { stdout: stdout.stream, stderr: stderr.stream },
  });

  const exit = await server.exited;
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(stdout.text, 'stdout line\n');
  assert.equal(stderr.text, 'stderr line\n');
  assert.equal(stdout.ended, false);
  assert.equal(stderr.ended, false);
  await server.shutdown();
});

test('owned server detects a Paper bind failure across output chunks as an owner conflict', async () => {
  const stdout = captureOutput();
  const stderr = captureOutput();
  const server = await startOwnedServerProcess({
    executable: process.execPath,
    args: ['-e', "process.stdout.write('[Server thread/ERROR]: Failed to bind'); process.stdin.once('data', () => process.stdout.write(' to server\\n'));"],
    cwd: process.cwd(),
    env: { ...process.env },
    output: { stdout: stdout.stream, stderr: stderr.stream },
  });

  const fatalOutputError = server.fatalOutputError;
  assert.ok(fatalOutputError);
  await stdout.firstWrite;
  const shutdown = server.shutdown();
  const failure = await fatalOutputError;
  assert.equal(failure.category, 'owner_conflict');
  assert.equal(failure.exitCode(), 4);
  assert.equal(failure.source.kind, 'paper_port_bind_failed');
  await assert.rejects(shutdown, (error: unknown) => error === failure);
  assert.equal(stdout.text, '[Server thread/ERROR]: Failed to bind to server\n');
});

function captureOutput(): {
  readonly stream: Writable;
  readonly firstWrite: Promise<void>;
  readonly text: string;
  readonly ended: boolean;
} {
  let text = '';
  let ended = false;
  let resolveFirstWrite!: () => void;
  const firstWrite = new Promise<void>((resolve) => { resolveFirstWrite = resolve; });
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      text += chunk.toString();
      resolveFirstWrite();
      callback();
    },
    final(callback) {
      ended = true;
      callback();
    },
  });
  return {
    stream,
    firstWrite,
    get text() { return text; },
    get ended() { return ended; },
  };
}
