import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { comparisonJson, inspectJson, reconstruct, reportJson, type Evidence } from './evidence.js';
import { canonicalJson } from './canonical.js';
import { RunnerError } from './errors.js';
import { readSegment, TraceError, type TraceSegment } from './trace.js';

export type CliResult =
  | { readonly kind: 'success'; readonly exitCode: 0; readonly stdout: string }
  | { readonly kind: 'failure'; readonly exitCode: 2 | 3 | 5 | 6; readonly stderr: string };

export async function runCli(args: readonly string[]): Promise<CliResult> {
  try {
    const [command, ...rest] = args;
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
    throw invalidInput('unknown_command');
  } catch (error) {
    if (error instanceof RunnerError) {
      return { kind: 'failure', exitCode: error.exitCode(), stderr: error.toJson() };
    }
    if (error instanceof TraceError) {
      const runnerError = new RunnerError('corrupt_evidence', 'trace segment set', error.source);
      return { kind: 'failure', exitCode: runnerError.exitCode(), stderr: runnerError.toJson() };
    }
    const runtimeError = new RunnerError('runtime_failure', 'arena runner', { kind: 'runtime' });
    return { kind: 'failure', exitCode: runtimeError.exitCode(), stderr: runtimeError.toJson() };
  }
}

function success(value: object): CliResult {
  return { kind: 'success', exitCode: 0, stdout: canonicalJson(value) };
}

async function loadEvidence(paths: readonly string[]): Promise<Evidence> {
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

async function loadSingleSegment(path: string, setNumber: number): Promise<Evidence> {
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

function helpJson(): object {
  return {
    schema: 1,
    commands: {
      doctor: 'Report offline evidence capabilities and parked integrations.',
      'inspect <segment>...': 'Validate and display ordered records from completed trace segments.',
      'report <segment>...': 'Build an offline evidence report from completed trace segments.',
      'compare <left-segment> <right-segment>': 'Compare two single-segment record streams exactly.',
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
    mode: 'offline_evidence',
    capabilities: {
      trace_validation: 'available',
      ordered_record_reconstruction: 'available',
      generic_record_comparison: 'available',
      policy_replay: 'parked_missing_recorded_input_and_policy_contracts',
      authoritative_result_reporting: 'parked_missing_j1_event_contract',
      process_supervision_and_world_reset: 'parked_missing_live_prerequisites',
      safe_owned_path_staging: 'parked_missing_handle_relative_filesystem_support',
    },
  };
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  const result = await runCli(process.argv.slice(2));
  if (result.kind === 'success') {
    process.stdout.write(`${result.stdout}\n`);
  } else {
    process.stderr.write(`${result.stderr}\n`);
    process.exitCode = result.exitCode;
  }
}
