import { createBot, type Bot } from 'mineflayer';
import type { PartiallyComputedPath } from 'mineflayer-pathfinder';
import { createMineflayerArenaClient, type CivilizationRosterMember, type MineflayerArenaClient } from '@arena/bots';
import { performance } from 'node:perf_hooks';
import { RunnerError } from '../errors.js';
import { createCivilizationRuntimeGameplayAdapter } from './civilization-adapter.js';
import type { ScenarioIr } from '@arena/spec';
import type {
  ChunkReceipt,
  EntityReceipt,
  MineflayerReceiptSnapshot,
  RuntimeCompetitorHandle,
  RuntimeGameplay,
  RuntimeSpectatorHandle,
} from './types.js';
import type { PlayerIdentity } from './observations.js';

const CLIENT_SPAWN_TIMEOUT_MS = 30_000;
const MAX_RECEIPT_EVENTS = 4_096;

export interface RuntimeClientOptions {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly scenario: ScenarioIr;
  readonly signal: AbortSignal;
  readonly publicRoster: readonly CivilizationRosterMember[];
}

export class RuntimeCompetitorClient implements RuntimeCompetitorHandle {
  readonly seat: number;
  readonly identity: PlayerIdentity;
  readonly #scenario: ScenarioIr;
  readonly #connectionOptions: RuntimeClientOptions;
  readonly #connections: RuntimeBotConnection[] = [];
  #connection: RuntimeBotConnection | undefined;
  #transition: Promise<void> = Promise.resolve();

  constructor(seat: number, identity: PlayerIdentity, options: RuntimeClientOptions) {
    this.seat = seat;
    this.identity = identity;
    this.#scenario = options.scenario;
    this.#connectionOptions = options;
  }

  get bot(): Bot {
    return this.#requireConnection().bot;
  }

  get client(): Pick<MineflayerArenaClient, 'run' | 'cancel' | 'close'> {
    return this.#requireConnection().client;
  }

  get gameplay(): RuntimeGameplay {
    const gameplay = this.#requireConnection().gameplay;
    if (gameplay === undefined) throw new RunnerError('runtime_failure', 'competitor client', { kind: 'missing_gameplay_adapter' });
    return gameplay;
  }

  async connect(): Promise<void> {
    await this.#replaceConnection();
  }

  async reconnect(): Promise<RuntimeCompetitorHandle> {
    await this.#replaceConnection();
    return this;
  }

  chunkReceipts(): MineflayerReceiptSnapshot {
    return combineReceipts(this.#connections);
  }

  async close(): Promise<void> {
    await this.#replaceQueued(async () => {
      await closeConnections(this.#connections);
      this.#connection = undefined;
    });
  }

  failure(): RunnerError | undefined {
    return this.#connections.find((connection) => connection.failure !== undefined)?.failure;
  }

  async #replaceConnection(): Promise<void> {
    await this.#replaceQueued(async () => {
      if (this.#connection !== undefined) await this.#connection.close();
      const connection = await connectRuntimeBot(this.identity, this.#connectionOptions, { kind: 'competitor', seat: this.seat });
      this.#connections.push(connection);
      this.#connection = connection;
    });
  }

  async #replaceQueued(operation: () => Promise<void>): Promise<void> {
    const previous = this.#transition;
    let release!: () => void;
    this.#transition = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await operation();
    } finally {
      release();
    }
  }

  #requireConnection(): RuntimeBotConnection {
    if (this.#connection === undefined) {
      throw new RunnerError('runtime_failure', 'competitor client', { kind: 'client_not_connected' });
    }
    return this.#connection;
  }
}

export class RuntimeSpectatorClient implements RuntimeSpectatorHandle {
  readonly identity: PlayerIdentity;
  readonly #connections: RuntimeBotConnection[] = [];
  #connection: RuntimeBotConnection | undefined;

  constructor(identity: PlayerIdentity) {
    this.identity = identity;
  }

  get bot(): Bot {
    if (this.#connection === undefined) {
      throw new RunnerError('runtime_failure', 'spectator client', { kind: 'client_not_connected' });
    }
    return this.#connection.bot;
  }

  async connect(options: RuntimeClientOptions): Promise<void> {
    const connection = await connectRuntimeBot(this.identity, options, { kind: 'spectator' });
    this.#connections.push(connection);
    this.#connection = connection;
  }

  chunkReceipts(): MineflayerReceiptSnapshot {
    return combineReceipts(this.#connections);
  }

  async close(): Promise<void> {
    await closeConnections(this.#connections);
    this.#connection = undefined;
  }

  failure(): RunnerError | undefined {
    return this.#connections.find((connection) => connection.failure !== undefined)?.failure;
  }
}

type RuntimeConnectionAdapter =
  | { readonly kind: 'spectator'; readonly client: MineflayerArenaClient }
  | { readonly kind: 'competitor'; readonly gameplay: RuntimeGameplay };

interface RuntimeBotConnection {
  readonly bot: Bot;
  readonly client: Pick<MineflayerArenaClient, 'run' | 'cancel' | 'close'>;
  readonly gameplay: RuntimeGameplay | undefined;
  readonly ended: Promise<void>;
  readonly receipts: ReceiptRecorder;
  readonly failure: RunnerError | undefined;
  close(): Promise<void>;
}

class OwnedBotConnection implements RuntimeBotConnection {
  readonly bot: Bot;
  readonly ended: Promise<void>;
  readonly receipts: ReceiptRecorder;
  readonly #injectionAllowed: Promise<void>;
  readonly #spawned: Promise<void>;
  readonly #resolveEnded: () => void;
  readonly #resolveInjectionAllowed: () => void;
  readonly #rejectInjectionAllowed: (error: RunnerError) => void;
  readonly #resolveSpawned: () => void;
  readonly #rejectSpawned: (error: RunnerError) => void;
  #adapter: RuntimeConnectionAdapter | undefined;
  #failure: RunnerError | undefined;
  #closePromise: Promise<void> | undefined;
  #injectionWasAllowed = false;
  #spawnedAlready = false;
  #closing = false;

  constructor(bot: Bot, receipts: ReceiptRecorder) {
    this.bot = bot;
    this.receipts = receipts;
    let resolveEnded!: () => void;
    let resolveInjectionAllowed!: () => void;
    let rejectInjectionAllowed!: (error: RunnerError) => void;
    let resolveSpawned!: () => void;
    let rejectSpawned!: (error: RunnerError) => void;
    this.ended = new Promise<void>((resolve) => { resolveEnded = resolve; });
    this.#injectionAllowed = new Promise<void>((resolve, reject) => {
      resolveInjectionAllowed = resolve;
      rejectInjectionAllowed = reject;
    });
    this.#spawned = new Promise<void>((resolve, reject) => {
      resolveSpawned = resolve;
      rejectSpawned = reject;
    });
    this.#resolveEnded = resolveEnded;
    this.#resolveInjectionAllowed = resolveInjectionAllowed;
    this.#rejectInjectionAllowed = rejectInjectionAllowed;
    this.#resolveSpawned = resolveSpawned;
    this.#rejectSpawned = rejectSpawned;
    void this.#injectionAllowed.catch(() => {});
    void this.#spawned.catch(() => {});
    bot.once('inject_allowed', this.#onInjectionAllowed);
    bot.once('spawn', this.#onSpawn);
    bot.on('error', this.#onError);
    bot.on('end', this.#onEnd);
  }

  get client(): Pick<MineflayerArenaClient, 'run' | 'cancel' | 'close'> {
    if (this.#adapter === undefined) {
      throw new RunnerError('runtime_failure', 'Mineflayer client', { kind: 'client_adapter_not_ready' });
    }
    return this.#adapter.kind === 'competitor' ? this.#adapter.gameplay.client : this.#adapter.client;
  }

  get gameplay(): RuntimeGameplay | undefined {
    return this.#adapter?.kind === 'competitor' ? this.#adapter.gameplay : undefined;
  }

  setAdapter(adapter: RuntimeConnectionAdapter): void {
    if (this.#adapter !== undefined) {
      throw new RunnerError('runtime_failure', 'Mineflayer client', { kind: 'client_adapter_already_ready' });
    }
    this.#adapter = adapter;
  }

  /** Mineflayer's plugin loader runs before this listener so adapter setup sees injected plugins. */
  waitForInjectionAllowed(signal: AbortSignal, deadline: number): Promise<void> {
    return waitForStartup(this.#injectionAllowed, signal, deadline, 'client_injection_timeout');
  }

  waitForSpawn(signal: AbortSignal, deadline: number): Promise<void> {
    return waitForStartup(this.#spawned, signal, deadline, 'client_spawn_timeout');
  }

  get failure(): RunnerError | undefined {
    return this.#failure;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  #onInjectionAllowed = (): void => {
    this.#injectionWasAllowed = true;
    this.#resolveInjectionAllowed();
  };

  #onSpawn = (): void => {
    this.#spawnedAlready = true;
    this.#resolveSpawned();
  };

  #onError = (error: Error): void => {
    if (this.#closing) return;
    this.#failure ??= new RunnerError('runtime_failure', 'Mineflayer client', {
      kind: 'client_error',
      reason: errorReason(error),
    });
    this.#rejectPendingStartup(this.#failure);
  };

  #onEnd = (): void => {
    this.#resolveEnded();
    if (!this.#injectionWasAllowed) {
      this.#rejectInjectionAllowed(new RunnerError('runtime_failure', 'Mineflayer client', {
        kind: 'client_ended_before_injection',
      }));
    }
    if (!this.#spawnedAlready) {
      this.#rejectSpawned(new RunnerError('runtime_failure', 'Mineflayer client', {
        kind: this.#injectionWasAllowed ? 'client_ended_before_spawn' : 'client_ended_before_injection',
      }));
    }
  };

  #rejectPendingStartup(error: RunnerError): void {
    if (!this.#injectionWasAllowed) this.#rejectInjectionAllowed(error);
    if (!this.#spawnedAlready) this.#rejectSpawned(error);
  }

  // A peer-ended client has removed the handler that clears Client.end()'s 30-second timer.
  // Don't call end() again in that state; destroying the socket still releases it.
  async #close(): Promise<void> {
    this.#closing = true;
    const existingFailure = this.#failure;
    const adapterClose = this.#adapter === undefined ? undefined : this.client.close();
    const socket = this.bot._client.socket;
    if (!socket.destroyed) {
      if (!this.bot._client.ended) this.bot.end('arena runtime cleanup');
      socket.destroy();
    }
    this.receipts.close();
    if (adapterClose !== undefined) await withTimeout(adapterClose, 10_000, 'client skill shutdown');
    await withTimeout(this.ended, 5_000, 'client disconnect');
    if (existingFailure !== undefined) throw existingFailure;
  }
}

export async function connectCompetitor(
  handle: RuntimeCompetitorClient,
): Promise<void> {
  await handle.connect();
}

export async function connectSpectator(
  handle: RuntimeSpectatorClient,
  options: RuntimeClientOptions,
): Promise<void> {
  await handle.connect(options);
}

export function collectClientFailures(
  competitors: readonly RuntimeCompetitorClient[],
  spectators: readonly RuntimeSpectatorClient[],
): RunnerError | undefined {
  for (const client of [...competitors, ...spectators]) {
    const failure = client.failure();
    if (failure !== undefined) return failure;
  }
  return undefined;
}

async function connectRuntimeBot(
  identity: PlayerIdentity,
  options: RuntimeClientOptions,
  role: { readonly kind: 'spectator' } | { readonly kind: 'competitor'; readonly seat: number },
): Promise<RuntimeBotConnection> {
  if (options.signal.aborted) throw cancelledClient();
  let bot: Bot;
  try {
    bot = createBot({
      host: options.host,
      port: options.port,
      username: identity.username,
      auth: 'offline',
      version: options.scenario.server.minecraft,
      viewDistance: options.scenario.server.viewDistanceChunks,
      logErrors: false,
    });
  } catch (error) {
    throw new RunnerError('runtime_failure', 'Mineflayer client', {
      kind: 'client_start_failed',
      reason: errorReason(error),
    });
  }

  const receipts = new ReceiptRecorder(bot);
  const connection = new OwnedBotConnection(bot, receipts);
  const deadline = performance.now() + CLIENT_SPAWN_TIMEOUT_MS;
  try {
    await connection.waitForInjectionAllowed(options.signal, deadline);
    if (connection.failure !== undefined) throw connection.failure;
    let adapter: RuntimeConnectionAdapter;
    try {
      if (options.scenario.mode === 'civilization' && role.kind === 'competitor') {
        adapter = {
          kind: 'competitor',
          gameplay: createCivilizationRuntimeGameplayAdapter(bot, options.scenario, role.seat, options.publicRoster),
        };
      } else {
        const client = createMineflayerArenaClient(bot);
        adapter = role.kind === 'spectator' ? { kind: 'spectator', client }
          : { kind: 'competitor', gameplay: { mode: 'hunger_games', client } };
      }
    } catch (error) {
      throw new RunnerError('runtime_failure', 'Mineflayer client', {
        kind: 'client_adapter_failed',
        reason: errorReason(error),
      });
    }
    connection.setAdapter(adapter);
    await connection.waitForSpawn(options.signal, deadline);
    if (connection.failure !== undefined) throw connection.failure;
    return connection;
  } catch (error) {
    const primary = options.signal.aborted
      ? cancelledClient()
      : error instanceof RunnerError ? error : new RunnerError('runtime_failure', 'Mineflayer client', {
        kind: 'client_spawn_failed',
        reason: errorReason(error),
      });
    let cleanupFailure: unknown;
    try {
      await connection.close();
    } catch (cleanupError) {
      if (cleanupError !== error && cleanupError !== primary) cleanupFailure = cleanupError;
    }
    if (cleanupFailure !== undefined) throw clientCleanupFailure(primary, cleanupFailure);
    throw primary;
  }
}

function waitForStartup(
  event: Promise<void>,
  signal: AbortSignal,
  deadline: number,
  timeoutKind: string,
): Promise<void> {
  if (signal.aborted) return Promise.reject(cancelledClient());
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = (): void => finish(cancelledClient());
    timer = setTimeout(
      () => finish(new RunnerError('runtime_failure', 'Mineflayer client', { kind: timeoutKind })),
      Math.max(0, deadline - performance.now()),
    );
    signal.addEventListener('abort', onAbort, { once: true });
    void event.then(() => finish(), (error: unknown) => finish(error));
    if (signal.aborted) onAbort();
  });
}

class ReceiptRecorder {
  readonly #bot: Bot;
  readonly #chunks: ChunkReceipt[] = [];
  readonly #entities: EntityReceipt[] = [];
  readonly #onChunkLoad: (position: { readonly x: number; readonly z: number }) => void;
  readonly #onEntitySpawn: (entity: Bot['entity']) => void;
  #closed = false;
  #overflowed = false;

  constructor(bot: Bot) {
    this.#bot = bot;
    this.#onChunkLoad = (position) => {
      if (!this.#reserve()) return;
      this.#chunks.push(Object.freeze({ x: position.x, z: position.z }));
    };
    this.#onEntitySpawn = (entity) => {
      if (!this.#reserve()) return;
      this.#entities.push(Object.freeze({
        id: entity.id,
        type: entity.type,
        position: Object.freeze({ x: entity.position.x, y: entity.position.y, z: entity.position.z }),
      }));
    };
    bot.on('chunkColumnLoad', this.#onChunkLoad);
    bot.on('entitySpawn', this.#onEntitySpawn);
  }

  snapshot(): MineflayerReceiptSnapshot {
    if (this.#overflowed) {
      throw new RunnerError('runtime_failure', 'Mineflayer receipts', { kind: 'receipt_history_limit_exceeded' });
    }
    return Object.freeze({
      chunkColumns: Object.freeze(this.#chunks.map((receipt) => Object.freeze({ ...receipt }))),
      entities: Object.freeze(this.#entities.map((receipt) => Object.freeze({
        id: receipt.id,
        type: receipt.type,
        position: Object.freeze({ ...receipt.position }),
      }))),
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#bot.removeListener('chunkColumnLoad', this.#onChunkLoad);
    this.#bot.removeListener('entitySpawn', this.#onEntitySpawn);
  }

  #reserve(): boolean {
    if (this.#chunks.length + this.#entities.length >= MAX_RECEIPT_EVENTS) {
      this.#overflowed = true;
      return false;
    }
    return true;
  }
}

function combineReceipts(connections: readonly RuntimeBotConnection[]): MineflayerReceiptSnapshot {
  const snapshots = connections.map((connection) => connection.receipts.snapshot());
  return Object.freeze({
    chunkColumns: Object.freeze(snapshots.flatMap((snapshot) => snapshot.chunkColumns)),
    entities: Object.freeze(snapshots.flatMap((snapshot) => snapshot.entities)),
  });
}

async function closeConnections(connections: readonly RuntimeBotConnection[]): Promise<void> {
  const results = await Promise.allSettled(connections.map((connection) => connection.close()));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure !== undefined) throw failure.reason;
}

function withTimeout(promise: Promise<unknown>, timeoutMs: number, kind: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RunnerError('runtime_failure', 'Mineflayer client', { kind })), timeoutMs);
    void promise.then(
      () => { clearTimeout(timer); resolve(); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function cancelledClient(): RunnerError {
  return new RunnerError('cancelled', 'Mineflayer client', { kind: 'cancelled' });
}

function errorReason(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  return typeof error === 'string' ? error : typeof error;
}

function clientCleanupFailure(primary: RunnerError, cleanup: unknown): RunnerError {
  const cleanupKind = cleanup instanceof RunnerError ? cleanup.source.kind : errorReason(cleanup);
  return new RunnerError('runtime_failure', primary.resource, {
    ...primary.source,
    cleanup_kind: cleanupKind,
  });
}
