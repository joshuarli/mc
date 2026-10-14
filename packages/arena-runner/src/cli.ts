import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { compilePolicy, compileScenario, MAX_SOURCE_BYTES, scenarioMapReference, SpecError } from '@arena/spec';
import { OwnedFilesError, readOwnedFile } from './owned-files/index.js';
import { consumeRawArgv, RawArgvError, rawArgumentText } from './owned-files/raw-argv.js';
import { comparisonJson, inspectJson, reconstruct, reportJson, type Evidence } from './evidence.js';
import { canonicalJson } from './canonical.js';
import { RunnerError } from './errors.js';
import { withExternalSeat, type ExternalSeatRequest } from './effective-scenario.js';
import { prepareRun, resolveScenarioResource } from './prepare.js';
import { replayPolicyJson } from './policy-replay.js';
import { isValidRunId } from './run-id.js';
import { inspectStoppedRun } from './runtime/inspect.js';
import { collectOwnedRuns, type RunGarbageCollectionMode } from './runtime/gc.js';
import { runPreparedRun } from './runtime/run.js';
import { createRuntimeRoster, type RuntimeSpectatorMode } from './runtime/roster.js';
import { armRuntimeDeadline, COLD_START_TIMEOUT_MS } from './runtime/deadline.js';
import { readSegment, TraceError, type TraceSegment } from './trace.js';

export type CliResult =
  | { readonly kind: 'success'; readonly exitCode: 0; readonly stdout: string }
  | { readonly kind: 'failure'; readonly exitCode: 2 | 3 | 4 | 5 | 6 | 130; readonly stderr: string };

const SOURCE_UTF8 = new TextDecoder('utf-8', { fatal: true });

export async function runCli(args: readonly string[]): Promise<CliResult> {
  return await runCliBytes(args.map((argument) => Buffer.from(argument, 'utf8')));
}

async function runCliBytes(args: readonly Buffer[]): Promise<CliResult> {
  try {
    return await dispatchCliBytes(args);
  } catch (error) {
    return failure(error);
  }
}

async function dispatchCliBytes(args: readonly Buffer[]): Promise<CliResult> {
  const command = args.length === 0 ? undefined : argumentText(args[0]!, 0);
  const rest = args.slice(1);
  if (command === undefined) throw invalidInput('missing_command');
  if (command === 'help' || command === '--help') {
    if (rest.length !== 0) throw invalidInput('unexpected_argument');
    return success(helpJson());
  }
  if (command === 'doctor') {
    if (rest.length !== 0) throw invalidInput('unexpected_argument');
    return success(doctorJson());
  }
  if (command === 'gc') return await garbageCollectCommand(rest);
  if (command === 'inspect' && rest.length > 0 && argumentText(rest[0]!, 1) === '--run-id') {
    return await inspectRunCommand(rest);
  }
  if (command === 'inspect' || command === 'report') {
    const evidence = await loadEvidence(rest);
    return success(command === 'inspect' ? inspectJson(evidence) : reportJson(evidence));
  }
  if (command === 'replay-policy') {
    const evidence = await loadEvidence(rest);
    return success(replayPolicyJson(evidence));
  }
  if (command === 'compare') {
    if (rest.length !== 2) throw invalidInput('compare_requires_two_trace_sets');
    const left = await loadSingleSegment(rest[0]!, 1);
    const right = await loadSingleSegment(rest[1]!, 2);
    return success(comparisonJson(left, right));
  }
  if (command === 'prepare') return await prepareCommand(rest);
  if (command === 'validate') return await validateCommand(rest);
  if (command === 'run' || command === 'play' || command === 'watch') return await matchCommand(command, rest);
  throw invalidInput('unknown_command');
}

function failure(error: unknown): CliResult {
  if (error instanceof RunnerError) {
    return { kind: 'failure', exitCode: error.exitCode(), stderr: error.toJson() };
  }
  if (error instanceof RawArgvError) {
    const argument = error.argumentIndex === undefined ? undefined : error.argumentIndex + 1;
    const runnerError = new RunnerError('invalid_input', 'command line arguments', {
      kind: 'invalid_argument_encoding',
      ...(argument === undefined ? {} : { argument }),
    });
    return { kind: 'failure', exitCode: runnerError.exitCode(), stderr: runnerError.toJson() };
  }
  if (error instanceof OwnedFilesError) {
    const runnerError = new RunnerError('runtime_failure', 'raw command line arguments', {
      kind: error.category,
      ...(error.errno === undefined ? {} : { os_code: error.errno }),
      ...(error.cleanupErrno === undefined ? {} : { cleanup_os_code: error.cleanupErrno }),
    });
    return { kind: 'failure', exitCode: runnerError.exitCode(), stderr: runnerError.toJson() };
  }
  if (error instanceof TraceError) {
    const runnerError = new RunnerError('corrupt_evidence', 'trace segment set', error.source);
    return { kind: 'failure', exitCode: runnerError.exitCode(), stderr: runnerError.toJson() };
  }
  const runtimeError = new RunnerError('runtime_failure', 'arena runner', { kind: 'runtime' });
  return { kind: 'failure', exitCode: runtimeError.exitCode(), stderr: runtimeError.toJson() };
}

function success(value: object): CliResult {
  return { kind: 'success', exitCode: 0, stdout: canonicalJson(value) };
}

async function loadEvidence(paths: readonly Buffer[]): Promise<Evidence> {
  if (paths.length === 0) throw invalidInput('trace_path_required');
  const segments: TraceSegment[] = [];
  for (const [index, path] of paths.entries()) {
    segments.push(await readSegment(path, index + 1));
  }
  try {
    return reconstruct(segments);
  } catch (error) {
    if (!(error instanceof TraceError)) throw error;
    throw new RunnerError('corrupt_evidence', 'trace segment set', error.source);
  }
}

async function loadSingleSegment(path: Buffer, setNumber: number): Promise<Evidence> {
  const segment = await readSegment(path, setNumber);
  try {
    return reconstruct([segment]);
  } catch (error) {
    if (!(error instanceof TraceError)) throw error;
    throw new RunnerError('corrupt_evidence', `trace set ${setNumber}`, error.source);
  }
}

function invalidInput(kind: string): RunnerError {
  return new RunnerError('invalid_input', 'command line arguments', { kind });
}

function argumentText(argument: Buffer, index: number): string {
  return rawArgumentText(argument, index);
}

async function prepareCommand(args: readonly Buffer[]): Promise<CliResult> {
  if (args.length !== 4 || argumentText(args[0]!, 1) !== '--scenario' || argumentText(args[2]!, 3) !== '--run-id') {
    throw invalidInput('prepare_requires_scenario_and_run_id');
  }

  const scenarioPath = normalizeScenarioPath(args[1]!);
  const runId = argumentText(args[3]!, 4);
  if (!isValidRunId(runId)) {
    throw new RunnerError('invalid_input', 'run id', { kind: 'invalid_run_id' });
  }
  const helperPath = configuredAbsolutePath('ARENA_FS_HELPER', 'filesystem helper');

  const ownedRoot = Buffer.from(process.cwd(), 'utf8');
  const prepared = await prepareRun(helperPath, ownedRoot, scenarioPath, runId);
  return success({
    schema: 1,
    run_id: prepared.runId,
    run_directory: prepared.runDirectoryPath.toString('utf8'),
    world_plan: prepared.worldPlanPath.toString('utf8'),
    map_semantic_id: prepared.scenario.map.semanticId,
  });
}

async function inspectRunCommand(args: readonly Buffer[]): Promise<CliResult> {
  if (args.length !== 2 || argumentText(args[0]!, 2) !== '--run-id') {
    throw invalidInput('inspect_requires_run_id');
  }
  const runId = argumentText(args[1]!, 3);
  if (!isValidRunId(runId)) {
    throw new RunnerError('invalid_input', 'run id', { kind: 'invalid_run_id' });
  }
  const helperPath = configuredAbsolutePath('ARENA_FS_HELPER', 'filesystem helper');
  const inspection = await inspectStoppedRun({
    helperPath,
    ownedRoot: Buffer.from(process.cwd(), 'utf8'),
    runId,
  });
  return success(inspection);
}

async function garbageCollectCommand(args: readonly Buffer[]): Promise<CliResult> {
  let mode: RunGarbageCollectionMode | undefined;
  const runIds: string[] = [];
  for (let index = 0; index < args.length;) {
    const option = argumentText(args[index]!, index + 1);
    if (option === '--dry-run' || option === '--apply') {
      if (mode !== undefined) throw invalidInput('gc_requires_one_mode');
      mode = option === '--dry-run' ? 'dry_run' : 'apply';
      index += 1;
      continue;
    }
    if (option === '--run-id') {
      if (index + 1 >= args.length) throw invalidInput('gc_requires_run_id');
      runIds.push(argumentText(args[index + 1]!, index + 2));
      index += 2;
      continue;
    }
    throw invalidInput('unexpected_argument');
  }
  if (mode === undefined) throw invalidInput('gc_requires_one_mode');
  if (runIds.length === 0) throw invalidInput('gc_requires_run_id');

  const helperPath = configuredAbsolutePath('ARENA_FS_HELPER', 'filesystem helper');
  const result = await collectOwnedRuns({
    helperPath,
    ownedRoot: Buffer.from(process.cwd(), 'utf8'),
    runIds,
    mode,
  });
  return success(result);
}

async function validateCommand(args: readonly Buffer[]): Promise<CliResult> {
  if (args.length !== 2 || argumentText(args[0]!, 1) !== '--scenario') {
    throw invalidInput('validate_requires_scenario');
  }
  const scenarioPath = normalizeScenarioPath(args[1]!);
  const helperPath = configuredAbsolutePath('ARENA_FS_HELPER', 'filesystem helper');
  const inputs = await compileScenarioAndPolicy(helperPath, Buffer.from(process.cwd(), 'utf8'), scenarioPath);
  return success({
    schema: 1,
    scenario: {
      name: inputs.scenario.name,
      mode: inputs.scenario.mode,
      seed: inputs.scenario.seed.toString(10),
      semantic_id: inputs.scenario.semanticId,
    },
    map: {
      semantic_id: inputs.scenario.map.semanticId,
      dimensions: inputs.scenario.map.dimensions,
      block_count: inputs.scenario.map.blocks.length,
      spawn_count: inputs.scenario.map.spawns.length,
      loot_container_count: inputs.scenario.map.lootContainers.length,
    },
    policy: {
      version: inputs.policy.version,
      semantic_id: inputs.policy.semanticId,
    },
    roster: {
      competitors: inputs.scenario.roster.competitors,
      spectator_capacity: inputs.scenario.roster.spectatorCapacity.toString(10),
    },
  });
}

type MatchCommand = 'run' | 'play' | 'watch';

interface MatchArguments {
  readonly scenarioArgument: Buffer;
  readonly runId: string | undefined;
  readonly spectatorMode: RuntimeSpectatorMode;
  readonly waitForExternalPlayer: boolean;
  readonly externalSeat: ExternalSeatRequest | undefined;
  readonly joinTimeoutMs: number | undefined;
}

const MAX_JOIN_TIMEOUT_SECONDS = 3600;

function parseMatchArguments(command: MatchCommand, args: readonly Buffer[]): MatchArguments {
  let scenarioArgument: Buffer | undefined;
  let runId: string | undefined;
  let acceptMinecraftEula = false;
  let reserveSpectatorSlot = false;
  let waitForExternalPlayer = false;
  let username: string | undefined;
  let seat: number | undefined;
  let joinTimeoutMs: number | undefined;
  const takesLegacyFlags = command === 'run';
  for (let index = 0; index < args.length;) {
    const option = argumentText(args[index]!, index + 1);
    const hasValue = index + 1 < args.length;
    if (option === '--scenario') {
      if (scenarioArgument !== undefined || !hasValue) throw invalidInput(`${command}_requires_scenario`);
      scenarioArgument = args[index + 1]!;
      index += 2;
      continue;
    }
    if (option === '--run-id') {
      if (runId !== undefined || !hasValue) throw invalidInput(`${command}_invalid_run_id_option`);
      runId = argumentText(args[index + 1]!, index + 2);
      index += 2;
      continue;
    }
    if (option === '--accept-minecraft-eula') {
      if (acceptMinecraftEula) throw invalidInput(`${command}_accept_minecraft_eula_repeated`);
      acceptMinecraftEula = true;
      index += 1;
      continue;
    }
    if (option === '--join-timeout-seconds') {
      if (joinTimeoutMs !== undefined || !hasValue) throw invalidInput(`${command}_invalid_join_timeout`);
      const text = argumentText(args[index + 1]!, index + 2);
      const seconds = /^[1-9][0-9]{0,3}$/.test(text) ? Number(text) : 0;
      if (seconds < 1 || seconds > MAX_JOIN_TIMEOUT_SECONDS) throw invalidInput(`${command}_invalid_join_timeout`);
      joinTimeoutMs = seconds * 1000;
      index += 2;
      continue;
    }
    if (command === 'play' && option === '--username') {
      if (username !== undefined || !hasValue) throw invalidInput('play_requires_username');
      username = argumentText(args[index + 1]!, index + 2);
      index += 2;
      continue;
    }
    if (command === 'play' && option === '--seat') {
      const text = hasValue ? argumentText(args[index + 1]!, index + 2) : '';
      if (seat !== undefined || !/^(0|[1-9][0-9]{0,2})$/.test(text)) throw invalidInput('play_invalid_seat');
      seat = Number(text);
      index += 2;
      continue;
    }
    if (takesLegacyFlags && option === '--reserve-external-spectator-slot') {
      if (reserveSpectatorSlot) throw invalidInput('run_reserve_external_spectator_slot_repeated');
      reserveSpectatorSlot = true;
      index += 1;
      continue;
    }
    if (takesLegacyFlags && option === '--wait-for-external-player') {
      if (waitForExternalPlayer) throw invalidInput('run_wait_for_external_player_repeated');
      waitForExternalPlayer = true;
      index += 1;
      continue;
    }
    throw invalidInput('unexpected_argument');
  }
  if (scenarioArgument === undefined) throw invalidInput(`${command}_requires_scenario`);
  if (command === 'play' && username === undefined) throw invalidInput('play_requires_username');
  if (!acceptMinecraftEula) {
    throw new RunnerError('missing_prerequisite', 'Minecraft EULA', { kind: 'missing_eula' });
  }
  return Object.freeze({
    scenarioArgument,
    runId,
    spectatorMode: command === 'watch' || reserveSpectatorSlot ? 'reserveExternalSlot' : 'automated',
    waitForExternalPlayer: command === 'watch' || waitForExternalPlayer,
    externalSeat: command === 'play' ? { seat: seat ?? 0, username: username! } : undefined,
    joinTimeoutMs,
  });
}

function writeProgress(lines: readonly string[]): void {
  process.stderr.write(`${lines.join('\n')}\n`);
}

async function matchCommand(command: MatchCommand, args: readonly Buffer[]): Promise<CliResult> {
  const parsed = parseMatchArguments(command, args);
  const scenarioPath = normalizeScenarioPath(parsed.scenarioArgument);
  const runId = parsed.runId ?? randomUUID();
  if (!isValidRunId(runId)) {
    throw new RunnerError('invalid_input', 'run id', { kind: 'invalid_run_id' });
  }

  const helperPath = configuredAbsolutePath('ARENA_FS_HELPER', 'filesystem helper');
  const javaHome = configuredAbsolutePath('ARENA_JAVA_HOME', 'Java runtime');
  const paperJarPath = configuredAbsolutePath('ARENA_PAPER_JAR', 'Paper server JAR');
  const pluginJarPath = configuredAbsolutePath('ARENA_PLUGIN_JAR', 'Arena plugin JAR');
  const ownedRoot = Buffer.from(process.cwd(), 'utf8');
  return await withProcessAbortSignal(async (signal, controller) => {
    const coldStartDeadline = armRuntimeDeadline(controller, 'cold_start', COLD_START_TIMEOUT_MS);
    try {
      const inputs = await compileScenarioAndPolicy(helperPath, ownedRoot, scenarioPath, signal);
      const effectiveScenario = parsed.externalSeat === undefined
        ? inputs.scenario
        : withExternalSeat(inputs.scenario, parsed.externalSeat);
      const roster = createRuntimeRoster(effectiveScenario, { spectatorMode: parsed.spectatorMode });
      const externalCompetitors = roster.externalCompetitors.map((competitor) => ({
        seat: competitor.seat,
        username: competitor.username,
        offline_uuid: competitor.offline_uuid,
      }));
      const role = externalCompetitors.length > 0
        ? { kind: 'competitor' as const, seats: externalCompetitors }
        : parsed.spectatorMode === 'reserveExternalSlot'
          ? { kind: 'spectator' as const }
          : { kind: 'none' as const };
      const preparedRun = await prepareRun(helperPath, ownedRoot, scenarioPath, runId, signal, {
        ...(parsed.externalSeat === undefined ? {} : { externalSeat: parsed.externalSeat }),
      });
      try {
        const Effect = await import('effect/Effect');
        const runtime = Effect.tryPromise({
          try: () => runPreparedRun({
            preparedRun,
            helperPath,
            ownedRoot,
            javaExecutable: resolve(javaHome, 'bin', 'java'),
            paperJarPath,
            pluginJarPath,
            acceptMinecraftEula: true,
            spectatorMode: parsed.spectatorMode,
            ...(parsed.waitForExternalPlayer ? { waitForExternalPlayer: true as const } : {}),
            ...(parsed.joinTimeoutMs === undefined ? {} : { externalJoinTimeoutMs: parsed.joinTimeoutMs }),
            signal,
            coldStartDeadline,
            onRosterReady: (details) => {
              writeProgress([
                role.kind === 'competitor'
                  ? 'Arena server is waiting for the reserved external player to join before the countdown.'
                  : parsed.waitForExternalPlayer
                    ? 'Arena server is waiting for an external player to start the match countdown.'
                    : 'Arena server ready for graphical clients.',
                `Run: ${runId}`,
                `Minecraft Java Edition: ${details.minecraftVersion}`,
                `Address: ${details.host}:${details.port}`,
                `Mode: ${effectiveScenario.mode}, ${effectiveScenario.roster.competitors} competitors`,
                ...(role.kind === 'competitor'
                  ? role.seats.map((entry) => `Role: competitor seat ${entry.seat}, join as ${entry.username}`)
                  : role.kind === 'spectator' ? ['Role: spectator'] : []),
                'Press Ctrl-C to stop the server; it also stops when the match ends.',
              ]);
            },
            onExternalAdmitted: (username) => {
              const entry = externalCompetitors.find((candidate) => candidate.username === username);
              writeProgress([entry === undefined
                ? `Admitted external player ${username}`
                : `Admitted ${username} on seat ${entry.seat}`]);
            },
            onUnexpectedPlayer: (username) => {
              writeProgress([`Player ${username} is not on the roster and does not satisfy the wait.`]);
            },
            onPhase: (phase) => writeProgress([`Phase: ${phase}`]),
          }),
          catch: (cause) => cause,
        });
        const result = await Effect.runPromise(Effect.match(runtime, {
          onFailure: (cause) => ({ kind: 'failure' as const, cause }),
          onSuccess: (completed) => ({ kind: 'success' as const, completed }),
        }));
        if (result.kind === 'failure') throw result.cause;
        const completed = result.completed;
        if (completed.outcome.kind === 'abort') {
          const finalTrace = completed.trace.segments.at(-1);
          throw new RunnerError('runtime_failure', 'completed run', {
            kind: 'operational_abort',
            reason: completed.outcome.reason,
            run_id: completed.runId,
            ...(finalTrace === undefined ? {} : { relative_artifact: finalTrace.relativePath.toString('utf8') }),
          });
        }

        const inspection = await inspectStoppedRun({ helperPath, ownedRoot, runId: completed.runId });
        return success({
          schema: 1,
          run_id: completed.runId,
          scenario_semantic_id: preparedRun.scenario.semanticId,
          role,
          created_paths: {
            run_directory: preparedRun.runDirectoryPath.toString('utf8'),
            world_plan: preparedRun.worldPlanPath.toString('utf8'),
            server_directory: Buffer.concat([preparedRun.runDirectoryPath, Buffer.from('/server', 'ascii')]).toString('utf8'),
          },
          trace: {
            segments: completed.trace.segments.map((segment) => ({
              path: segment.relativePath.toString('utf8'),
              byte_length: segment.byteLength,
            })),
            total_byte_length: completed.trace.totalByteLength,
          },
          report: inspection.report,
          stats: inspection.stats,
        });
      } catch (error) {
        throw includePreparedRunReference(error, runId, preparedRun.runDirectoryPath);
      }
    } catch (error) {
      if (signal.reason instanceof RunnerError && error === signal.reason) throw signal.reason;
      throw error;
    } finally {
      coldStartDeadline.clear();
    }
  });
}

function includePreparedRunReference(error: unknown, runId: string, fallbackPath: Buffer): RunnerError {
  const failure = error instanceof RunnerError
    ? error
    : new RunnerError('runtime_failure', 'arena run', { kind: 'runtime' });
  return new RunnerError(failure.category, failure.resource, {
    ...failure.source,
    run_id: failure.source.run_id ?? runId,
    relative_artifact: failure.source.relative_artifact ?? fallbackPath.toString('utf8'),
  });
}

async function compileScenarioAndPolicy(
  helperPath: string,
  ownedRoot: Buffer,
  scenarioPath: Buffer,
  signal?: AbortSignal,
): Promise<Readonly<{
  scenario: ReturnType<typeof compileScenario>;
  policy: ReturnType<typeof compilePolicy>;
}>> {
  const scenarioSource = decodeSource(await readSource(helperPath, ownedRoot, scenarioPath, 'scenario input', signal), 'scenario input');
  let mapReference: ReturnType<typeof scenarioMapReference>;
  try {
    mapReference = scenarioMapReference(scenarioSource);
  } catch (error) {
    throw mapSpecError(error);
  }
  const mapPath = resolveScenarioResource({ scenarioPath, reference: mapReference });
  const mapSource = decodeSource(await readSource(helperPath, ownedRoot, mapPath, 'map input', signal), 'map input');
  let scenario: ReturnType<typeof compileScenario>;
  try {
    scenario = compileScenario(scenarioSource, mapSource);
  } catch (error) {
    throw mapSpecError(error);
  }
  const policyPath = resolveScenarioResource({ scenarioPath, reference: scenario.policyReference });
  const policySource = decodeSource(await readSource(helperPath, ownedRoot, policyPath, 'policy input', signal), 'policy input');
  let policy: ReturnType<typeof compilePolicy>;
  try {
    policy = compilePolicy(policySource);
  } catch (error) {
    throw mapSpecError(error);
  }
  return Object.freeze({ scenario, policy });
}

async function readSource(
  helperPath: string,
  ownedRoot: Buffer,
  relativePath: Buffer,
  resource: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  try {
    return await readOwnedFile({
      helperPath,
      ownedRoot,
      relativePath,
      maxBytes: MAX_SOURCE_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (!(error instanceof OwnedFilesError)) throw error;
    if (error.category === 'cancelled' && signal?.reason instanceof RunnerError) throw signal.reason;
    const category = error.category === 'cancelled'
      ? 'cancelled'
      : error.category === 'not_found' || error.category === 'helper_start'
        ? 'missing_prerequisite'
        : error.category === 'too_large' || error.category === 'invalid_path'
          || error.category === 'unsupported_file_type' || error.category === 'symlink_rejected'
          ? 'invalid_input'
          : 'runtime_failure';
    throw new RunnerError(category, resource, {
      kind: error.category,
      ...(error.errno === undefined ? {} : { os_code: error.errno }),
    });
  }
}

function decodeSource(bytes: Buffer, resource: string): string {
  try {
    return SOURCE_UTF8.decode(bytes);
  } catch {
    throw new RunnerError('invalid_input', resource, { kind: 'invalid_utf8' });
  }
}

function mapSpecError(error: unknown): RunnerError {
  if (error instanceof SpecError) {
    const source: {
      kind: string;
      field?: string;
      line?: number;
      column?: number;
    } = { kind: error.kind };
    if (error.path !== undefined) source.field = error.path;
    if (error.sourceLocation !== undefined) {
      source.line = error.sourceLocation.line;
      source.column = error.sourceLocation.column;
    }
    const resource = error.path.startsWith('map.')
      ? 'map input'
      : error.path.startsWith('policy.') ? 'policy input' : 'scenario input';
    return new RunnerError('invalid_input', resource, source);
  }
  return new RunnerError('invalid_input', 'scenario input', { kind: 'invalid_scenario' });
}

function configuredAbsolutePath(name: string, resource: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new RunnerError('missing_prerequisite', resource, { kind: 'path_not_configured' });
  }
  if (!isAbsolute(value)) {
    throw new RunnerError('invalid_input', resource, { kind: 'path_not_absolute' });
  }
  return value;
}

async function withProcessAbortSignal<T>(
  operation: (signal: AbortSignal, controller: AbortController) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => controller.abort(new RunnerError('cancelled', 'arena run', { kind: 'cancelled' }));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    return await operation(controller.signal, controller);
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

function normalizeScenarioPath(path: Buffer): Buffer {
  if (path.length === 0 || path.includes(0) || path[0] === 0x2f || path.includes(0x5c)) {
    throw new RunnerError('invalid_input', 'scenario path', { kind: 'invalid_repository_path' });
  }
  const components: Buffer[] = [];
  for (const component of splitPath(path)) {
    if (component.length === 0 || component.equals(Buffer.from('.', 'ascii'))) continue;
    if (component.equals(Buffer.from('..', 'ascii'))) {
      throw new RunnerError('invalid_input', 'scenario path', { kind: 'outside_repository' });
    }
    components.push(component);
  }
  if (components.length === 0) {
    throw new RunnerError('invalid_input', 'scenario path', { kind: 'empty_path' });
  }
  return Buffer.concat(components.flatMap((component, index) => index === 0
    ? [component]
    : [Buffer.from('/', 'ascii'), component]));
}

function splitPath(path: Buffer): Buffer[] {
  const components: Buffer[] = [];
  let start = 0;
  for (let index = 0; index <= path.length; index += 1) {
    if (index !== path.length && path[index] !== 0x2f) continue;
    components.push(Buffer.from(path.subarray(start, index)));
    start = index + 1;
  }
  return components;
}

function helpJson(): object {
  return {
    schema: 1,
    commands: {
      doctor: 'Report runner and runtime capabilities.',
      'gc --dry-run|--apply --run-id <id>...': 'Remove only selected completed runs while retaining the latest three validated failures.',
      'inspect <segment>...': 'Validate and display ordered records from completed trace segments.',
      'inspect --run-id <id>': 'Reconstruct a stopped run result and read its player statistics.',
      'report <segment>...': 'Reconstruct the terminal result from prepared-roster and authoritative event records.',
      'compare <left-segment> <right-segment>': 'Compare two single-segment record streams exactly.',
      'prepare --scenario <path> --run-id <id>': 'Compile a scenario and stage its world plan in a new run directory.',
      'validate --scenario <path>': 'Compile the scenario, map, and policy without staging a run.',
      'run --scenario <path> --accept-minecraft-eula [--run-id <id>] [--reserve-external-spectator-slot] [--wait-for-external-player] [--join-timeout-seconds <n>]': 'Run a match and report its stopped result.',
      'play --scenario <path> --username <name> [--seat <n>] --accept-minecraft-eula [--run-id <id>] [--join-timeout-seconds <n>]': 'Run a match in which one external client holds the reserved competitive seat (default 0).',
      'watch --scenario <path> --accept-minecraft-eula [--run-id <id>] [--join-timeout-seconds <n>]': 'Run a match with one reserved spectator slot and wait for an external client before the countdown.',
      'replay-policy <segment>...': 'Replay recorded core policy decisions and validate correlated skill/path effect records.',
    },
    errors: {
      2: 'invalid input or configuration',
      3: 'missing prerequisite or resource',
      4: 'owned resource or port conflict',
      5: 'corrupt or incomplete evidence',
      6: 'runtime failure',
      130: 'cancelled by the operator',
    },
  };
}

function doctorJson(): object {
  return {
    schema: 1,
    mode: 'headless_runtime_and_evidence',
    capabilities: {
      trace_validation: 'available',
      ordered_record_reconstruction: 'available',
      generic_record_comparison: 'available',
      policy_replay: 'available_for_recorded_policy_frames',
      authoritative_result_reporting: 'available_from_typed_event_stream',
      process_supervision_and_world_reset: 'available',
      scenario_compilation: 'available',
      world_plan_staging: 'available',
      safe_owned_path_staging: 'available',
      stopped_run_inspection: 'available',
      selected_run_cleanup: 'available_for_validated_runs',
    },
  };
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  let result: CliResult;
  try {
    const rawArguments = consumeRawArgv();
    result = await runCliBytes(rawArguments ?? process.argv.slice(2).map((argument) => Buffer.from(argument, 'utf8')));
  } catch (error) {
    result = failure(error);
  }
  if (result.kind === 'success') {
    process.stdout.write(`${result.stdout}\n`);
  } else {
    process.stderr.write(`${result.stderr}\n`);
    process.exitCode = result.exitCode;
  }
}
