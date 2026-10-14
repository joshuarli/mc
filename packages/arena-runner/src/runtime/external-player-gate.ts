import type { Bot, Player } from 'mineflayer';
import { RunnerError } from '../errors.js';
import type { PlayerIdentity } from './observations.js';

export const DEFAULT_EXTERNAL_JOIN_TIMEOUT_MS = 120_000;

export type ExternalAdmission =
  | Readonly<{ kind: 'spectator'; runtimeUsernames: ReadonlySet<string> }>
  | Readonly<{
    kind: 'competitors';
    identities: readonly PlayerIdentity[];
    runtimeUsernames: ReadonlySet<string>;
  }>;

export interface ExternalPlayerWait {
  readonly observers: readonly Bot[];
  readonly admission: ExternalAdmission;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly onAdmitted?: (username: string) => void;
  readonly onUnexpectedPlayer?: (username: string) => void;
}

export function waitForExternalPlayer(options: ExternalPlayerWait): Promise<void> {
  const { observers, admission, signal } = options;
  if (observers.length === 0) {
    throw new RunnerError('runtime_failure', 'external player wait', { kind: 'missing_observer_client' });
  }
  if (signal.aborted) return Promise.reject(signal.reason);
  const admitted = new Set<string>();
  const reportedUnexpected = new Set<string>();
  const satisfied = (): boolean => {
    if (admission.kind === 'spectator') return hasExternalSpectator(observers, admission.runtimeUsernames);
    const present = admission.identities.filter((identity) => isPresent(observers, identity));
    for (const identity of present) {
      if (!admitted.has(identity.username)) {
        admitted.add(identity.username);
        options.onAdmitted?.(identity.username);
      }
    }
    return present.length === admission.identities.length;
  };
  const reportUnexpected = (username: string): void => {
    if (admission.kind !== 'competitors' || options.onUnexpectedPlayer === undefined) return;
    if (admission.runtimeUsernames.has(username) || reportedUnexpected.has(username)) return;
    if (admission.identities.some((identity) => identity.username === username)) return;
    reportedUnexpected.add(username);
    options.onUnexpectedPlayer(username);
  };
  if (satisfied()) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const endedBots = new Set<Bot>();
    const endListeners = new Map<Bot, () => void>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = (): void => {
      for (const bot of observers) {
        bot.removeListener('playerJoined', onPlayerJoined);
        const onEnd = endListeners.get(bot);
        if (onEnd !== undefined) bot.removeListener('end', onEnd);
      }
      signal.removeEventListener('abort', onAbort);
      if (timer !== undefined) clearTimeout(timer);
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
    const onPlayerJoined = (player: Player): void => {
      reportUnexpected(player.username);
      if (satisfied()) complete();
    };
    const onBotEnd = (bot: Bot): void => {
      endedBots.add(bot);
      if (endedBots.size === observers.length) {
        fail(new RunnerError('runtime_failure', 'external player wait', {
          kind: 'all_observer_clients_disconnected',
        }));
      }
    };
    const onAbort = (): void => fail(signal.reason);

    for (const bot of observers) {
      bot.on('playerJoined', onPlayerJoined);
      const onEnd = (): void => onBotEnd(bot);
      endListeners.set(bot, onEnd);
      bot.on('end', onEnd);
    }
    signal.addEventListener('abort', onAbort, { once: true });
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        const waitingFor = admission.kind === 'competitors'
          ? admission.identities.filter((identity) => !isPresent(observers, identity)).map((identity) => identity.username)
          : [];
        fail(new RunnerError('runtime_failure', 'external player wait', {
          kind: 'external_join_timeout',
          ...(waitingFor.length === 0 ? {} : { field: waitingFor.join(',') }),
        }));
      }, options.timeoutMs);
    }
    if (signal.aborted) onAbort();
  });
}

function isPresent(observers: readonly Bot[], identity: PlayerIdentity): boolean {
  return observers.some((bot) => {
    const player = bot.players[identity.username];
    return player !== undefined && player.username === identity.username && player.uuid === identity.offlineUuid;
  });
}

function hasExternalSpectator(observers: readonly Bot[], runtimeUsernames: ReadonlySet<string>): boolean {
  return observers.some((bot) => Object.keys(bot.players).some((username) => !runtimeUsernames.has(username)));
}
