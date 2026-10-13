import { pathToFileURL } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { OwnedFilesError } from './owned-files/index.js';
import { consumeRawArgv, RawArgvError, rawArgumentText } from './owned-files/raw-argv.js';
import { comparisonJson, inspectJson, reconstruct, reportJson, type Evidence } from './evidence.js';
import { canonicalJson } from './canonical.js';
import { RunnerError } from './errors.js';
import { prepareRun } from './prepare.js';
import { readSegment, TraceError, type TraceSegment } from './trace.js';

export type CliResult =
  | { readonly kind: 'success'; readonly exitCode: 0; readonly stdout: string }
  | { readonly kind: 'failure'; readonly exitCode: 2 | 3 | 5 | 6; readonly stderr: string };

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
    if (command === 'inspect' || command === 'report') {
      const evidence = await loadEvidence(rest);
      return success(command === 'inspect' ? inspectJson(evidence) : reportJson(evidence));
    }
    if (command === 'compare') {
      if (rest.length !== 2) throw invalidInput('compare_requires_two_trace_sets');
      const left = await loadSingleSegment(rest[0]!, 1);
      const right = await loadSingleSegment(rest[1]!, 2);
      return success(comparisonJson(left, right));
    }
    if (command === 'prepare') return await prepareCommand(rest);
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
  const helperPath = process.env.ARENA_FS_HELPER;
  if (helperPath === undefined || helperPath.length === 0) {
    throw new RunnerError('missing_prerequisite', 'filesystem helper', { kind: 'helper_not_configured' });
  }
  if (!isAbsolute(helperPath)) {
    throw new RunnerError('invalid_input', 'filesystem helper', { kind: 'helper_path_not_absolute' });
  }

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
      doctor: 'Report offline evidence capabilities and parked integrations.',
      'inspect <segment>...': 'Validate and display ordered records from completed trace segments.',
      'report <segment>...': 'Build an offline evidence report from completed trace segments.',
      'compare <left-segment> <right-segment>': 'Compare two single-segment record streams exactly.',
      'prepare --scenario <path> --run-id <id>': 'Compile a scenario and stage its world plan in a new run directory.',
    },
    errors: {
      2: 'invalid input or configuration',
      3: 'missing prerequisite or resource',
      5: 'corrupt or incomplete evidence',
      6: 'runtime failure',
    },
  };
}

function doctorJson(): object {
  return {
    schema: 1,
    mode: 'offline_prepare_and_evidence',
    capabilities: {
      trace_validation: 'available',
      ordered_record_reconstruction: 'available',
      generic_record_comparison: 'available',
      policy_replay: 'parked_missing_recorded_input_and_policy_contracts',
      authoritative_result_reporting: 'parked_missing_j1_event_contract',
      process_supervision_and_world_reset: 'parked_missing_live_prerequisites',
      scenario_compilation: 'available',
      world_plan_staging: 'available',
      safe_owned_path_staging: 'available',
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
