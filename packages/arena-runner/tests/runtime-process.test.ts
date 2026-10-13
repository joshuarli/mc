import assert from 'node:assert/strict';
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
