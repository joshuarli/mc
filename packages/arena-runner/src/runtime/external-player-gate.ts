import type { Bot, Player } from 'mineflayer';
import { RunnerError } from '../errors.js';

/** Waits for a connected player whose name is not owned by this runtime roster. */
export function waitForExternalPlayer(
  bots: readonly Bot[],
  runtimeUsernames: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<void> {
  if (bots.length === 0) {
    throw new RunnerError('runtime_failure', 'external player wait', { kind: 'missing_observer_client' });
  }
  if (signal.aborted) return Promise.reject(signal.reason);
  if (hasExternalPlayer(bots, runtimeUsernames)) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const endedBots = new Set<Bot>();
    const endListeners = new Map<Bot, () => void>();
    let settled = false;
    const cleanup = (): void => {
      for (const bot of bots) {
        bot.removeListener('playerJoined', onPlayerJoined);
        const onEnd = endListeners.get(bot);
        if (onEnd !== undefined) bot.removeListener('end', onEnd);
      }
      signal.removeEventListener('abort', onAbort);
    };
    const complete = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onPlayerJoined = (_player: Player): void => {
      if (hasExternalPlayer(bots, runtimeUsernames)) complete();
    };
    const onBotEnd = (bot: Bot): void => {
      endedBots.add(bot);
      if (endedBots.size === bots.length) {
        fail(new RunnerError('runtime_failure', 'external player wait', {
          kind: 'all_observer_clients_disconnected',
        }));
      }
    };
    const onAbort = (): void => fail(signal.reason);

    for (const bot of bots) {
      bot.on('playerJoined', onPlayerJoined);
      const onEnd = (): void => onBotEnd(bot);
      endListeners.set(bot, onEnd);
      bot.on('end', onEnd);
    }
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    else if (hasExternalPlayer(bots, runtimeUsernames)) complete();
  });
}

function hasExternalPlayer(bots: readonly Bot[], runtimeUsernames: ReadonlySet<string>): boolean {
  return bots.some((bot) => Object.keys(bot.players).some((username) => !runtimeUsernames.has(username)));
}
