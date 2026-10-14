import { RunnerError } from '../errors.js';

export async function joinEvaluatorAfterOutcome(options: Readonly<{
  task: Promise<void>;
  abort: AbortController;
  timeoutMs: number;
  failures: readonly Promise<never>[];
}>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RunnerError('runtime_failure', 'active evaluator', {
      kind: 'evaluator_did_not_stop',
    })), options.timeoutMs);
  });
  try {
    await Promise.race([options.task, ...options.failures, timeout]);
  } catch (error) {
    options.abort.abort(error);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  options.abort.abort(new Error('match outcome received'));
}
