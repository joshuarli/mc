import { once } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  ControlCodecError,
  ControlReceiver,
  decodeControlFrame,
  encodeControlFrame,
  MAX_CONTROL_FRAME_BYTES,
  type AbortReason,
  type ControlCapability,
  type ControlMessage,
  type PreparePayload,
} from '../control/index.js';

const CONTROL_HOST = '127.0.0.1';
const MAX_U64 = (1n << 64n) - 1n;

export type RunnerCommand =
  | { readonly type: 'prepare'; readonly payload: PreparePayload }
  | { readonly type: 'start'; readonly payload: Record<string, never> }
  | { readonly type: 'abort'; readonly payload: { readonly reason: AbortReason } };

export type RunnerCommandEnvelope = Extract<ControlMessage, { readonly type: 'prepare' | 'start' | 'abort' }>;

const authenticatedMessages = new WeakSet<object>();

/** Returns true only for the immutable envelope accepted or sent by a live control session. */
export function isAuthenticatedControlMessage(message: ControlMessage): boolean {
  return authenticatedMessages.has(message);
}

export type ControlSessionErrorCode =
  | 'listener_failed'
  | 'listener_closed'
  | 'already_accepted'
  | 'cancelled'
  | 'authentication_failed'
  | 'unsupported_capability'
  | 'invalid_handshake'
  | 'control_protocol'
  | 'control_disconnected'
  | 'control_write_failed'
  | 'command_pending'
  | 'invalid_acknowledgment'
  | 'sequence_exhausted'
  | 'control_closed';

/** A control failure with a stable code for runner error mapping. */
export class ControlSessionError extends Error {
  constructor(readonly code: ControlSessionErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'ControlSessionError';
  }
}

export interface ControlListenerOptions {
  readonly runId: string;
  readonly token: string;
  readonly capabilities: readonly ControlCapability[];
}

export interface ControlListenerAddress {
  readonly host: '127.0.0.1';
  readonly port: number;
}

/** Creates the one-run credential that is passed only through the plugin's private environment. */
export function createControlToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Owns one ephemeral loopback listener and transfers one accepted connection to its session. */
export interface ControlListenerLease {
  readonly address: ControlListenerAddress;
  accept(signal?: AbortSignal): Promise<ControlSession>;
  close(): Promise<void>;
}

class TcpControlListenerLease implements ControlListenerLease {
  readonly address: ControlListenerAddress;
  readonly #server: Server;
  readonly #options: ControlListenerOptions;
  #connection: Socket | undefined;
  #authenticationSocket: Socket | undefined;
  #connectionSeen = false;
  #acceptStarted = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #serverFailure: unknown;
  #acceptReject: ((error: ControlSessionError) => void) | undefined;
  #acceptResolve: ((socket: Socket) => void) | undefined;

  constructor(server: Server, address: AddressInfo, options: ControlListenerOptions) {
    this.#server = server;
    this.#options = Object.freeze({
      runId: options.runId,
      token: options.token,
      capabilities: Object.freeze([...options.capabilities]),
    });
    this.address = Object.freeze({ host: CONTROL_HOST, port: address.port });
    this.#server.on('connection', (socket) => this.#onConnection(socket));
    this.#server.on('error', (error) => {
      this.#serverFailure = error;
      this.#acceptReject?.(new ControlSessionError('listener_failed', error));
    });
  }

  /** Accepts exactly one plugin socket, authenticates it, and stops listening before returning. */
  async accept(signal?: AbortSignal): Promise<ControlSession> {
    if (this.#acceptStarted) throw new ControlSessionError('already_accepted');
    if (this.#closed) throw new ControlSessionError('listener_closed');
    this.#acceptStarted = true;
    if (signal?.aborted) {
      this.#closed = true;
      this.#discardPendingConnection();
      this.#stopAccepting();
      throw new ControlSessionError('cancelled', signal.reason);
    }
    if (this.#serverFailure !== undefined) {
      this.#closed = true;
      this.#discardPendingConnection();
      this.#stopAccepting();
      throw new ControlSessionError('listener_failed', this.#serverFailure);
    }

    const socket = this.#connection;
    if (socket !== undefined) {
      this.#connection = undefined;
      return await this.#authenticate(socket, signal);
    }

    const accepted = new Promise<Socket>((resolve, reject) => {
      const onAbort = (): void => {
        this.#closed = true;
        this.#stopAccepting();
        this.#discardPendingConnection();
        reject(new ControlSessionError('cancelled', signal?.reason));
      };
      this.#acceptReject = reject;
      this.#acceptResolve = resolve;
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#acceptCleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        this.#acceptReject = undefined;
        this.#acceptResolve = undefined;
      };
      if (signal?.aborted) onAbort();
      else if (this.#serverFailure !== undefined) {
        reject(new ControlSessionError('listener_failed', this.#serverFailure));
      } else if (this.#connection !== undefined) {
        const connected = this.#connection;
        this.#connection = undefined;
        resolve(connected);
      } else if (this.#closed) {
        reject(new ControlSessionError('listener_closed'));
      }
    });

    let acceptedSocket: Socket;
    try {
      acceptedSocket = await accepted;
      if (this.#connection === acceptedSocket) this.#connection = undefined;
    } finally {
      this.#acceptCleanup?.();
    }
    return await this.#authenticate(acceptedSocket, signal);
  }

  /** Stops accepting and waits until the transferred plugin socket has been closed. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#acceptReject?.(new ControlSessionError('listener_closed'));
    this.#discardPendingConnection();
    this.#authenticationSocket?.destroy();
    this.#stopAccepting();
    await this.#closePromise;
  }

  #acceptCleanup: (() => void) | undefined;

  #onConnection(socket: Socket): void {
    if (this.#closed || this.#connectionSeen) {
      socket.destroy();
      return;
    }
    this.#connectionSeen = true;
    this.#connection = socket;
    this.#stopAccepting();
    this.#acceptResolve?.(socket);
  }

  async #authenticate(socket: Socket, signal?: AbortSignal): Promise<ControlSession> {
    this.#authenticationSocket = socket;
    const reader = new ControlFrameReader(socket);
    const onAbort = (): void => {
      socket.destroy();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const receiver = new ControlReceiver(
        this.#options.runId,
        this.#options.token,
        this.#options.capabilities,
      );
      const hello = receiver.acceptFrame(await reader.readFrame());
      if (signal?.aborted) throw new ControlSessionError('cancelled', signal.reason);
      if (hello.type !== 'hello') throw new ControlSessionError('invalid_handshake');

      const acknowledgmentSequence = 1n;
      await writeFrame(socket, encodeControlFrame({
        protocol: 1,
        run_id: this.#options.runId,
        sequence: acknowledgmentSequence,
        correlation: hello.sequence,
        type: 'ack',
        payload: {},
      }));
      receiver.expectReadyAfter(acknowledgmentSequence);

      const ready = receiver.acceptFrame(await reader.readFrame());
      if (signal?.aborted) throw new ControlSessionError('cancelled', signal.reason);
      if (ready.type !== 'ready') throw new ControlSessionError('invalid_handshake');
      return new AuthenticatedControlSession(socket, reader, receiver, this.#options.runId, ready, acknowledgmentSequence);
    } catch (error) {
      socket.destroy();
      if (signal?.aborted) throw new ControlSessionError('cancelled', signal.reason);
      throw mapControlFailure(error);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (this.#authenticationSocket === socket) this.#authenticationSocket = undefined;
    }
  }

  #stopAccepting(): void {
    if (this.#closePromise !== undefined) return;
    this.#closePromise = new Promise<void>((resolve, reject) => {
      try {
        this.#server.close((error) => {
          if (error !== undefined) reject(new ControlSessionError('listener_failed', error));
          else resolve();
        });
      } catch (error) {
        if (isNodeError(error) && error.code === 'ERR_SERVER_NOT_RUNNING') resolve();
        else reject(new ControlSessionError('listener_failed', error));
      }
    });
  }

  #discardPendingConnection(): void {
    this.#connection?.destroy();
    this.#connection = undefined;
  }
}

/** Binds before child startup; the caller owns the returned lease until shutdown. */
export async function bindControlListener(options: ControlListenerOptions): Promise<ControlListenerLease> {
  const server = createServer();
  const listening = once(server, 'listening');
  server.listen({ host: CONTROL_HOST, port: 0, exclusive: true });
  try {
    await listening;
    const address = server.address();
    if (address === null || typeof address === 'string' || address.address !== CONTROL_HOST) {
      throw new ControlSessionError('listener_failed');
    }
    return new TcpControlListenerLease(server, address, options);
  } catch (error) {
    server.close();
    throw new ControlSessionError('listener_failed', error);
  }
}

/** Owns the authenticated plugin socket and its independent runner sequence. */
export interface ControlSession {
  readonly ready: Extract<ControlMessage, { readonly type: 'ready' }>;
  send(command: RunnerCommand): Promise<RunnerCommandEnvelope>;
  messages(): AsyncGenerator<ControlMessage>;
  close(): Promise<void>;
}

class AuthenticatedControlSession implements ControlSession {
  readonly ready: Extract<ControlMessage, { readonly type: 'ready' }>;
  readonly #socket: Socket;
  readonly #reader: ControlFrameReader;
  readonly #receiver: ControlReceiver;
  readonly #runId: string;
  #outgoingSequence: bigint;
  #pendingAcknowledgment: bigint | undefined;
  #messagesStarted = false;
  #terminal = false;
  #closePromise: Promise<void> | undefined;
  #socketFailure: unknown;

  constructor(
    socket: Socket,
    reader: ControlFrameReader,
    receiver: ControlReceiver,
    runId: string,
    ready: Extract<ControlMessage, { readonly type: 'ready' }>,
    lastOutgoingSequence: bigint,
  ) {
    this.#socket = socket;
    this.#reader = reader;
    this.#receiver = receiver;
    this.#runId = runId;
    this.ready = ready;
    authenticatedMessages.add(ready);
    this.#outgoingSequence = lastOutgoingSequence;
    this.#socket.on('error', (error) => { this.#socketFailure = error; });
  }

  /** Sends one command without retrying it and returns its correlation sequence. */
  async send(command: RunnerCommand): Promise<RunnerCommandEnvelope> {
    this.#assertOpen();
    if (this.#terminal) throw new ControlSessionError('control_closed');
    if (this.#pendingAcknowledgment !== undefined) throw new ControlSessionError('command_pending');
    const sequence = this.#nextSequence();
    const envelope = {
      protocol: 1 as const,
      run_id: this.#runId,
      sequence,
    };
    const commandEnvelope: RunnerCommandEnvelope = command.type === 'prepare'
      ? { ...envelope, type: 'prepare', payload: command.payload }
      : command.type === 'start'
        ? { ...envelope, type: 'start', payload: command.payload }
        : { ...envelope, type: 'abort', payload: command.payload };
    let message: RunnerCommandEnvelope;
    let frame: Uint8Array;
    try {
      frame = encodeControlFrame(commandEnvelope);
      const decoded = decodeControlFrame(frame);
      if (decoded.type !== 'prepare' && decoded.type !== 'start' && decoded.type !== 'abort') {
        throw new ControlSessionError('control_protocol');
      }
      message = decoded;
    } catch (error) {
      throw mapControlFailure(error);
    }
    this.#pendingAcknowledgment = sequence;
    try {
      await writeFrame(this.#socket, frame);
      authenticatedMessages.add(message);
      return message;
    } catch (error) {
      this.#pendingAcknowledgment = undefined;
      this.#terminal = true;
      this.#socket.destroy();
      throw new ControlSessionError('control_write_failed', error);
    }
  }

  /** Reads accepted plugin messages with TCP backpressure and no application-side drop queue. */
  async *messages(): AsyncGenerator<ControlMessage> {
    if (this.#messagesStarted) throw new ControlSessionError('control_closed');
    this.#messagesStarted = true;
    while (!this.#terminal) {
      this.#assertOpen();
      let message: ControlMessage;
      try {
        message = this.#receiver.acceptFrame(await this.#reader.readFrame());
      } catch (error) {
        const failure = mapControlFailure(this.#socketFailure ?? error);
        this.#terminateAfterProtocolFailure();
        throw failure;
      }
      if (message.type === 'ack') {
        if (this.#pendingAcknowledgment === undefined || message.correlation !== this.#pendingAcknowledgment) {
          this.#terminateAfterProtocolFailure();
          throw new ControlSessionError('invalid_acknowledgment');
        }
        this.#pendingAcknowledgment = undefined;
      } else if (message.type === 'error') {
        if (this.#pendingAcknowledgment === undefined || message.correlation !== this.#pendingAcknowledgment) {
          this.#terminateAfterProtocolFailure();
          throw new ControlSessionError('invalid_acknowledgment');
        }
        this.#pendingAcknowledgment = undefined;
      } else if (message.correlation !== undefined) {
        this.#terminateAfterProtocolFailure();
        throw new ControlSessionError('control_protocol');
      }
      if (message.type === 'outcome') this.#terminal = true;
      authenticatedMessages.add(message);
      yield message;
    }
  }

  /** Closes the accepted socket; repeated cleanup calls share one completion. */
  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return await this.#closePromise;
    this.#closePromise = new Promise<void>((resolve) => {
      if (this.#socket.closed) {
        resolve();
        return;
      }
      this.#socket.once('close', () => resolve());
      this.#socket.destroy();
    });
    await this.#closePromise;
  }

  #nextSequence(): bigint {
    if (this.#outgoingSequence >= MAX_U64) throw new ControlSessionError('sequence_exhausted');
    this.#outgoingSequence += 1n;
    return this.#outgoingSequence;
  }

  #assertOpen(): void {
    if (this.#socketFailure !== undefined) throw new ControlSessionError('control_disconnected', this.#socketFailure);
    if (this.#socket.destroyed) throw new ControlSessionError('control_closed');
  }

  #terminateAfterProtocolFailure(): void {
    this.#terminal = true;
    this.#socket.destroy();
  }
}

class ControlFrameReader {
  readonly #iterator: AsyncIterator<Buffer>;
  readonly #chunks: Buffer[] = [];
  #bufferedBytes = 0;

  constructor(socket: Socket) {
    this.#iterator = socket[Symbol.asyncIterator]();
  }

  async readFrame(): Promise<Buffer> {
    await this.#fill(4);
    const header = this.#peek(4);
    const bodyLength = header.readUInt32BE(0);
    if (bodyLength === 0) throw new ControlSessionError('control_protocol');
    if (bodyLength > MAX_CONTROL_FRAME_BYTES) throw new ControlSessionError('control_protocol');
    await this.#fill(bodyLength + 4);
    return this.#take(bodyLength + 4);
  }

  async #fill(requiredBytes: number): Promise<void> {
    while (this.#bufferedBytes < requiredBytes) {
      const next = await this.#iterator.next();
      if (next.done) {
        throw new ControlSessionError(this.#bufferedBytes === 0 ? 'control_disconnected' : 'control_protocol');
      }
      const chunk = Buffer.from(next.value);
      this.#chunks.push(chunk);
      this.#bufferedBytes += chunk.byteLength;
    }
  }

  #peek(byteLength: number): Buffer {
    const result = Buffer.allocUnsafe(byteLength);
    let offset = 0;
    for (const chunk of this.#chunks) {
      const copied = chunk.copy(result, offset, 0, Math.min(chunk.byteLength, byteLength - offset));
      offset += copied;
      if (offset === byteLength) break;
    }
    return result;
  }

  #take(byteLength: number): Buffer {
    const result = Buffer.allocUnsafe(byteLength);
    let offset = 0;
    while (offset < byteLength) {
      const chunk = this.#chunks[0];
      if (chunk === undefined) throw new ControlSessionError('control_protocol');
      const copied = chunk.copy(result, offset, 0, Math.min(chunk.byteLength, byteLength - offset));
      offset += copied;
      this.#bufferedBytes -= copied;
      if (copied === chunk.byteLength) this.#chunks.shift();
      else this.#chunks[0] = chunk.subarray(copied);
    }
    return result;
  }
}

async function writeFrame(socket: Socket, frame: Uint8Array): Promise<void> {
  if (socket.destroyed) throw new ControlSessionError('control_closed');
  await new Promise<void>((resolve, reject) => {
    socket.write(frame, (error?: Error | null) => {
      if (error !== undefined && error !== null) reject(error);
      else resolve();
    });
  });
}

function mapControlFailure(error: unknown): ControlSessionError {
  if (error instanceof ControlSessionError) return error;
  if (error instanceof ControlCodecError) {
    if (error.code === 'authentication_failed') return new ControlSessionError('authentication_failed', error);
    if (error.code === 'unsupported_capability') return new ControlSessionError('unsupported_capability', error);
    if (error.code === 'invalid_handshake') return new ControlSessionError('invalid_handshake', error);
    return new ControlSessionError('control_protocol', error);
  }
  return new ControlSessionError('control_protocol', error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && typeof error.code === 'string';
}
