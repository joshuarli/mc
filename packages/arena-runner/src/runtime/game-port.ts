import { createServer } from 'node:net';
import { RunnerError } from '../errors.js';

const LOOPBACK = '127.0.0.1';
const ATTEMPTS = 16;
const handedOut = new Set<number>();

export async function reserveEphemeralGamePort(): Promise<number> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const port = await probeFreePort();
    if (handedOut.has(port)) continue;
    handedOut.add(port);
    return port;
  }
  throw new RunnerError('runtime_failure', 'game port', { kind: 'no_free_loopback_port' });
}

function probeFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error) => reject(new RunnerError('runtime_failure', 'game port', {
      kind: 'port_probe_failed',
      ...(typeof (error as NodeJS.ErrnoException).errno === 'number' ? { os_code: Math.abs((error as NodeJS.ErrnoException).errno!) } : {}),
    })));
    probe.listen({ host: LOOPBACK, port: 0, exclusive: true }, () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new RunnerError('runtime_failure', 'game port', { kind: 'port_probe_failed' }));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}
