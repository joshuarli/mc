import { compilePolicy, MAX_SOURCE_BYTES, SpecError } from '@arena/spec';
import type { OpeningStyleCycle } from '@arena/spec';
import type { AbortReason, ClockPayload, ControlCapability, ControlMessage, OutcomePayload } from '../control/index.js';
import { CONTROL_CAPABILITIES } from '../control/index.js';
import { reconstructEventResult } from '../event-report.js';
import { RunnerError } from '../errors.js';
import {
  acquireOwnedRunLease,
  createOwnedDirectory,
  readOwnedFile,
} from '../owned-files/index.js';
import type { OwnedRunLease } from '../owned-files/index.js';
import type { PreparedRun } from '../prepare.js';
import { resolveScenarioResource } from '../prepare.js';
import { bindControlListener, ControlSessionError, createControlToken } from './session.js';
import type { ControlListenerLease, ControlSession, RunnerCommand, RunnerCommandEnvelope } from './session.js';
import { RuntimeTraceBuilder } from './trace.js';
import {
  cancelledFailure,
  cleanupErrorUnlessPrimary,
  failureCleanup,
  mapRuntimeFailure,
  ownedFilesFailure,
  withCleanupFailure,
} from './failures.js';
import { clonePristineWorld } from './world.js';
import { LivePolicyLoop, type PolicyActivityEvent } from './live-policy-loop.js';
import { joinEvaluatorAfterOutcome } from './evaluator.js';
import { armRuntimeDeadline, COLD_START_TIMEOUT_MS, type RuntimeDeadline } from './deadline.js';
import {
  collectClientFailures,
  connectCompetitor,
  connectSpectator,
  RuntimeCompetitorClient,
  RuntimeSpectatorClient,
} from './clients.js';
import { createPreparePayload, createRuntimeRoster, type RuntimeSpectatorMode } from './roster.js';
import { externalSeats } from '../effective-scenario.js';
import { ActionFunnelCollector, flushDiagnosticRings } from './funnel.js';
import { launchWorkerProcess, WorkerCohort, type WorkerLauncher } from '../workers/cohort.js';
import { parseWorkerCount } from '../workers/assignment.js';
import { persistCheckpoint, type LoadedCheckpoint } from '../checkpoint/persist.js';
import { publishSaveResult, readSaveRequest } from '../checkpoint/save-request.js';
import type { ExternalSeatRequest } from '../effective-scenario.js';
import type { CheckpointWrittenPayload } from '../control/types.js';
import type { SeatPolicyState } from './live-policy-loop.js';
import { cloneOwnedTree, MAX_OWNED_TREE_BYTES, MAX_OWNED_TREE_FILES } from '../owned-files/index.js';
import { resolve as resolvePath } from 'node:path';
import { compileCandidate, type CandidateId, type CompiledCandidate } from '@arena/core';
import { assertEventSeatsInRoster } from './roster-bounds.js';
import {
  paperArguments,
  readRuntimePluginJar,
  serverWorkingDirectory,
  stageServerDirectory,
  DEFAULT_GAME_PORT,
  validateJavaTempDirectory,
} from './server.js';
import type { RuntimeServerInputs } from './server.js';
import { readStoppedPlayerStats } from './observations.js';
import {
  assertRuntimePluginIdentity,
  assertRuntimePluginCapability,
  readRuntimePluginIdentity,
  type RuntimePluginIdentity,
} from './plugin-identity.js';
import type {
  ActiveRunEvaluator,
  ActiveRunEvaluationContext,
  CompletedOwnedRun,
  RuntimeAuthorityEvent,
} from './types.js';
import { startOwnedServerProcess } from './process.js';
import { reserveEphemeralGamePort } from './game-port.js';
import type { OwnedServerProcess, ServerProcessExit } from './process.js';
import type { OperationalFailurePrimaryV1 } from './failure-artifact.js';
import { TextDecoder } from 'node:util';
import {
  DEFAULT_EXTERNAL_JOIN_TIMEOUT_MS,
  waitForExternalPlayer,
  type ExternalAdmission,
} from './external-player-gate.js';

function requiredControlCapabilities(
  scenario: PreparedRun['scenario'],
): readonly ControlCapability[] {
  switch (scenario.mode) {
    case 'hunger_games': return scenario.schemaVersion === 3 || externalSeats(scenario).length > 0
      ? ['hunger_games_v1', 'hunger_games_roster_v2']
      : ['hunger_games_v1'];
    case 'civilization': return ['civilization_v1'];
  }
}

function assertRuntimePluginCapabilities(
  ready: Parameters<typeof assertRuntimePluginCapability>[0],
  scenario: PreparedRun['scenario'],
  resume = false,
): void {
  const required = resume
    ? [...new Set([...requiredControlCapabilities(scenario), 'hunger_games_roster_v2' as const, 'checkpoint_v1' as const])]
    : requiredControlCapabilities(scenario);
  for (const capability of required) {
    assertRuntimePluginCapability(ready, capability);
  }
}
const SERVER_DIRECTORY = Buffer.from('/server', 'ascii');
const CLIENT_HOST = '127.0.0.1' as const;
const STARTUP_TIMEOUT_MS = 60_000;
const EVALUATOR_JOIN_TIMEOUT_MS = 5_000;
const MAX_RETAINED_AUTHORITY_EVENTS = 100_000;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export interface RunPreparedRunOptions {
  readonly preparedRun: PreparedRun;
  readonly helperPath: string;
  readonly ownedRoot: Buffer;
  readonly javaExecutable: string;
  readonly paperJarPath: string;
  readonly pluginJarPath: string;
  readonly acceptMinecraftEula: true;
  readonly signal?: AbortSignal;
  readonly coldStartDeadline?: RuntimeDeadline;
  readonly evaluate?: ActiveRunEvaluator;
  readonly competitorDriver?: 'baselinePolicy' | 'evaluator';
  readonly spectatorMode?: RuntimeSpectatorMode;
  readonly waitForExternalPlayer?: true;
  readonly ephemeralGamePort?: true;
  readonly serverLogsToStderr?: true;
  readonly externalJoinTimeoutMs?: number;
  readonly workers?: number;
  readonly checkpointing?: true;
  readonly checkpointScenario?: Readonly<{ externalSeat: ExternalSeatRequest | null }>;
  readonly resume?: LoadedCheckpoint;
  readonly seatCandidates?: ReadonlyMap<number, Readonly<{ id: CandidateId; params?: Readonly<Record<string, number>> }>>;
  readonly workerLauncher?: WorkerLauncher;
  readonly onExternalAdmitted?: (username: string) => void;
  readonly onUnexpectedPlayer?: (username: string) => void;
  readonly onPhase?: (phase: ClockPayload['phase']) => void;
  readonly onPolicyActivity?: (event: PolicyActivityEvent) => void;
  readonly onServerStarted?: (pid: number) => void;
  readonly onMetrics?: (payload: import('../control/types.js').MetricsPayload) => void;
  readonly onAuthorityEvent?: (event: RuntimeAuthorityEvent, arrivalNs: bigint) => void;
  readonly onWorkerCohort?: (handle: {
    reset(): void;
    request(): Promise<readonly import('../workers/cohort.js').WorkerCohortTelemetry[]>;
  }) => void;
  readonly onRosterReady?: (details: Readonly<{
    host: typeof CLIENT_HOST;
    port: number;
    minecraftVersion: string;
    protocolVersion: number;
  }>) => void;
}

export async function runPreparedRun(options: RunPreparedRunOptions): Promise<CompletedOwnedRun> {
  if (options.acceptMinecraftEula !== true) {
    throw new RunnerError('missing_prerequisite', 'Minecraft EULA', { kind: 'missing_eula' });
  }
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(abortFailure(options.signal!));
  options.signal?.addEventListener('abort', onParentAbort, { once: true });
  if (options.signal?.aborted) onParentAbort();

  const runSignal = controller.signal;
  const coldStartDeadline = options.coldStartDeadline
    ?? armRuntimeDeadline(controller, 'cold_start', COLD_START_TIMEOUT_MS);
  const awaitsExternalCompetitor = externalSeats(options.preparedRun.scenario).length > 0;
  const externalJoinTimeoutMs = options.externalJoinTimeoutMs ?? DEFAULT_EXTERNAL_JOIN_TIMEOUT_MS;
  const wallClockDeadline = armRuntimeDeadline(controller, 'wall_clock',
    (options.preparedRun.scenario.mode === 'civilization' ? 1_200_000 : 600_000)
    + (awaitsExternalCompetitor ? externalJoinTimeoutMs : 0));
  const abortPromise = Promise.race([
    abortSignalPromise(runSignal),
    coldStartDeadline.failure,
    wallClockDeadline.failure,
  ]);
  void abortPromise.catch(() => {});
  const never = new Promise<never>(() => {});
  let leaseLost: Promise<never> = never;
  let lease: OwnedRunLease | undefined;
  let listener: ControlListenerLease | undefined;
  let session: ControlSession | undefined;
  let serverProcess: OwnedServerProcess | undefined;
  let trace: RuntimeTraceBuilder | undefined;
  let coordinator: ControlCoordinator | undefined;
  let funnel: ActionFunnelCollector | undefined;
  let cohort: WorkerCohort | undefined;
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
    const spectatorMode = options.spectatorMode ?? 'automated';
    const roster = createRuntimeRoster(scenario, { spectatorMode });
    const competitorDriver = options.competitorDriver ?? 'baselinePolicy';
    if (competitorDriver === 'evaluator' && options.evaluate === undefined) {
      throw new RunnerError('invalid_input', 'competitor driver', { kind: 'evaluator_missing' });
    }
    const javaTmpDir = validateJavaTempDirectory(options.ownedRoot);
    const gamePort = options.ephemeralGamePort === true ? await reserveEphemeralGamePort() : DEFAULT_GAME_PORT;
    const workerCount = parseWorkerCount(options.workers ?? 1);
    if (workerCount > 1 && (scenario.mode !== 'hunger_games' || competitorDriver !== 'baselinePolicy'
        || options.evaluate !== undefined)) {
      throw new RunnerError('invalid_input', 'worker count', { kind: 'workers_require_unattended_hunger_games' });
    }
    const seatCandidates = new Map<number, CompiledCandidate>();
    for (const [seat, request] of options.seatCandidates ?? []) {
      if (scenario.mode !== 'hunger_games' || !roster.botCompetitors.some((entry) => entry.seat === seat)) {
        throw new RunnerError('invalid_input', 'seat candidate', { kind: 'candidate_seat_not_a_bot_seat', field: String(seat) });
      }
      try {
        seatCandidates.set(seat, compileCandidate(request.id, request.params ?? {}));
      } catch (error) {
        throw new RunnerError('invalid_input', 'seat candidate', { kind: 'invalid_candidate', field: String(seat) }, { cause: error });
      }
    }
    if (seatCandidates.size > 0 && workerCount > 1) {
      throw new RunnerError('invalid_input', 'worker count', { kind: 'candidates_require_one_worker' });
    }
    const loadedPolicy = await loadPolicy(options, runSignal);
    const policy = loadedPolicy.policy;
    const recordsActionFunnel = scenario.mode === 'hunger_games' && scenario.record.policyReplay
      && competitorDriver === 'baselinePolicy';
    if (workerCount > 1 && !recordsActionFunnel) {
      throw new RunnerError('invalid_input', 'worker count', { kind: 'workers_require_policy_replay_recording' });
    }
    const resume = options.resume;
    if (resume !== undefined && (scenario.mode !== 'hunger_games' || roster.botCompetitors.length + roster.externalCompetitors.length
        !== resume.record.prepare.roster.length)) {
      throw new RunnerError('invalid_input', 'resume', { kind: 'resume_roster_mismatch' });
    }
    if (resume !== undefined && resume.record.prepare.roster.some((entry, index) =>
        entry.username !== roster.competitors[index]?.username || entry.kind !== roster.competitors[index]?.kind)) {
      throw new RunnerError('invalid_input', 'resume', { kind: 'resume_roster_mismatch' });
    }
    const livingSeats = new Set(resume === undefined
      ? roster.competitors.map((entry) => entry.seat)
      : resume.record.seats.filter((entry) => entry.alive).map((entry) => entry.seat));
    const epoch = resume === undefined ? 0 : resume.record.epoch + 1;
    const serverInputs: RuntimeServerInputs = {
      ...options, javaTmpDir, gamePort, signal: runSignal,
      ...(resume === undefined ? {} : {
        resumeCheckpointPath: resolvePath(options.ownedRoot.toString('utf8'), resume.recordPath.toString('utf8')),
      }),
    };
    const pluginIdentity = await readRuntimePluginIdentity(serverInputs);
    const pluginBytes = await readRuntimePluginJar(serverInputs);
    const basePreparePayload = resume === undefined
      ? createPreparePayload(scenario, roster.competitors)
      : Object.freeze({
        ...resume.record.prepare,
        resume: Object.freeze({ checkpoint_digest: resume.manifest.record.digest, epoch }),
      });

    lease = await acquireOwnedRunLease({
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      relativePath: options.preparedRun.runDirectoryPath,
      signal: runSignal,
    });
    leaseLost = lease.closed.then((closed) => {
      if (closed.kind === 'lost') {
        const error = new RunnerError('runtime_failure', 'run lease', {
          kind: 'lease_lost',
          field: closed.error.category,
          ...(closed.error.errno === undefined ? {} : { os_code: closed.error.errno }),
        });
        controller.abort(error);
        throw error;
      }
      return never;
    });
    void leaseLost.catch(() => {});

    const runtimeTrace = new RuntimeTraceBuilder({
      runId: options.preparedRun.runId,
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      preparedRun: options.preparedRun,
      actionFunnel: recordsActionFunnel,
    });
    trace = runtimeTrace;
    if (recordsActionFunnel) {
      const collector = new ActionFunnelCollector(new Map(roster.competitors.map((entry) => [entry.username, entry.seat])));
      collector.onDiagnostic = (seat, record) => {
        void runtimeTrace.recordRunNote({
          schema: 'client-diagnostic-v1',
          seat,
          tick: coordinator?.lastMatchTick ?? null,
          diagnostic: record.kind,
          reason: record.reason,
          consecutive_observations: record.consecutiveObservations,
        }).catch((error: unknown) => coordinator?.reportFailure(error));
      };
      funnel = collector;
    }
    const serverPath = Buffer.concat([options.preparedRun.runDirectoryPath, SERVER_DIRECTORY]);
    await createOwnedDirectory({
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      relativePath: serverPath,
      signal: runSignal,
    });
    if (resume !== undefined) {
      await cloneOwnedTree({
        helperPath: options.helperPath,
        ownedRoot: options.ownedRoot,
        sourceRelativePath: resume.worldPath,
        destinationRelativePath: Buffer.concat([serverPath, Buffer.from('/world', 'ascii')]),
        maxFiles: MAX_OWNED_TREE_FILES,
        maxBytes: MAX_OWNED_TREE_BYTES,
        signal: runSignal,
      });
    } else await clonePristineWorld({
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      preparedRun: options.preparedRun,
      scenario,
      javaExecutable: options.javaExecutable,
      paperJarPath: options.paperJarPath,
      pluginJarPath: options.pluginJarPath,
      pluginJarBytes: pluginBytes,
      serverPath,
      signal: runSignal,
      createBootstrapWorld: async () => await createBootstrapWorld({
        options,
        inputs: serverInputs,
        pluginIdentity,
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
    options.onServerStarted?.(serverProcess.pid);
    const processFailure = unexpectedExit(serverProcess);
    session = await withStartupTimeout(
      listener.accept(runSignal),
      processFailure,
      abortPromise,
      leaseLost,
    );
    coldStartDeadline.clear();
    await runtimeTrace.recordReady(session.ready);
    assertRuntimePluginIdentity(session.ready, pluginIdentity);
    assertRuntimePluginCapabilities(session.ready, scenario, options.resume !== undefined);

    const preparePayload = resume === undefined && session.ready.payload.capabilities.includes('damage_events_v1')
      && 'roster_version' in basePreparePayload && basePreparePayload.roster_version === 2
      ? Object.freeze({ ...basePreparePayload, damage_events: true as const })
      : basePreparePayload;
    const outcome = deferred<OutcomePayload>();
    void outcome.promise.catch(() => {});
    const completedEvents: RuntimeAuthorityEvent[] = [];
    coordinator = new ControlCoordinator({
      session,
      trace: runtimeTrace,
      runId: options.preparedRun.runId,
      prepare: preparePayload,
      completedEvents,
      outcome,
      processFailure,
      abortPromise,
      leaseLost,
      policy: competitorDriver === 'baselinePolicy' && workerCount === 1 ? policy : undefined,
      policySeed: scenario.seed,
      strategyIntervalTicks: scenario.bots.strategyIntervalTicks,
      ...(scenario.mode === 'hunger_games' && scenario.schemaVersion !== 1
        ? { openingStyleCycle: scenario.openingStyleCycle }
        : {}),
      rosterSize: roster.competitors.length,
      ...(options.onMetrics === undefined ? {} : { onMetrics: options.onMetrics }),
      ...(options.onAuthorityEvent === undefined ? {} : { onAuthorityEvent: options.onAuthorityEvent }),
      ...(options.onPhase === undefined ? {} : { onPhase: options.onPhase }),
      competitors: () => clients,
      ...(options.onPolicyActivity === undefined ? {} : { onPolicyActivity: options.onPolicyActivity }),
      recordPolicy: scenario.record.policyReplay,
      ...(funnel === undefined ? {} : { funnel }),
      ...(seatCandidates.size === 0 ? {} : { candidates: seatCandidates }),
    });
    if (workerCount > 1) {
      cohort = new WorkerCohort({
        workerCount,
        seats: roster.botCompetitors.map((entry) => ({
          seat: entry.seat, username: entry.username, offline_uuid: entry.offline_uuid,
        })),
        launcher: options.workerLauncher ?? launchWorkerProcess(),
        trace: runtimeTrace,
        ...(funnel === undefined ? {} : { collector: funnel }),
        currentTick: () => coordinator!.lastMatchTick,
        base: {
          host: CLIENT_HOST,
          port: gamePort,
          minecraft: scenario.server.minecraft,
          view_distance_chunks: scenario.server.viewDistanceChunks,
          seed: scenario.seed.toString(),
          strategy_interval_ticks: scenario.bots.strategyIntervalTicks.toString(),
          opening_style_cycle: scenario.schemaVersion !== 1 && scenario.mode === 'hunger_games'
            ? [...scenario.openingStyleCycle] as [string, string, string] : null,
          record_policy: scenario.record.policyReplay,
          policy_source: loadedPolicy.source,
          roster: roster.competitors.map((entry) => ({ seat: entry.seat, username: entry.username })),
        },
      });
      coordinator.attachCohort(cohort);
      options.onWorkerCohort?.({ reset: () => cohort!.resetTelemetry(), request: () => cohort!.requestTelemetry() });
    }
    coordinator.startPump();

    const prepareEnvelope = await coordinator.send({ type: 'prepare', payload: preparePayload });
    if (prepareEnvelope.type !== 'prepare') {
      throw new RunnerError('runtime_failure', 'prepare command', { kind: 'invalid_prepare_envelope' });
    }
    if (resume !== undefined && recordsActionFunnel) {
      await runtimeTrace.recordRunNote({
        schema: 'resume-v1',
        checkpoint_id: resume.manifest.checkpoint_id,
        digest: resume.manifest.record.digest,
        epoch,
        match_tick: resume.manifest.match_tick,
        eliminated_seats: resume.record.seats.filter((entry) => !entry.alive).map((entry) => entry.seat),
      });
    }
    if (seatCandidates.size > 0) {
      if (!recordsActionFunnel) {
        throw new RunnerError('invalid_input', 'seat candidate', { kind: 'candidates_require_policy_replay_recording' });
      }
      for (const [seat, candidate] of [...seatCandidates.entries()].sort(([a], [b]) => a - b)) {
        await runtimeTrace.recordRunNote({
          schema: 'seat-policy-v1', seat, candidate: candidate.id, version: candidate.version,
          implementation: candidate.implementation, semantic_id: candidate.semanticId,
          params: { ...candidate.params },
        });
      }
    }
    const clientOptions = { host: CLIENT_HOST, port: gamePort, scenario, signal: runSignal,
      publicRoster: roster.botCompetitors.map((entry) => ({ seat: entry.seat, username: entry.username, offlineUuid: entry.offline_uuid })) } as const;
    clients = (cohort !== undefined ? [] : roster.botCompetitors.filter((entry) => livingSeats.has(entry.seat))).map((competitor) => new RuntimeCompetitorClient(
      competitor.seat,
      roster.competitorIdentities[competitor.seat]!,
      funnel === undefined ? clientOptions : {
        ...clientOptions, funnel: funnel.sink(competitor.seat), diagnostic: funnel.diagnosticSink(competitor.seat),
      },
    ));
    spectators = roster.spectators.map((identity) => new RuntimeSpectatorClient(identity));
    await raceWithRunState(
      Promise.all([
        ...clients.map((competitor) => connectCompetitor(competitor)),
        ...(cohort === undefined ? [] : [cohort.start()]),
        ...spectators.map((spectator) => connectSpectator(spectator, clientOptions)),
      ]),
      abortPromise,
      leaseLost,
      processFailure,
      coordinator.failure,
    );
    const startupFailure = collectClientFailures(clients, spectators);
    if (startupFailure !== undefined) throw startupFailure;
    options.onRosterReady?.({
      host: CLIENT_HOST,
      port: gamePort,
      minecraftVersion: session.ready.payload.server.minecraft_version,
      protocolVersion: session.ready.payload.server.protocol_version,
    });
    const runtimeUsernames = new Set([
      ...roster.botCompetitors.map((competitor) => competitor.username),
      ...roster.spectators.map((spectator) => spectator.username),
    ]);
    const awaitedExternals = roster.externalCompetitors.filter((entry) => livingSeats.has(entry.seat));
    const admission: ExternalAdmission | undefined = awaitedExternals.length > 0
      ? {
        kind: 'competitors',
        identities: awaitedExternals.map((competitor) => ({
          username: competitor.username,
          offlineUuid: competitor.offline_uuid,
        })),
        runtimeUsernames,
      }
      : options.waitForExternalPlayer === true ? { kind: 'spectator', runtimeUsernames } : undefined;
    if (admission !== undefined) {
      await raceWithRunState(
        waitForExternalPlayer({
          observers: [...clients, ...spectators].map((client) => client.bot),
          admission,
          signal: runSignal,
          ...(admission.kind === 'competitors' || options.externalJoinTimeoutMs !== undefined
            ? { timeoutMs: externalJoinTimeoutMs }
            : {}),
          ...(options.onExternalAdmitted === undefined ? {} : { onAdmitted: options.onExternalAdmitted }),
          ...(options.onUnexpectedPlayer === undefined ? {} : { onUnexpectedPlayer: options.onUnexpectedPlayer }),
        }),
        abortPromise,
        leaseLost,
        processFailure,
        coordinator.failure,
      );
      const joinFailure = collectClientFailures(clients, spectators);
      if (joinFailure !== undefined) throw joinFailure;
    }

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
      gameAddress: Object.freeze({ host: CLIENT_HOST, port: gamePort }),
      competitors: Object.freeze([...clients]),
      spectators: Object.freeze([...spectators]),
      events: () => Object.freeze([...completedEvents]),
      start,
      waitForOutcome: () => outcome.promise,
      reconnectCompetitor: async (seat: number) => {
        if (coordinator!.outcomeReceived) {
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
    let savedCheckpoint: SaveCapture | undefined;
    const saveCaptured = deferred<SaveCapture>();
    void saveCaptured.promise.catch(() => {});
    let saveTimer: ReturnType<typeof setInterval> | undefined;
    if (options.checkpointing === true && options.evaluate === undefined && resumeCapable(scenario)
        && session.ready.payload.capabilities.includes('checkpoint_v1')) {
      const files = {
        helperPath: options.helperPath, ownedRoot: options.ownedRoot, runDirectoryPath: options.preparedRun.runDirectoryPath,
      };
      let handling = false;
      saveTimer = setInterval(() => {
        if (handling || !startAttempted || coordinator!.outcomeReceived) return;
        handling = true;
        void (async () => {
          let checkpointId: string | undefined;
          try {
            checkpointId = await readSaveRequest(files);
            if (checkpointId === undefined) { handling = false; return; }
            const phase = coordinator!.phase;
            if (phase !== 'grace' && phase !== 'active') {
              throw new RunnerError('invalid_input', 'checkpoint', { kind: 'checkpoint_requires_grace_or_active' });
            }
            coordinator!.stopPolicyLaunching();
            const botState = coordinator!.exportPolicyState();
            await coordinator!.stopPolicyTasks();
            await coordinator!.send({ type: 'checkpoint', payload: { checkpoint_id: checkpointId, epoch } });
            const written = await raceWithRunState(
              withTimeout(coordinator!.checkpointWritten, 30_000, 'checkpoint_written_timeout', 'checkpoint'),
              abortPromise, leaseLost, processFailure, coordinator!.failure,
            );
            saveCaptured.resolve({ checkpointId, written, botState });
          } catch (error) {
            clearInterval(saveTimer);
            if (checkpointId !== undefined) {
              const failure = mapRuntimeFailure(error);
              await publishSaveResult(files, {
                schema: 1, status: 'failed', checkpoint_id: checkpointId, run_id: options.preparedRun.runId,
                reason: failure.source.kind,
              }).catch(() => undefined);
            }
          }
        })();
      }, 500);
    }
    if (options.evaluate === undefined) {
      await start();
      const finished = await raceWithRunState(
        Promise.race([
          outcome.promise.then((value) => ({ kind: 'outcome' as const, value })),
          saveCaptured.promise.then((value) => ({ kind: 'checkpoint' as const, value })),
        ]),
        abortPromise, leaseLost, processFailure, coordinator.failure,
      );
      clearInterval(saveTimer);
      if (finished.kind === 'checkpoint') savedCheckpoint = finished.value;
      finalOutcome = finished.kind === 'outcome' ? finished.value : { kind: 'abort', reason: 'operator', survivors: [], at: null };
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
        if (!startAttempted && !coordinator.outcomeReceived) await start();
        finalOutcome = await raceWithRunState(
          outcome.promise, abortPromise, leaseLost, processFailure, coordinator.failure,
        );
      } else {
        finalOutcome = callbackResult.value;
      }
      await joinEvaluatorAfterOutcome({
        task: evaluatorTask,
        abort: evaluatorAbort,
        timeoutMs: EVALUATOR_JOIN_TIMEOUT_MS,
        failures: [abortPromise, leaseLost, processFailure, coordinator.failure],
      });
    }

    if (savedCheckpoint !== undefined) {
      const files = {
        helperPath: options.helperPath, ownedRoot: options.ownedRoot, runDirectoryPath: options.preparedRun.runDirectoryPath,
      };
      coordinator.markCheckpointed();
      await coordinator.stopPolicyTasks();
      await closeClients(clients, spectators);
      const exit = await serverProcess.shutdown();
      assertSuccessfulExit(exit);
      await session.close();
      await listener.close();
      await coordinator.join();
      const checkpointTrace = await runtimeTrace.finalizeCheckpointed();
      let manifest;
      try {
        manifest = await persistCheckpoint({
          helperPath: options.helperPath,
          ownedRoot: options.ownedRoot,
          runDirectoryPath: options.preparedRun.runDirectoryPath,
          runId: options.preparedRun.runId,
          checkpointId: savedCheckpoint.checkpointId,
          epoch,
          written: savedCheckpoint.written,
          botState: { schema: 1, seats: [...savedCheckpoint.botState.entries()].sort(([a], [b]) => a - b)
            .map(([seat, state]) => ({ seat, ...state })) },
          scenario: {
            path: options.preparedRun.scenarioPath.toString('utf8'),
            semantic_id: scenario.semanticId,
            external_seat: options.checkpointScenario?.externalSeat ?? null,
          },
          signal: runSignal,
        });
      } catch (error) {
        await publishSaveResult(files, {
          schema: 1, status: 'failed', checkpoint_id: savedCheckpoint.checkpointId,
          run_id: options.preparedRun.runId, reason: mapRuntimeFailure(error).source.kind,
        }).catch(() => undefined);
        throw error;
      }
      await publishSaveResult(files, {
        schema: 1, status: 'saved', checkpoint_id: manifest.checkpoint_id, run_id: manifest.run_id,
        epoch: manifest.epoch, match_tick: manifest.match_tick, digest: manifest.record.digest,
        directory: `.work/arena/checkpoints/${manifest.checkpoint_id}`,
      });
      const aliveState = completedEvents.findLast((event) => event.type === 'public_state');
      await lease.release();
      releaseLease = true;
      return Object.freeze({
        runId: options.preparedRun.runId,
        ready: session.ready,
        events: Object.freeze([...completedEvents]),
        outcome: Object.freeze({
          kind: 'abort' as const, reason: 'operator' as const,
          survivors: aliveState?.type === 'public_state' ? aliveState.payload.alive_seats : [], at: null,
        }),
        trace: checkpointTrace,
        competitors: roster.competitorIdentities,
        spectators: roster.spectators,
        stats: [],
        checkpoint: manifest,
      });
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
    const traceResult = await runtimeTrace.finalize();
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
      ...(cohort !== undefined && cohort.losses.length > 0 ? { degraded: cohort.losses } : {}),
      ...(seatCandidates.size === 0 ? {} : {
        seatPolicies: Object.freeze([...seatCandidates.entries()].sort(([a], [b]) => a - b)
          .map(([seat, candidate]) => Object.freeze({ seat, candidate: candidate.id, semanticId: candidate.semanticId }))),
      }),
    });
  } catch (error) {
    const failure = runSignal.reason instanceof RunnerError ? runSignal.reason : error;
    const primaryFailure = mapRuntimeFailure(failure);
    if (!runSignal.aborted) controller.abort(primaryFailure);
    evaluatorAbort?.abort(primaryFailure);
    const cleanupFailure = await cleanupOwnedRun({
      listener,
      session,
      process: serverProcess,
      trace,
      primaryFailure,
      clients,
      spectators,
      coordinator,
      funnel,
      cohort,
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      runDirectoryPath: options.preparedRun.runDirectoryPath,
      hasOutcome: matchOutcomeReceived || coordinator?.outcomeReceived === true,
      started: startAttempted,
      commandPending,
      evaluatorTask,
      lease,
      releaseLease,
      abortReason: cleanupAbortReason(primaryFailure),
    });
    if (cleanupFailure !== undefined) {
      throw withCleanupFailure(primaryFailure, cleanupFailure);
    }
    throw primaryFailure;
  } finally {
    coldStartDeadline.clear();
    wallClockDeadline.clear();
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
  readonly #measurePolicyActivity: boolean;
  readonly #rosterSize: number;
  readonly #onPhase: ((phase: ClockPayload['phase']) => void) | undefined;
  #phase: ClockPayload['phase'] | undefined;
  #cohort: WorkerCohort | undefined;
  #cohortStopped = false;
  readonly #onMetrics: ((payload: import('../control/types.js').MetricsPayload) => void) | undefined;
  readonly #onAuthorityEvent: ((event: RuntimeAuthorityEvent, arrivalNs: bigint) => void) | undefined;
  #checkpointed = false;
  readonly #checkpointWritten = deferred<CheckpointWrittenPayload>();
  #lastMatchTick: number | null = null;
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
    openingStyleCycle?: OpeningStyleCycle;
    strategyIntervalTicks: bigint;
    competitors(): readonly RuntimeCompetitorClient[];
    funnel?: ActionFunnelCollector;
    candidates?: ReadonlyMap<number, CompiledCandidate>;
    restore?: ReadonlyMap<number, SeatPolicyState>;
    rosterSize: number;
    onMetrics?: (payload: import('../control/types.js').MetricsPayload) => void;
    onAuthorityEvent?: (event: RuntimeAuthorityEvent, arrivalNs: bigint) => void;
    onPhase?: (phase: ClockPayload['phase']) => void;
    recordPolicy: boolean;
    onPolicyActivity?: (event: PolicyActivityEvent) => void;
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
    this.#rosterSize = options.rosterSize;
    this.#onMetrics = options.onMetrics;
    this.#onAuthorityEvent = options.onAuthorityEvent;
    this.#onPhase = options.onPhase;
    this.#measurePolicyActivity = options.onPolicyActivity !== undefined;
    this.#runnerSequence = options.session.ready.correlation!;
    void this.#failureState.promise.catch(() => {});
    if (options.policy !== undefined) {
      this.#policyLoop = new LivePolicyLoop({
        trace: options.trace,
        params: options.policy.params,
        seed: options.policySeed,
        ...(options.openingStyleCycle === undefined ? {} : { openingStyleCycle: options.openingStyleCycle }),
        strategyIntervalTicks: options.strategyIntervalTicks,
        recordPolicy: options.recordPolicy,
        ...(options.funnel === undefined ? {} : { funnel: options.funnel }),
        ...(options.candidates === undefined ? {} : { candidates: options.candidates }),
        ...(options.restore === undefined ? {} : { restore: options.restore }),
        competitors: options.competitors,
        fail: (error) => this.#fail(error),
        ...(options.onPolicyActivity === undefined ? {} : { onActivity: options.onPolicyActivity }),
      });
    }
  }

  get failure(): Promise<never> {
    return this.#failureState.promise;
  }

  get phase(): ClockPayload['phase'] | undefined {
    return this.#phase;
  }

  get checkpointWritten(): Promise<CheckpointWrittenPayload> {
    return this.#checkpointWritten.promise;
  }

  markCheckpointed(): void {
    this.#checkpointed = true;
  }

  exportPolicyState(): ReadonlyMap<number, SeatPolicyState> {
    return this.#policyLoop?.exportState() ?? new Map();
  }

  get lastMatchTick(): number | null {
    return this.#lastMatchTick;
  }

  reportFailure(error: unknown): void {
    this.#fail(error);
  }

  attachCohort(cohort: WorkerCohort): void {
    this.#cohort = cohort;
    void cohort.failure.catch((error: unknown) => this.#fail(error));
  }

  get outcomeReceived(): boolean {
    return this.#outcomeReceived;
  }

  startPump(): void {
    if (this.#pump !== undefined) throw new RunnerError('runtime_failure', 'control session', { kind: 'pump_already_started' });
    this.#pump = this.#consume();
    void this.#pump.catch((error: unknown) => this.#fail(error));
  }

  async send(command: RunnerCommand): Promise<RunnerCommandEnvelope> {
    return await this.#send(command, false);
  }

  async sendForCleanup(reason: AbortReason): Promise<void> {
    await this.#send({ type: 'abort', payload: { reason } }, true);
  }

  async #send(command: RunnerCommand, cleanup: boolean): Promise<RunnerCommandEnvelope> {
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
      const response = cleanup
        ? await withTimeout(acknowledgment.promise, 1_000, 'abort_acknowledgment_timeout', 'control cleanup')
        : await raceWithRunState(
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
    this.#cohortStopped = true;
    await this.#policyLoop?.stopAndJoin();
    await this.#cohort?.stopAndDrain();
  }

  stopPolicyLaunching(): void {
    this.#cohortStopped = true;
    this.#policyLoop?.stopLaunching();
  }

  async join(): Promise<void> {
    await this.#pump;
  }

  async #consume(): Promise<void> {
    try {
      for await (const message of this.#session.messages()) {
        if (message.type === 'metrics') this.#onMetrics?.(message.payload);
        if (this.#onAuthorityEvent !== undefined && isAuthorityEvent(message)) {
          this.#onAuthorityEvent(message, process.hrtime.bigint());
        }
        const tickReceivedAtNs = this.#measurePolicyActivity && message.type === 'public_clock' ? process.hrtime.bigint() : undefined;
        if (message.type === 'outcome') {
          this.#outcomeReceived = true;
          this.#cohortStopped = true;
          this.#policyLoop?.stopLaunching();
        }
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
          if (message.type === 'checkpoint_written') {
            this.#checkpointWritten.resolve(message.payload);
            return;
          }
          if (!isAuthorityEvent(message)) return;
          assertEventSeatsInRoster(message, this.#rosterSize);
          if (message.type === 'public_clock' && message.payload.phase !== this.#phase) {
            this.#phase = message.payload.phase;
            this.#onPhase?.(message.payload.phase);
          }
          if (this.#events.length >= MAX_RETAINED_AUTHORITY_EVENTS) {
            throw new RunnerError('runtime_failure', 'control events', { kind: 'critical_event_limit_exceeded' });
          }
          this.#events.push(message);
          if (message.type === 'outcome') {
            try {
              reconstructEventResult(this.#runId, this.#prepare, this.#events.filter((event) => event.type !== 'damage'));
            } catch (error) {
              throw new RunnerError('corrupt_evidence', 'authoritative match events', {
                kind: traceFailureKind(error),
              });
            }
            this.#outcome.resolve(message.payload);
          }
        });

        if (message.type === 'public_clock' && message.payload.tick?.domain === 'match') {
          const value = Number(message.payload.tick.value);
          if (!Number.isSafeInteger(value)) throw new RunnerError('runtime_failure', 'policy clock', { kind: 'tick_out_of_range' });
          this.#lastMatchTick = value;
          if (message.payload.phase === 'grace' || message.payload.phase === 'active') {
            this.#policyLoop?.onTick(value, tickReceivedAtNs);
            if (!this.#cohortStopped) this.#cohort?.onTick(value);
          }
        }
      }
      if (!this.#outcomeReceived && !this.#checkpointed) {
        throw new RunnerError('runtime_failure', 'control session', { kind: 'outcome_missing' });
      }
    } catch (error) {
      if (this.#checkpointed && error instanceof ControlSessionError
          && (error.code === 'control_disconnected' || error.code === 'control_closed')) {
        return;
      }
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
    return { policy: compilePolicy(text), source: text };
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
  pluginIdentity: RuntimePluginIdentity;
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
  const inputs: RuntimeServerInputs = {
    ...options.inputs,
    gamePort: options.options.ephemeralGamePort === true ? await reserveEphemeralGamePort() : DEFAULT_GAME_PORT,
  };
  await stageServerDirectory({
    inputs,
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
  let startupFailure: unknown;
  try {
    server = await startPaper(
      options.options,
      inputs,
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
    assertRuntimePluginIdentity(session.ready, options.pluginIdentity);
    assertRuntimePluginCapabilities(session.ready, options.options.preparedRun.scenario);
    assertSuccessfulExit(await server.shutdown());
  } catch (error) {
    startupFailure = error;
  }
  let cleanupFailure: unknown;
  try { await server?.shutdown(); } catch (error) { cleanupFailure ??= error; }
  try { await session?.close(); } catch (error) { cleanupFailure ??= error; }
  try { await listener.close(); } catch (error) { cleanupFailure ??= error; }
  if (startupFailure !== undefined && cleanupFailure !== undefined) {
    throw withCleanupFailure(startupFailure, cleanupFailure);
  }
  if (startupFailure !== undefined) throw startupFailure;
  if (cleanupFailure !== undefined) throw mapRuntimeFailure(cleanupFailure);
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
      gamePort: inputs.gamePort ?? DEFAULT_GAME_PORT,
      ...(options.serverLogsToStderr === true ? { output: { stdout: process.stderr, stderr: process.stderr } } : {}),
      signal,
    });
  } catch (error) {
    throw mapRuntimeFailure(error);
  }
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
  trace: RuntimeTraceBuilder | undefined;
  primaryFailure: RunnerError;
  clients: readonly RuntimeCompetitorClient[];
  spectators: readonly RuntimeSpectatorClient[];
  coordinator: ControlCoordinator | undefined;
  funnel: ActionFunnelCollector | undefined;
  cohort: WorkerCohort | undefined;
  helperPath: string;
  ownedRoot: Buffer;
  runDirectoryPath: Buffer;
  hasOutcome: boolean;
  started: boolean;
  commandPending: boolean;
  evaluatorTask: Promise<void> | undefined;
  lease: OwnedRunLease | undefined;
  releaseLease: boolean;
  abortReason: AbortReason;
}>): Promise<unknown | undefined> {
  let failure: unknown;
  options.coordinator?.stopPolicyLaunching();
  if (options.coordinator !== undefined && options.started && !options.commandPending && !options.hasOutcome) {
    try {
      await options.coordinator.sendForCleanup(options.abortReason);
    } catch (error) {
      if (!(error instanceof ControlSessionError && error.code === 'control_closed')) {
        failure ??= cleanupErrorUnlessPrimary(error, options.primaryFailure);
      }
    }
  }
  if (options.coordinator !== undefined) {
    try {
      await withTimeout(
        options.coordinator.stopPolicyTasks(),
        EVALUATOR_JOIN_TIMEOUT_MS,
        'policy_tasks_did_not_stop',
        'runtime policy tasks',
      );
    } catch (error) {
      failure ??= cleanupErrorUnlessPrimary(error, options.primaryFailure);
    }
  }
  if (options.cohort !== undefined) {
    try { await options.cohort.terminate(); }
    catch (error) { failure ??= cleanupErrorUnlessPrimary(error, options.primaryFailure); }
  }
  const clientsClosed = await Promise.allSettled([
    ...options.clients.map((client) => client.close()),
    ...options.spectators.map((client) => client.close()),
  ]);
  const clientFailure = clientsClosed.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (clientFailure !== undefined) {
    failure ??= cleanupErrorUnlessPrimary(clientFailure.reason, options.primaryFailure);
  }
  let processReaped = options.process === undefined;
  if (options.process !== undefined) {
    try {
      await options.process.shutdown();
      processReaped = true;
    } catch (error) {
      failure ??= cleanupErrorUnlessPrimary(error, options.primaryFailure);
      processReaped = await processExitObserved(options.process);
    }
  }
  try { await options.session?.close(); }
  catch (error) { failure ??= cleanupErrorUnlessPrimary(error, options.primaryFailure); }
  try { await options.listener?.close(); }
  catch (error) { failure ??= cleanupErrorUnlessPrimary(error, options.primaryFailure); }
  if (options.coordinator !== undefined) {
    try { await options.coordinator.join(); } catch { /* The initiating failure already explains the pump error. */ }
  }
  if (options.evaluatorTask !== undefined) {
    try { await withTimeout(options.evaluatorTask, EVALUATOR_JOIN_TIMEOUT_MS, 'evaluator_did_not_stop'); }
    catch (error) { failure ??= cleanupErrorUnlessPrimary(error, options.primaryFailure); }
  }
  if (options.funnel !== undefined) {
    try {
      await flushDiagnosticRings({
        collector: options.funnel,
        helperPath: options.helperPath,
        ownedRoot: options.ownedRoot,
        runDirectoryPath: options.runDirectoryPath,
      });
    } catch (error) {
      failure ??= cleanupErrorUnlessPrimary(error, options.primaryFailure);
    }
  }
  if (processReaped && options.trace !== undefined) {
    try {
      await options.trace.persistFailurePartial(
        failurePrimary(options.primaryFailure),
        failureCleanup(failure, options.primaryFailure),
      );
    } catch (error) {
      failure ??= cleanupErrorUnlessPrimary(error, options.primaryFailure);
    }
  }
  if (processReaped && options.lease !== undefined && !options.releaseLease) {
    try { await options.lease.release(); }
    catch (error) { failure ??= cleanupErrorUnlessPrimary(error, options.primaryFailure); }
  }
  return failure;
}

function isAuthorityEvent(message: ControlMessage): message is RuntimeAuthorityEvent {
  return message.type === 'public_clock' || message.type === 'public_state' || message.type === 'civilization_state'
    || message.type === 'elimination' || message.type === 'outcome' || message.type === 'damage';
}

async function processExitObserved(process: OwnedServerProcess): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      process.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 0);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function failurePrimary(error: RunnerError): OperationalFailurePrimaryV1 {
  return Object.freeze({ category: error.category, resource: error.resource, source: error.source });
}

function unexpectedExit(process: OwnedServerProcess): Promise<never> {
  const outputFailure = process.fatalOutputError.then((error) => { throw error; });
  const exitFailure = process.exited.then((exit) => {
    throw new RunnerError('runtime_failure', 'Paper server', {
      kind: 'server_exited_before_shutdown',
      ...(exit.code === null ? {} : { field: String(exit.code) }),
    });
  });
  return Promise.race([outputFailure, exitFailure]);
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
  if (signal.aborted) return Promise.reject(abortFailure(signal));
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(abortFailure(signal)), { once: true });
  });
}

function abortFailure(signal: AbortSignal): RunnerError {
  return signal.reason instanceof RunnerError ? signal.reason : cancelledFailure();
}

function assertRunning(signal: AbortSignal): void {
  if (signal.aborted) throw cancelledFailure();
}

function cleanupAbortReason(error: unknown): AbortReason {
  if (!(error instanceof RunnerError)) return 'protocol_error';
  switch (error.source.kind) {
    case 'runtime_timeout': return 'runtime_timeout';
    case 'lease_lost': return 'lease_lost';
    case 'invalid_world': return 'invalid_world';
    case 'cancelled': return 'operator';
    default: return 'protocol_error';
  }
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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  kind: string,
  resource = 'active evaluator',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RunnerError('runtime_failure', resource, { kind })), timeoutMs);
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

interface SaveCapture {
  readonly checkpointId: string;
  readonly written: CheckpointWrittenPayload;
  readonly botState: ReadonlyMap<number, SeatPolicyState>;
}

function resumeCapable(scenario: PreparedRun['scenario']): boolean {
  return scenario.mode === 'hunger_games' && (scenario.schemaVersion === 3
    || scenario.roster.seats.some(({ controller }) => controller.kind === 'external'));
}

function restoredPolicyState(botState: unknown): ReadonlyMap<number, SeatPolicyState> {
  const states = new Map<number, SeatPolicyState>();
  const value = botState as { schema?: unknown; seats?: unknown };
  if (value.schema !== 1 || !Array.isArray(value.seats)) {
    throw new RunnerError('corrupt_evidence', 'checkpoint', { kind: 'invalid_bot_state' });
  }
  for (const entry of value.seats as Array<{ seat?: unknown; memory?: unknown; rng_state?: unknown; opening_state?: unknown }>) {
    if (typeof entry.seat !== 'number' || typeof entry.rng_state !== 'string' || !/^[0-9]{1,20}$/.test(entry.rng_state)) {
      throw new RunnerError('corrupt_evidence', 'checkpoint', { kind: 'invalid_bot_state' });
    }
    states.set(entry.seat, Object.freeze({
      memory: entry.memory,
      rng_state: entry.rng_state,
      opening_state: (entry.opening_state ?? null) as SeatPolicyState['opening_state'],
    }));
  }
  return states;
}
