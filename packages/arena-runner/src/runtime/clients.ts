import { createBot, type Bot } from 'mineflayer';
import type { PartiallyComputedPath } from 'mineflayer-pathfinder';
import { createMineflayerArenaClient, type MineflayerArenaClient } from '@arena/bots';
import { RunnerError } from '../errors.js';
import type { ScenarioIr } from '@arena/spec';
import type {
  ChunkReceipt,
  EntityReceipt,
  MineflayerReceiptSnapshot,
  RuntimeCompetitorHandle,
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

  get client(): MineflayerArenaClient {
    return this.#requireConnection().client;
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
      const connection = await connectRuntimeBot(this.identity, this.#connectionOptions);
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
    const connection = await connectRuntimeBot(this.identity, options);
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

interface RuntimeBotConnection {
  readonly bot: Bot;
  readonly client: MineflayerArenaClient;
  readonly ended: Promise<void>;
  readonly receipts: ReceiptRecorder;
  readonly failure: RunnerError | undefined;
  close(): Promise<void>;
}

class OwnedBotConnection implements RuntimeBotConnection {
  readonly bot: Bot;
  readonly client: MineflayerArenaClient;
  readonly ended: Promise<void>;
  readonly receipts: ReceiptRecorder;
  #failure: RunnerError | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(bot: Bot, client: MineflayerArenaClient, receipts: ReceiptRecorder) {
    this.bot = bot;
    this.client = client;
    this.receipts = receipts;
    this.ended = new Promise<void>((resolve) => bot.once('end', () => resolve()));
    bot.on('error', (error) => {
      this.#failure ??= new RunnerError('runtime_failure', 'Mineflayer client', { kind: 'client_error' });
    });
  }

  get failure(): RunnerError | undefined {
    return this.#failure;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    const adapterClose = this.client.close();
    this.bot.end('arena runtime cleanup');
    this.receipts.close();
    await withTimeout(adapterClose, 10_000, 'client skill shutdown');
    await withTimeout(this.ended, 5_000, 'client disconnect');
    if (this.#failure !== undefined) throw this.#failure;
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
    });
  } catch {
    throw new RunnerError('runtime_failure', 'Mineflayer client', { kind: 'client_start_failed' });
  }

  let client: MineflayerArenaClient;
  try {
    client = createMineflayerArenaClient(bot);
  } catch {
    bot.end('arena runtime client initialization failed');
    throw new RunnerError('runtime_failure', 'Mineflayer client', { kind: 'client_adapter_failed' });
  }
  const receipts = new ReceiptRecorder(bot);
  const connection = new OwnedBotConnection(bot, client, receipts);
  try {
    await waitForSpawn(bot, connection.ended, options.signal);
    if (connection.failure !== undefined) throw connection.failure;
    return connection;
  } catch (error) {
    await connection.close().catch(() => undefined);
    if (options.signal.aborted) throw cancelledClient();
    if (error instanceof RunnerError) throw error;
    throw new RunnerError('runtime_failure', 'Mineflayer client', { kind: 'client_spawn_failed' });
  }
}

function waitForSpawn(bot: Bot, ended: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(cancelledClient());
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      bot.removeListener('spawn', onSpawn);
      bot.removeListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (error?: RunnerError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onSpawn = (): void => finish();
    const onError = (): void => finish(new RunnerError('runtime_failure', 'Mineflayer client', { kind: 'client_error' }));
    const onAbort = (): void => finish(cancelledClient());
    const timer = setTimeout(
      () => finish(new RunnerError('runtime_failure', 'Mineflayer client', { kind: 'client_spawn_timeout' })),
      CLIENT_SPAWN_TIMEOUT_MS,
    );
    bot.once('spawn', onSpawn);
    bot.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    void ended.then(() => finish(new RunnerError('runtime_failure', 'Mineflayer client', { kind: 'client_ended_before_spawn' })));
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
  return new RunnerError('runtime_failure', 'Mineflayer client', { kind: 'cancelled' });
}
