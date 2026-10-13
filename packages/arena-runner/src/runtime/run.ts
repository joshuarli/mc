import {
  DeterministicRandom,
  RandomStream,
  decide,
  emptyPolicyMemory,
  normalizePolicyReplayInput,
  seatId,
  type PolicyMemory,
} from '@arena/core';
import { compilePolicy, MAX_SOURCE_BYTES, SpecError } from '@arena/spec';
import type { ControlMessage, OutcomePayload } from '../control/index.js';
import { reconstructEventResult } from '../event-report.js';
import { RunnerError } from '../errors.js';
import {
  acquireOwnedRunLease,
  createOwnedDirectory,
  OwnedFilesError,
  readOwnedFile,
} from '../owned-files/index.js';
import type { OwnedRunLease } from '../owned-files/index.js';
import type { PreparedRun } from '../prepare.js';
import { resolveScenarioResource } from '../prepare.js';
import { makePolicyEffectRecord, makePolicyReplayRecord } from '../policy-replay.js';
import type { PolicyPathUpdate } from '../policy-replay.js';
import { bindControlListener, ControlSessionError, createControlToken } from './session.js';
import type { ControlListenerLease, ControlSession, RunnerCommand, RunnerCommandEnvelope } from './session.js';
import { RuntimeTraceBuilder } from './trace.js';
import { clonePristineWorld } from './world.js';
import {
  collectClientFailures,
  connectCompetitor,
  connectSpectator,
  RuntimeCompetitorClient,
  RuntimeSpectatorClient,
} from './clients.js';
import { createPreparePayload, createRuntimeRoster } from './roster.js';
import {
  paperArguments,
  readRuntimePluginJar,
  serverWorkingDirectory,
  stageServerDirectory,
  validateJavaTempDirectory,
} from './server.js';
import type { RuntimeServerInputs } from './server.js';
import { readStoppedPlayerStats } from './observations.js';
import type {
  ActiveRunEvaluator,
  ActiveRunEvaluationContext,
  CompletedOwnedRun,
  RuntimeAuthorityEvent,
} from './types.js';
import { startOwnedServerProcess } from './process.js';
import type { OwnedServerProcess, ServerProcessExit } from './process.js';
import type { PartiallyComputedPath } from 'mineflayer-pathfinder';
import { TextDecoder } from 'node:util';

const CONTROL_CAPABILITIES = Object.freeze(['hunger_games_v1'] as const);
const SERVER_DIRECTORY = Buffer.from('/server', 'ascii');
const CLIENT_HOST = '127.0.0.1' as const;
const GAME_PORT = 25565;
const STARTUP_TIMEOUT_MS = 60_000;
const EVALUATOR_JOIN_TIMEOUT_MS = 5_000;
const MAX_CRITICAL_EVENTS = 100_000;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export interface RunPreparedRunOptions {
  readonly preparedRun: PreparedRun;
  readonly helperPath: string;
  readonly ownedRoot: Buffer;
  readonly javaExecutable: string;
  readonly paperJarPath: string;
  readonly pluginJarPath: string;
  readonly signal?: AbortSignal;
  readonly evaluate?: ActiveRunEvaluator;
  readonly competitorDriver?: 'baselinePolicy' | 'evaluator';
}

/** Owns a headless Paper run from its pristine world through stopped evidence. */
export async function runPreparedRun(options: RunPreparedRunOptions): Promise<CompletedOwnedRun> {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onParentAbort, { once: true });
  if (options.signal?.aborted) onParentAbort();

  const runSignal = controller.signal;
  const abortPromise = abortSignalPromise(runSignal);
  void abortPromise.catch(() => {});
  const never = new Promise<never>(() => {});
  let leaseLost: Promise<never> = never;
  let lease: OwnedRunLease | undefined;
  let listener: ControlListenerLease | undefined;
  let session: ControlSession | undefined;
  let serverProcess: OwnedServerProcess | undefined;
  let coordinator: ControlCoordinator | undefined;
  let clients: readonly RuntimeCompetitorClient[] = [];
  let spectators: readonly RuntimeSpectatorClient[] = [];
  let evaluatorAbort: AbortController | undefined;
  let evaluatorTask: Promise<void> | undefined;
  let releaseLease = false;
  let matchOutcomeReceived = false;
  let startAttempted = false;
  let commandPending = false;

  try {
    assertRunning(runSignal);
    const scenario = options.preparedRun.scenario;
    const competitorDriver = options.competitorDriver ?? 'baselinePolicy';
    if (competitorDriver === 'evaluator' && options.evaluate === undefined) {
      throw new RunnerError('invalid_input', 'competitor driver', { kind: 'evaluator_missing' });
    }
    const javaTmpDir = validateJavaTempDirectory(options.ownedRoot);
    const policy = await loadPolicy(options, runSignal);
    const serverInputs: RuntimeServerInputs = { ...options, javaTmpDir, signal: runSignal };
    const pluginBytes = await readRuntimePluginJar(serverInputs);
    const roster = createRuntimeRoster(scenario);
    const preparePayload = createPreparePayload(scenario, roster.competitors);

    lease = await acquireOwnedRunLease({
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      relativePath: options.preparedRun.runDirectoryPath,
      signal: runSignal,
    });
    leaseLost = lease.closed.then((closed) => {
      if (closed.kind === 'lost') {
        controller.abort(closed.error);
        throw ownedFilesFailure(closed.error, 'prepared run lease');
      }
      return never;
    });
    void leaseLost.catch(() => {});

    const trace = new RuntimeTraceBuilder({
      runId: options.preparedRun.runId,
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      preparedRun: options.preparedRun,
    });
    const serverPath = Buffer.concat([options.preparedRun.runDirectoryPath, SERVER_DIRECTORY]);
    await createOwnedDirectory({
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      relativePath: serverPath,
      signal: runSignal,
    });
    await clonePristineWorld({
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      preparedRun: options.preparedRun,
      scenario,
      javaExecutable: options.javaExecutable,
      paperJarPath: options.paperJarPath,
      pluginJarPath: options.pluginJarPath,
      serverPath,
      signal: runSignal,
      createBootstrapWorld: async () => await createBootstrapWorld({
        options,
        inputs: serverInputs,
        pluginBytes,
        signal: runSignal,
        abortPromise,
        leaseLost,
      }),
    });

    await stageServerDirectory({
      inputs: serverInputs,
      scenario,
      relativePath: serverPath,
      pluginBytes,
      signal: runSignal,
    });

    const token = createControlToken();
    listener = await bindControlListener({
      runId: options.preparedRun.runId,
      token,
      capabilities: CONTROL_CAPABILITIES,
    });
    serverProcess = await startPaper(options, serverInputs, listener.address.port, token, runSignal);
    const processFailure = unexpectedExit(serverProcess);
    session = await withStartupTimeout(
      listener.accept(runSignal),
      processFailure,
      abortPromise,
      leaseLost,
    );
    await trace.recordReady(session.ready);

    const outcome = deferred<OutcomePayload>();
    void outcome.promise.catch(() => {});
    const completedEvents: RuntimeAuthorityEvent[] = [];
    coordinator = new ControlCoordinator({
      session,
      trace,
      runId: options.preparedRun.runId,
      prepare: preparePayload,
      completedEvents,
      outcome,
      processFailure,
      abortPromise,
      leaseLost,
      policy: competitorDriver === 'baselinePolicy' ? policy : undefined,
      policySeed: scenario.seed,
      competitors: () => clients,
      recordPolicy: scenario.record.policyReplay,
    });
    coordinator.startPump();

    const prepareEnvelope = await coordinator.send({ type: 'prepare', payload: preparePayload });
    if (prepareEnvelope.type !== 'prepare') {
      throw new RunnerError('runtime_failure', 'prepare command', { kind: 'invalid_prepare_envelope' });
    }
    const clientOptions = { host: CLIENT_HOST, port: GAME_PORT, scenario, signal: runSignal } as const;
    clients = roster.competitors.map((competitor) => new RuntimeCompetitorClient(
      competitor.seat,
      roster.competitorIdentities[competitor.seat]!,
      clientOptions,
    ));
    spectators = roster.spectators.map((identity) => new RuntimeSpectatorClient(identity));
    await raceWithRunState(
      Promise.all([
        ...clients.map((competitor) => connectCompetitor(competitor)),
        ...spectators.map((spectator) => connectSpectator(spectator, clientOptions)),
      ]),
      abortPromise,
      leaseLost,
      processFailure,
      coordinator.failure,
    );
    const startupFailure = collectClientFailures(clients, spectators);
    if (startupFailure !== undefined) throw startupFailure;

    const start = async (): Promise<void> => {
      if (startAttempted) throw new RunnerError('runtime_failure', 'match start', { kind: 'start_already_called' });
      startAttempted = true;
      commandPending = true;
      try {
        await coordinator!.send({ type: 'start', payload: {} });
      } finally {
        commandPending = false;
      }
    };
    const context: ActiveRunEvaluationContext = Object.freeze({
      preparedRun: options.preparedRun,
      ready: session.ready,
      prepare: prepareEnvelope,
      gameAddress: Object.freeze({ host: CLIENT_HOST, port: GAME_PORT }),
      competitors: Object.freeze([...clients]),
      spectators: Object.freeze([...spectators]),
      events: () => Object.freeze([...completedEvents]),
      start,
      waitForOutcome: () => outcome.promise,
      reconnectCompetitor: async (seat: number) => {
        if (matchOutcomeReceived) {
          throw new RunnerError('runtime_failure', 'competitor reconnect', { kind: 'outcome_already_received' });
        }
        const competitor = clients.find((candidate) => candidate.seat === seat);
        if (competitor === undefined) {
          throw new RunnerError('invalid_input', 'competitor seat', { kind: 'unknown_seat' });
        }
        return await raceWithRunState(
          competitor.reconnect(), abortPromise, leaseLost, processFailure, coordinator!.failure,
        );
      },
    });

    let finalOutcome: OutcomePayload;
    if (options.evaluate === undefined) {
      await start();
      finalOutcome = await raceWithRunState(
        outcome.promise, abortPromise, leaseLost, processFailure, coordinator.failure,
      );
    } else {
      evaluatorAbort = new AbortController();
      evaluatorTask = Promise.resolve(options.evaluate(context, evaluatorAbort.signal)).then(() => undefined);
      void evaluatorTask.catch(() => {});
      const callbackResult = await raceWithRunState(
        Promise.race([
          evaluatorTask.then(() => ({ kind: 'returned' as const })),
          outcome.promise.then((value) => ({ kind: 'outcome' as const, value })),
        ]),
        abortPromise,
        leaseLost,
        processFailure,
        coordinator.failure,
      );
      if (callbackResult.kind === 'returned') {
        if (!startAttempted) await start();
        finalOutcome = await raceWithRunState(
          outcome.promise, abortPromise, leaseLost, processFailure, coordinator.failure,
        );
      } else {
        finalOutcome = callbackResult.value;
      }
      evaluatorAbort.abort(new Error('match outcome received'));
      await withTimeout(evaluatorTask, EVALUATOR_JOIN_TIMEOUT_MS, 'evaluator_did_not_stop');
    }

    matchOutcomeReceived = true;
    evaluatorAbort?.abort(new Error('match completed'));
    await coordinator.stopPolicyTasks();
    await coordinator.join();
    const clientFailure = collectClientFailures(clients, spectators);
    if (clientFailure !== undefined) throw clientFailure;

    await closeClients(clients, spectators);
    const exit = await serverProcess.shutdown();
    assertSuccessfulExit(exit);
    await session.close();
    await listener.close();
    const traceResult = await trace.finalize();
    const stats = await readStoppedPlayerStats({
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      runDirectoryPath: options.preparedRun.runDirectoryPath,
      players: [...roster.competitorIdentities, ...roster.spectators],
      signal: runSignal,
    });
    await lease.release();
    releaseLease = true;
    return Object.freeze({
      runId: options.preparedRun.runId,
      ready: session.ready,
      events: Object.freeze([...completedEvents]),
      outcome: finalOutcome,
      trace: traceResult,
      competitors: roster.competitorIdentities,
      spectators: roster.spectators,
      stats,
    });
  } catch (error) {
    evaluatorAbort?.abort(error);
    const cleanupFailure = await cleanupOwnedRun({
      listener,
      session,
      process: serverProcess,
      clients,
      spectators,
      coordinator,
      hasOutcome: matchOutcomeReceived,
      started: startAttempted,
      commandPending,
      evaluatorTask,
      lease,
      releaseLease,
    });
    if (cleanupFailure !== undefined) {
      throw new RunnerError('runtime_failure', 'runtime cleanup', {
        kind: 'cleanup_failed',
        field: errorKind(cleanupFailure),
      });
    }
    throw mapRuntimeFailure(error);
  } finally {
    options.signal?.removeEventListener('abort', onParentAbort);
  }
}

class ControlCoordinator {
  readonly #session: ControlSession;
  readonly #trace: RuntimeTraceBuilder;
  readonly #runId: string;
  readonly #prepare: ReturnType<typeof createPreparePayload>;
  readonly #events: RuntimeAuthorityEvent[];
  readonly #outcome: Deferred<OutcomePayload>;
  readonly #processFailure: Promise<never>;
  readonly #abortPromise: Promise<never>;
  readonly #leaseLost: Promise<never>;
  readonly #competitors: () => readonly RuntimeCompetitorClient[];
  readonly #failureState = deferred<never>();
  readonly #traceOrder = new SerialExecutor();
  readonly #policyLoop: LivePolicyLoop | undefined;
  #failure: unknown;
  #pending: { readonly correlation: bigint; readonly acknowledgment: Deferred<ControlMessage> } | undefined;
  #runnerSequence: bigint;
  #outcomeReceived = false;
  #pump: Promise<void> | undefined;

  constructor(options: Readonly<{
    session: ControlSession;
    trace: RuntimeTraceBuilder;
    runId: string;
    prepare: ReturnType<typeof createPreparePayload>;
    completedEvents: RuntimeAuthorityEvent[];
    outcome: Deferred<OutcomePayload>;
    processFailure: Promise<never>;
    abortPromise: Promise<never>;
    leaseLost: Promise<never>;
    policy: ReturnType<typeof compilePolicy> | undefined;
    policySeed: bigint;
    competitors(): readonly RuntimeCompetitorClient[];
    recordPolicy: boolean;
  }>) {
    this.#session = options.session;
    this.#trace = options.trace;
    this.#runId = options.runId;
    this.#prepare = options.prepare;
    this.#events = options.completedEvents;
    this.#outcome = options.outcome;
    this.#processFailure = options.processFailure;
    this.#abortPromise = options.abortPromise;
    this.#leaseLost = options.leaseLost;
    this.#competitors = options.competitors;
    this.#runnerSequence = options.session.ready.correlation!;
    void this.#failureState.promise.catch(() => {});
    if (options.policy !== undefined) {
      this.#policyLoop = new LivePolicyLoop({
        trace: options.trace,
        params: options.policy.params,
        seed: options.policySeed,
        recordPolicy: options.recordPolicy,
        competitors: options.competitors,
        fail: (error) => this.#fail(error),
      });
    }
  }

  get failure(): Promise<never> {
    return this.#failureState.promise;
  }

  startPump(): void {
    if (this.#pump !== undefined) throw new RunnerError('runtime_failure', 'control session', { kind: 'pump_already_started' });
    this.#pump = this.#consume();
    void this.#pump.catch((error: unknown) => this.#fail(error));
  }

  async send(command: RunnerCommand): Promise<RunnerCommandEnvelope> {
    if (this.#pending !== undefined) throw new RunnerError('runtime_failure', 'control command', { kind: 'command_pending' });
    if (this.#outcomeReceived) throw new RunnerError('runtime_failure', 'control command', { kind: 'command_after_outcome' });
    const correlation = this.#runnerSequence + 1n;
    const acknowledgment = deferred<ControlMessage>();
    this.#pending = { correlation, acknowledgment };

    let envelope!: RunnerCommandEnvelope;
    try {
      await this.#traceOrder.run(async () => {
        envelope = await this.#session.send(command);
        if (envelope.sequence !== correlation) {
          throw new RunnerError('runtime_failure', 'control command', { kind: 'command_sequence_mismatch' });
        }
        await this.#trace.recordRunnerCommand(envelope);
        this.#runnerSequence = envelope.sequence;
      });
      const response = await raceWithRunState(
        acknowledgment.promise,
        this.#abortPromise,
        this.#leaseLost,
        this.#processFailure,
        this.failure,
      );
      if (response.type === 'error') {
        throw new RunnerError('runtime_failure', 'plugin control command', {
          kind: 'plugin_rejected_command',
          field: response.payload.code,
        });
      }
      return envelope;
    } catch (error) {
      this.#pending = undefined;
      throw error;
    }
  }

  async stopPolicyTasks(): Promise<void> {
    await this.#policyLoop?.stopAndJoin();
  }

  async join(): Promise<void> {
    await this.#pump;
  }

  async #consume(): Promise<void> {
    try {
      for await (const message of this.#session.messages()) {
        await this.#traceOrder.run(async () => {
          await this.#trace.recordControlMessage(message);
          if (message.type === 'ack' || message.type === 'error') {
            const pending = this.#pending;
            if (pending === undefined || message.correlation !== pending.correlation) {
              throw new RunnerError('runtime_failure', 'control acknowledgment', { kind: 'unexpected_acknowledgment' });
            }
            this.#pending = undefined;
            pending.acknowledgment.resolve(message);
            return;
          }
          if (!isAuthorityEvent(message)) return;
          if (this.#events.length >= MAX_CRITICAL_EVENTS) {
            throw new RunnerError('runtime_failure', 'control events', { kind: 'critical_event_limit_exceeded' });
          }
          this.#events.push(message);
          if (message.type === 'outcome') {
            this.#outcomeReceived = true;
            this.#policyLoop?.stopLaunching();
            try {
              reconstructEventResult(this.#runId, this.#prepare, this.#events);
            } catch (error) {
              throw new RunnerError('corrupt_evidence', 'authoritative match events', {
                kind: traceFailureKind(error),
              });
            }
            this.#outcome.resolve(message.payload);
          }
        });

        if (message.type === 'public_clock' && this.#policyLoop !== undefined
            && message.payload.tick?.domain === 'match'
            && (message.payload.phase === 'grace' || message.payload.phase === 'active')) {
          const value = Number(message.payload.tick.value);
          if (!Number.isSafeInteger(value)) throw new RunnerError('runtime_failure', 'policy clock', { kind: 'tick_out_of_range' });
          this.#policyLoop.onTick(value);
        }
      }
      if (!this.#outcomeReceived) throw new RunnerError('runtime_failure', 'control session', { kind: 'outcome_missing' });
    } catch (error) {
      this.#pending?.acknowledgment.reject(error);
      this.#pending = undefined;
      this.#outcome.reject(error);
      this.#fail(error);
      throw error;
    }
  }

  #fail(error: unknown): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    this.#pending?.acknowledgment.reject(error);
    this.#pending = undefined;
    this.#outcome.reject(error);
    this.#failureState.reject(mapRuntimeFailure(error));
  }
}

class LivePolicyLoop {
  readonly #trace: RuntimeTraceBuilder;
  readonly #params: ReturnType<typeof compilePolicy>['params'];
  readonly #seed: bigint;
  readonly #recordPolicy: boolean;
  readonly #competitors: () => readonly RuntimeCompetitorClient[];
  readonly #fail: (error: unknown) => void;
  readonly #memories = new Map<number, PolicyMemory>();
  readonly #randoms = new Map<number, DeterministicRandom>();
  readonly #tasks = new Map<number, Promise<void>>();
  readonly #completedMilestones = new Set<number>();
  #sequence = 0n;
  #observationCount = 0;
  #checkpointedCount = 0;
  #lastTick = -1;
  #stopped = false;
  #checkpointTail: Promise<void> = Promise.resolve();

  constructor(options: Readonly<{
    trace: RuntimeTraceBuilder;
    params: ReturnType<typeof compilePolicy>['params'];
    seed: bigint;
    recordPolicy: boolean;
    competitors(): readonly RuntimeCompetitorClient[];
    fail(error: unknown): void;
  }>) {
    this.#trace = options.trace;
    this.#params = options.params;
    this.#seed = options.seed;
    this.#recordPolicy = options.recordPolicy;
    this.#competitors = options.competitors;
    this.#fail = options.fail;
  }

  onTick(tick: number): void {
    if (this.#stopped) return;
    if (tick < this.#lastTick) {
      throw new RunnerError('corrupt_evidence', 'policy clock', { kind: 'non_monotonic_active_tick' });
    }
    if (tick === this.#lastTick) return;
    this.#lastTick = tick;
    for (const competitor of this.#competitors()) {
      if (this.#tasks.has(competitor.seat)) continue;
      const task = this.#runDecision(competitor, tick);
      this.#tasks.set(competitor.seat, task);
      void task.then(
        () => this.#removeTask(competitor.seat, task),
        (error: unknown) => {
          this.#removeTask(competitor.seat, task);
          this.#fail(error);
        },
      );
    }
  }

  stopLaunching(): void {
    this.#stopped = true;
  }

  async stopAndJoin(): Promise<void> {
    this.#stopped = true;
    const active = [...this.#tasks.entries()];
    if (active.length === 0) return;
    const cancellations = active.map(([seat]) => {
      const competitor = this.#competitors().find((candidate) => candidate.seat === seat);
      return competitor === undefined ? Promise.resolve() : competitor.client.cancel('shutdown');
    });
    const results = await Promise.allSettled([...cancellations, ...active.map(([, task]) => task)]);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed !== undefined) throw mapRuntimeFailure(failed.reason);
    await this.#checkpointTail;
  }

  async #runDecision(competitor: RuntimeCompetitorClient, tick: number): Promise<void> {
    const seat = competitor.seat;
    const observation = competitor.client.observe(tick);
    const memory = this.#memories.get(seat) ?? emptyPolicyMemory();
    const random = this.#randoms.get(seat)
      ?? DeterministicRandom.forStream(this.#seed, RandomStream.policy(seatId(seat)));
    const decision = decide(observation, memory, this.#params, random);
    this.#memories.set(seat, decision.memory);
    this.#randoms.set(seat, random);

    let sequence: bigint | undefined;
    let decisionRecorded: Promise<void> | undefined;
    if (this.#recordPolicy) {
      this.#sequence += 1n;
      sequence = this.#sequence;
      this.#observationCount += 1;
      const input = normalizePolicyReplayInput({ observation, memory, params: this.#params, random });
      decisionRecorded = this.#trace.recordPolicyDecision(
        makePolicyReplayRecord(sequence, seat, input, decision, random.snapshotState()),
      );
    }

    if (decision.intent.kind === 'hold') {
      if (decisionRecorded !== undefined) await decisionRecorded;
      if (sequence !== undefined) await this.#markCheckpoint(this.#observationCount);
      return;
    }

    const capture = this.#recordPolicy ? capturePathUpdates(competitor.bot) : undefined;
    const skillPromise = competitor.client.run(decision.intent);
    try {
      if (decisionRecorded !== undefined) await decisionRecorded;
      const skill = await skillPromise;
      if (sequence !== undefined) {
        await this.#trace.recordPolicyEffect(makePolicyEffectRecord(sequence, skill, capture!.values()));
        await this.#markCheckpoint(this.#observationCount);
      }
    } catch (error) {
      void competitor.client.cancel('shutdown').catch(() => {});
      await skillPromise.catch(() => {});
      throw error;
    } finally {
      capture?.close();
    }
  }

  #markCheckpoint(observationCount: number): Promise<void> {
    if (observationCount % 200 !== 0) return Promise.resolve();
    this.#completedMilestones.add(observationCount);
    this.#checkpointTail = this.#checkpointTail.then(async () => {
      while (this.#completedMilestones.has(this.#checkpointedCount + 200)) {
        this.#checkpointedCount += 200;
        this.#completedMilestones.delete(this.#checkpointedCount);
        await this.#trace.checkpoint(this.#checkpointedCount);
      }
    });
    return this.#checkpointTail;
  }

  #removeTask(seat: number, task: Promise<void>): void {
    if (this.#tasks.get(seat) === task) this.#tasks.delete(seat);
  }
}

async function loadPolicy(options: RunPreparedRunOptions, signal: AbortSignal) {
  let relativePath: Buffer;
  try {
    relativePath = resolveScenarioResource({
      scenarioPath: options.preparedRun.scenarioPath,
      reference: options.preparedRun.scenario.policyReference,
    });
  } catch (error) {
    if (error instanceof RunnerError) throw new RunnerError(error.category, 'policy reference', error.source);
    throw error;
  }

  let source: Buffer;
  try {
    source = await readOwnedFile({
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      relativePath,
      maxBytes: MAX_SOURCE_BYTES,
      signal,
    });
  } catch (error) {
    throw ownedFilesFailure(error, 'policy input');
  }

  let text: string;
  try {
    text = UTF8.decode(source);
  } catch {
    throw new RunnerError('invalid_input', 'policy input', { kind: 'invalid_utf8' });
  }
  try {
    return compilePolicy(text);
  } catch (error) {
    if (!(error instanceof SpecError)) throw error;
    throw new RunnerError('invalid_input', 'policy input', {
      kind: error.kind,
      field: error.path,
      ...(error.sourceLocation === undefined ? {} : {
        line: error.sourceLocation.line,
        column: error.sourceLocation.column,
      }),
    });
  }
}

async function createBootstrapWorld(options: Readonly<{
  options: RunPreparedRunOptions;
  inputs: RuntimeServerInputs;
  pluginBytes: Buffer;
  signal: AbortSignal;
  abortPromise: Promise<never>;
  leaseLost: Promise<never>;
}>): Promise<Buffer> {
  const serverPath = Buffer.from(`.work/arena/bootstrap/${options.options.preparedRun.runId}/server`, 'utf8');
  await createOwnedDirectory({
    helperPath: options.options.helperPath,
    ownedRoot: options.options.ownedRoot,
    relativePath: serverPath,
    signal: options.signal,
  });
  await stageServerDirectory({
    inputs: options.inputs,
    scenario: options.options.preparedRun.scenario,
    relativePath: serverPath,
    pluginBytes: options.pluginBytes,
    signal: options.signal,
  });

  const token = createControlToken();
  const listener = await bindControlListener({
    runId: options.options.preparedRun.runId,
    token,
    capabilities: CONTROL_CAPABILITIES,
  });
  let server: OwnedServerProcess | undefined;
  let session: ControlSession | undefined;
  try {
    server = await startPaper(
      options.options,
      options.inputs,
      listener.address.port,
      token,
      options.signal,
      serverPath,
    );
    session = await withStartupTimeout(
      listener.accept(options.signal),
      unexpectedExit(server),
      options.abortPromise,
      options.leaseLost,
    );
    assertSuccessfulExit(await server.shutdown());
  } catch (error) {
    if (server !== undefined) {
      try { await server.shutdown(); } catch { /* Keep the startup error. */ }
    }
    throw error;
  } finally {
    await session?.close();
    await listener.close();
  }
  return Buffer.concat([serverPath, Buffer.from('/world', 'ascii')]);
}

async function startPaper(
  options: RunPreparedRunOptions,
  inputs: RuntimeServerInputs,
  controlPort: number,
  token: string,
  signal: AbortSignal,
  serverPath: Buffer = Buffer.concat([options.preparedRun.runDirectoryPath, SERVER_DIRECTORY]),
): Promise<OwnedServerProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ARENA_CONTROL_TOKEN: token,
    ARENA_JAVA_TMPDIR: inputs.javaTmpDir,
  };
  try {
    return await startOwnedServerProcess({
      executable: options.javaExecutable,
      args: paperArguments(inputs, controlPort, options.preparedRun.runId),
      cwd: serverWorkingDirectory(options.ownedRoot, serverPath),
      env,
      signal,
    });
  } catch (error) {
    throw mapRuntimeFailure(error);
  }
}

function capturePathUpdates(bot: RuntimeCompetitorClient['bot']): Readonly<{
  close(): void;
  values(): readonly PolicyPathUpdate[];
}> {
  let latest: PolicyPathUpdate | undefined;
  let failure: RunnerError | undefined;
  const onPathUpdate = (update: PartiallyComputedPath): void => {
    try {
      const path = update.path.map((point) => {
        if (![point.x, point.y, point.z].every(Number.isFinite)) {
          throw new RunnerError('runtime_failure', 'path update', { kind: 'invalid_path_coordinate' });
        }
        return Object.freeze({ x: point.x, y: point.y, z: point.z });
      });
      latest = Object.freeze({ status: update.status, path: Object.freeze(path) });
    } catch (error) {
      failure ??= mapRuntimeFailure(error);
    }
  };
  bot.on('path_update', onPathUpdate);
  return Object.freeze({
    close: () => bot.removeListener('path_update', onPathUpdate),
    values: () => {
      if (failure !== undefined) throw failure;
      return latest === undefined ? Object.freeze([]) : Object.freeze([latest]);
    },
  });
}

async function closeClients(
  clients: readonly RuntimeCompetitorClient[],
  spectators: readonly RuntimeSpectatorClient[],
): Promise<void> {
  const results = await Promise.allSettled([
    ...clients.map((client) => client.close()),
    ...spectators.map((client) => client.close()),
  ]);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure !== undefined) throw mapRuntimeFailure(failure.reason);
}

async function cleanupOwnedRun(options: Readonly<{
  listener: ControlListenerLease | undefined;
  session: ControlSession | undefined;
  process: OwnedServerProcess | undefined;
  clients: readonly RuntimeCompetitorClient[];
  spectators: readonly RuntimeSpectatorClient[];
  coordinator: ControlCoordinator | undefined;
  hasOutcome: boolean;
  started: boolean;
  commandPending: boolean;
  evaluatorTask: Promise<void> | undefined;
  lease: OwnedRunLease | undefined;
  releaseLease: boolean;
}>): Promise<unknown | undefined> {
  let failure: unknown;
  if (options.coordinator !== undefined && options.started && !options.commandPending && !options.hasOutcome) {
    try {
      await options.coordinator.send({ type: 'abort', payload: { reason: 'protocol_error' } });
    } catch (error) {
      if (!(error instanceof ControlSessionError && error.code === 'control_closed')) failure ??= error;
    }
  }
  const clientsClosed = await Promise.allSettled([
    ...options.clients.map((client) => client.close()),
    ...options.spectators.map((client) => client.close()),
  ]);
  const clientFailure = clientsClosed.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  failure ??= clientFailure?.reason;
  if (options.coordinator !== undefined) {
    try { await options.coordinator.stopPolicyTasks(); } catch (error) { failure ??= error; }
    try { await options.coordinator.join(); } catch { /* The initiating failure already explains the pump error. */ }
  }
  try { await options.process?.shutdown(); } catch (error) { failure ??= error; }
  try { await options.session?.close(); } catch (error) { failure ??= error; }
  try { await options.listener?.close(); } catch (error) { failure ??= error; }
  if (options.evaluatorTask !== undefined) {
    try { await withTimeout(options.evaluatorTask, EVALUATOR_JOIN_TIMEOUT_MS, 'evaluator_did_not_stop'); }
    catch (error) { failure ??= error; }
  }
  if (options.lease !== undefined && !options.releaseLease) {
    try { await options.lease.release(); } catch (error) { failure ??= error; }
  }
  return failure;
}

function isAuthorityEvent(message: ControlMessage): message is RuntimeAuthorityEvent {
  return message.type === 'public_clock' || message.type === 'public_state'
    || message.type === 'elimination' || message.type === 'outcome';
}

function unexpectedExit(process: OwnedServerProcess): Promise<never> {
  return process.exited.then((exit) => {
    throw new RunnerError('runtime_failure', 'Paper server', {
      kind: 'server_exited_before_shutdown',
      ...(exit.code === null ? {} : { field: String(exit.code) }),
    });
  });
}

function withStartupTimeout<T>(
  operation: Promise<T>,
  processFailure: Promise<never>,
  abortPromise: Promise<never>,
  leaseLost: Promise<never>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RunnerError('runtime_failure', 'Paper startup', { kind: 'control_ready_timeout' })), STARTUP_TIMEOUT_MS);
  });
  return Promise.race([operation, processFailure, abortPromise, leaseLost, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function abortSignalPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(cancelledFailure());
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(cancelledFailure()), { once: true });
  });
}

function assertRunning(signal: AbortSignal): void {
  if (signal.aborted) throw cancelledFailure();
}

function cancelledFailure(): RunnerError {
  return new RunnerError('runtime_failure', 'arena run', { kind: 'cancelled' });
}

function raceWithRunState<T>(promise: Promise<T>, ...failures: readonly Promise<never>[]): Promise<T> {
  return Promise.race([promise, ...failures]);
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

class SerialExecutor {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, kind: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RunnerError('runtime_failure', 'active evaluator', { kind })), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assertSuccessfulExit(exit: ServerProcessExit): void {
  if (exit.code !== 0 || exit.signal !== null) {
    throw new RunnerError('runtime_failure', 'Paper server', {
      kind: 'server_exit_failed',
      ...(exit.code === null ? {} : { field: String(exit.code) }),
    });
  }
}

function traceFailureKind(error: unknown): string {
  if (error instanceof Error && 'kind' in error && typeof error.kind === 'string') return error.kind;
  return 'invalid_authoritative_events';
}

function ownedFilesFailure(error: unknown, resource: string): RunnerError {
  if (!(error instanceof OwnedFilesError)) {
    return new RunnerError('runtime_failure', resource, { kind: 'owned_file_operation' });
  }
  const category = error.category === 'not_found' || error.category === 'helper_start'
    ? 'missing_prerequisite'
    : error.category === 'invalid_path' || error.category === 'too_large'
      ? 'invalid_input'
      : 'runtime_failure';
  return new RunnerError(category, resource, {
    kind: error.category,
    ...(error.errno === undefined ? {} : { os_code: error.errno }),
  });
}

function controlFailure(error: ControlSessionError): RunnerError {
  return new RunnerError('runtime_failure', 'control session', { kind: error.code });
}

function mapRuntimeFailure(error: unknown): RunnerError {
  if (error instanceof RunnerError) return error;
  if (error instanceof ControlSessionError) return controlFailure(error);
  if (error instanceof OwnedFilesError) return ownedFilesFailure(error, 'owned run');
  return new RunnerError('runtime_failure', 'arena run', { kind: errorKind(error) });
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown_error';
}
