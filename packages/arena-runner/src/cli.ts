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
import { prepareRun, resolveScenarioResource } from './prepare.js';
import { replayPolicyJson } from './policy-replay.js';
import { isValidRunId } from './run-id.js';
import { inspectStoppedRun } from './runtime/inspect.js';
import { runPreparedRun } from './runtime/run.js';
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
    if (command === 'run') return await runCommand(rest);
    throw invalidInput('unknown_command');
  } catch (error) {
    return failure(error);
  }
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

async function runCommand(args: readonly Buffer[]): Promise<CliResult> {
  let scenarioArgument: Buffer | undefined;
  let runId: string | undefined;
  for (let index = 0; index < args.length;) {
    const option = argumentText(args[index]!, index + 1);
    if (option === '--scenario') {
      if (scenarioArgument !== undefined || index + 1 >= args.length) {
        throw invalidInput('run_requires_scenario');
      }
      scenarioArgument = args[index + 1]!;
      index += 2;
      continue;
    }
    if (option === '--run-id') {
      if (runId !== undefined || index + 1 >= args.length) throw invalidInput('run_invalid_run_id_option');
      runId = argumentText(args[index + 1]!, index + 2);
      index += 2;
      continue;
    }
    throw invalidInput('unexpected_argument');
  }
  if (scenarioArgument === undefined) throw invalidInput('run_requires_scenario');
  const scenarioPath = normalizeScenarioPath(scenarioArgument);
  runId ??= randomUUID();
  if (!isValidRunId(runId)) {
    throw new RunnerError('invalid_input', 'run id', { kind: 'invalid_run_id' });
  }

  const helperPath = configuredAbsolutePath('ARENA_FS_HELPER', 'filesystem helper');
  const javaHome = configuredAbsolutePath('ARENA_JAVA_HOME', 'Java runtime');
  const paperJarPath = configuredAbsolutePath('ARENA_PAPER_JAR', 'Paper server JAR');
  const pluginJarPath = configuredAbsolutePath('ARENA_PLUGIN_JAR', 'Arena plugin JAR');
  const ownedRoot = Buffer.from(process.cwd(), 'utf8');
  return await withProcessAbortSignal(async (signal) => {
    await compileScenarioAndPolicy(helperPath, ownedRoot, scenarioPath, signal);
    const preparedRun = await prepareRun(helperPath, ownedRoot, scenarioPath, runId!, signal);
    const completed = await runPreparedRun({
      preparedRun,
      helperPath,
      ownedRoot,
      javaExecutable: resolve(javaHome, 'bin', 'java'),
      paperJarPath,
      pluginJarPath,
      signal,
    });
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

async function withProcessAbortSignal<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error('runner process interrupted'));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    return await operation(controller.signal);
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
      'inspect <segment>...': 'Validate and display ordered records from completed trace segments.',
      'inspect --run-id <id>': 'Reconstruct a stopped run result and read its player statistics.',
      'report <segment>...': 'Reconstruct the terminal result from prepared-roster and authoritative event records.',
      'compare <left-segment> <right-segment>': 'Compare two single-segment record streams exactly.',
      'prepare --scenario <path> --run-id <id>': 'Compile a scenario and stage its world plan in a new run directory.',
      'validate --scenario <path>': 'Compile the scenario, map, and policy without staging a run.',
      'run --scenario <path> [--run-id <id>]': 'Run a headless match and report its stopped result.',
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
