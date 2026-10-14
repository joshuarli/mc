import { WorkerRuntime } from './worker-runtime.js';
import type { SupervisorToWorker, WorkerToSupervisor } from './protocol.js';

function send(message: WorkerToSupervisor): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (process.send === undefined) {
      reject(new Error('worker has no supervisor channel'));
      return;
    }
    process.send(message, (error: Error | null) => { if (error === null) resolve(); else reject(error); });
  });
}

const runtime = new WorkerRuntime({ send });
let queue: Promise<void> = Promise.resolve();

process.on('message', (message: SupervisorToWorker) => {
  queue = queue.then(() => runtime.handle(message)).catch(async () => {
    process.exitCode = 1;
    process.exit();
  });
});
process.on('disconnect', () => process.exit(1));
