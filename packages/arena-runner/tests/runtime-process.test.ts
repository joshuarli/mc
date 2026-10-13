import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
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

test('owned server reaps an externally killed child when stop races exit observation', async () => {
  const stdout = captureOutput();
  const server = await startOwnedServerProcess({
    executable: process.execPath,
    args: ['-e', "process.stdin.resume(); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"],
    cwd: process.cwd(),
    env: { ...process.env },
    output: { stdout: stdout.stream },
  });

  let exitObserved = false;
  void server.exited.then(() => { exitObserved = true; });
  await stdout.firstWrite;
  assert.equal(process.kill(server.pid, 'SIGKILL'), true);
  assert.ok(waitForZombie(server.pid).startsWith('Z'));
  assert.equal(exitObserved, false, 'the parent event loop must not observe close before shutdown');

  const exit = await server.shutdown();
  assert.deepEqual(exit, { code: null, signal: 'SIGKILL' });
  assert.deepEqual(await server.exited, exit);
});

test('owned server reports stop write failure when a live child closed stdin', async () => {
  const stdout = captureOutput();
  const server = await startOwnedServerProcess({
    executable: process.execPath,
    args: ['-e', "require('node:fs').closeSync(0); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"],
    cwd: process.cwd(),
    env: { ...process.env },
    output: { stdout: stdout.stream },
  });

  await stdout.firstWrite;
  await assert.rejects(server.shutdown(), (error: unknown) => {
    const source = (error as { source?: { kind?: string } }).source;
    assert.equal(source?.kind, 'console_write_failed');
    return true;
  });
  assert.deepEqual(await server.exited, { code: null, signal: 'SIGTERM' });
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
    args: ['-e', "process.stdout.write('[Server thread/WARN]: **** FAILED TO BIND'); process.stdin.once('data', () => { process.stdout.write(' TO PORT!\\n'); process.exit(0); });"],
    cwd: process.cwd(),
    env: { ...process.env },
    output: { stdout: stdout.stream, stderr: stderr.stream },
  });

  const fatalOutputError = server.fatalOutputError;
  assert.ok(fatalOutputError);
  await stdout.firstWrite;
  const shutdown = server.shutdown();
  const failure = await Promise.race([fatalOutputError, server.exited.then(() => undefined)]);
  assert.ok(failure, 'Paper bind failure must be classified before the server exits');
  assert.equal(failure.category, 'owner_conflict');
  assert.equal(failure.exitCode(), 4);
  assert.equal(failure.source.kind, 'paper_port_bind_failed');
  await assert.rejects(shutdown, (error: unknown) => error === failure);
  assert.equal(stdout.text, '[Server thread/WARN]: **** FAILED TO BIND TO PORT!\n');
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

function waitForZombie(pid: number): string {
  const deadline = performance.now() + 1_000;
  let state = '';
  do {
    const remainingMs = Math.max(1, Math.ceil(deadline - performance.now()));
    state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'ascii',
      timeout: remainingMs,
    }).trim();
    if (state.startsWith('Z')) return state;
  } while (performance.now() < deadline);
  throw new Error(`child ${pid} did not become a zombie within 1 second (state: ${state})`);
}
