import { randomBytes, randomUUID } from 'node:crypto';
import { CANDIDATE_IDS } from '@arena/core';
import { pathToFileURL } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { compilePolicy, compileScenario, MAX_SOURCE_BYTES, scenarioMapReference, SpecError } from '@arena/spec';
import { OwnedFilesError, readOwnedFile } from './owned-files/index.js';
import { consumeRawArgv, RawArgvError, rawArgumentText } from './owned-files/raw-argv.js';
import { comparisonJson, inspectJson, reconstruct, reportJson, type Evidence } from './evidence.js';
import { canonicalJson } from './canonical.js';
import { RunnerError } from './errors.js';
import { parseWorkerCount } from './workers/assignment.js';
import { compileCandidateProfile } from '@arena/spec';
import { loadCheckpoint } from './checkpoint/persist.js';
import { readSaveResult, requestSave } from './checkpoint/save-request.js';
import { LiveBenchExecutor } from './bench/executor-live.js';
import { benchReport, runMatrix, type MatrixFilter } from './bench/matrix.js';
import { commandPerfGate } from './bench/perf-gate.js';
import { profileById, WORKLOAD_KINDS, type WorkerLayout, type WorkloadKind, type WorldRegime } from './bench/profile.js';
import { parseConcurrency } from './bounded.js';
import { runLeague } from './league/harness.js';
import { DUEL_MAX_ROUNDS, DUEL_MAX_SEEDS, runDuel } from './league/duel.js';
import { runQuality } from './league/quality.js';
import { LiveMatchRunner } from './league/live-runner.js';
import { parseLeagueManifest, parseSeedManifest, profileSpec, resolveLeagueManifest, type CandidateSpec } from './league/manifest.js';
import { OwnedLeagueStore } from './league/store.js';
import { withExternalSeat, type ExternalSeatRequest } from './effective-scenario.js';
import { prepareRun, resolveScenarioResource } from './prepare.js';
import { replayPolicyJson } from './policy-replay.js';
import { isValidRunId } from './run-id.js';
import { inspectStoppedRun, readStoppedRunEvidence } from './runtime/inspect.js';
import { decisionDiffJson } from './decision-diff.js';
import { explainSeatJson } from './funnel-report.js';
import { matchQuality, renderQualityTable, renderSeatTimeline, seatTimeline } from './seat-quality.js';
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
    if (command === 'inspect') return success(inspectJson(evidence));
    const quality = matchQuality(evidence);
    if (quality.seats.length > 0) writeProgress([renderQualityTable([{ label: `run ${evidence.run_id}`, quality }])]);
    return success({ ...reportJson(evidence), seat_quality: quality });
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
  if (command === 'explain') return await explainCommand(rest);
  if (command === 'decision-diff') return await decisionDiffCommand(rest);
  if (command === 'league') return await leagueCommand(rest);
  if (command === 'quality') return await qualityCommand(rest);
  if (command === 'duel') return await duelCommand(rest);
  if (command === 'bench') return await benchCommand(rest);
  if (command === 'prepare') return await prepareCommand(rest);
  if (command === 'validate') return await validateCommand(rest);
  if (command === 'run' || command === 'play' || command === 'watch' || command === 'resume') return await matchCommand(command, rest);
  if (command === 'save') return await saveCommand(rest);
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

async function benchCommand(args: readonly Buffer[]): Promise<CliResult> {
  let profileName: string | undefined;
  let accepted = false;
  let workloads: WorkloadKind[] | undefined;
  let layouts: WorkerLayout[] | undefined;
  let regimes: WorldRegime[] | undefined;
  let maxLevel: number | undefined;
  const list = (value: string): string[] => value.split(',').filter((entry) => entry.length > 0);
  for (let index = 0; index < args.length;) {
    const option = argumentText(args[index]!, index + 1);
    if (option === '--accept-minecraft-eula') {
      if (accepted) throw invalidInput('bench_accept_minecraft_eula_repeated');
      accepted = true;
      index += 1;
      continue;
    }
    if (index + 1 >= args.length) throw invalidInput('unexpected_argument');
    const value = argumentText(args[index + 1]!, index + 2);
    if (option === '--profile' && profileName === undefined) profileName = value;
    else if (option === '--workloads' && workloads === undefined) {
      workloads = list(value).map((entry) => {
        if (!(WORKLOAD_KINDS as readonly string[]).includes(entry)) throw invalidInput('bench_unknown_workload');
        return entry as WorkloadKind;
      });
    } else if (option === '--layouts' && layouts === undefined) {
      layouts = list(value).map((entry) => {
        if (entry !== '1' && entry !== '2' && entry !== '4') throw invalidInput('bench_invalid_layout');
        return Number(entry) as WorkerLayout;
      });
    } else if (option === '--regimes' && regimes === undefined) {
      regimes = list(value).map((entry) => {
        if (entry !== 'cold_world' && entry !== 'prepared_world') throw invalidInput('bench_invalid_regime');
        return entry;
      });
    } else if (option === '--max-level' && maxLevel === undefined) {
      if (!/^[1-9][0-9]{0,2}$/.test(value)) throw invalidInput('bench_invalid_max_level');
      maxLevel = Number(value);
    } else throw invalidInput('unexpected_argument');
    index += 2;
  }
  if (profileName === undefined) throw invalidInput('bench_requires_profile');
  const profile = profileById(profileName);
  if (profile === undefined) throw invalidInput('bench_unknown_profile');
  if (!accepted) throw new RunnerError('missing_prerequisite', 'Minecraft EULA', { kind: 'missing_eula' });
  const helperPath = configuredAbsolutePath('ARENA_FS_HELPER', 'filesystem helper');
  const javaHome = configuredAbsolutePath('ARENA_JAVA_HOME', 'Java runtime');
  const paperJarPath = configuredAbsolutePath('ARENA_PAPER_JAR', 'Paper server JAR');
  const pluginJarPath = configuredAbsolutePath('ARENA_PLUGIN_JAR', 'Arena plugin JAR');
  const ownedRoot = Buffer.from(process.cwd(), 'utf8');
  const templatePath = Buffer.from('scenarios/hunger-24.toml', 'utf8');
  return await withProcessAbortSignal(async (signal) => {
    const templateSource = decodeSource(await readSource(helperPath, ownedRoot, templatePath, 'scenario input', signal), 'scenario input');
    const executor = new LiveBenchExecutor({
      helperPath, ownedRoot, javaExecutable: resolve(javaHome, 'bin', 'java'), paperJarPath, pluginJarPath,
      profileId: profile.id, templatePath, templateSource,
    });
    const filter: MatrixFilter = {
      ...(workloads === undefined ? {} : { workloads }),
      ...(layouts === undefined ? {} : { layouts }),
      ...(regimes === undefined ? {} : { regimes }),
      ...(maxLevel === undefined ? {} : { maxLevel }),
    };
    const cells = await runMatrix({
      profile, executor, gate: commandPerfGate(), signal, filter,
      progress: (message) => writeProgress([`Bench ${profile.id}: ${message}`]),
    });
    return success(benchReport(profile, cells));
  });
}

async function saveCommand(args: readonly Buffer[]): Promise<CliResult> {
  let runId: string | undefined;
  let checkpointId: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const option = argumentText(args[index]!, index + 1);
    if (index + 1 >= args.length) throw invalidInput('save_requires_run_id');
    const value = argumentText(args[index + 1]!, index + 2);
    if (option === '--run-id' && runId === undefined) runId = value;
    else if (option === '--checkpoint-id' && checkpointId === undefined) checkpointId = value;
    else throw invalidInput('unexpected_argument');
  }
  if (runId === undefined) throw invalidInput('save_requires_run_id');
  if (!isValidRunId(runId)) throw new RunnerError('invalid_input', 'run id', { kind: 'invalid_run_id' });
  const id = checkpointId ?? `${runId.slice(0, 58)}-cp`;
  const helperPath = configuredAbsolutePath('ARENA_FS_HELPER', 'filesystem helper');
  const files = {
    helperPath,
    ownedRoot: Buffer.from(process.cwd(), 'utf8'),
    runDirectoryPath: Buffer.from(`.work/arena/runs/${runId}`, 'utf8'),
  };
  return await withProcessAbortSignal(async (signal) => {
    await requestSave(files, id);
    writeProgress([`Save requested for run ${runId} as checkpoint ${id}`]);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const result = await readSaveResult(files);
      if (result !== undefined) {
        if (result.status === 'failed') {
          throw new RunnerError('runtime_failure', 'checkpoint save', {
            kind: 'save_failed', reason: result.reason, run_id: runId, relative_artifact: files.runDirectoryPath.toString('utf8'),
          });
        }
        return success(result);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
    throw new RunnerError('runtime_failure', 'checkpoint save', {
      kind: 'save_timeout', run_id: runId, relative_artifact: files.runDirectoryPath.toString('utf8'),
    });
  });
}

async function leagueCommand(args: readonly Buffer[]): Promise<CliResult> {
  let manifestArgument: Buffer | undefined;
  let accepted = false;
  let concurrency = 1;
  for (let index = 0; index < args.length;) {
    const option = argumentText(args[index]!, index + 1);
    if (option === '--concurrency') {
      const parsed = index + 1 < args.length ? parseConcurrency(argumentText(args[index + 1]!, index + 2)) : undefined;
      if (parsed === undefined) throw invalidInput('league_invalid_concurrency');
      concurrency = parsed;
      index += 2;
    } else if (option === '--manifest') {
      if (manifestArgument !== undefined || index + 1 >= args.length) throw invalidInput('league_requires_manifest');
      manifestArgument = args[index + 1]!;
      index += 2;
    } else if (option === '--accept-minecraft-eula') {
      if (accepted) throw invalidInput('league_accept_minecraft_eula_repeated');
      accepted = true;
      index += 1;
    } else {
      throw invalidInput('unexpected_argument');
    }
  }
  if (manifestArgument === undefined) throw invalidInput('league_requires_manifest');
  if (!accepted) throw new RunnerError('missing_prerequisite', 'Minecraft EULA', { kind: 'missing_eula' });
  const manifestPath = normalizeScenarioPath(manifestArgument);
  const helperPath = configuredAbsolutePath('ARENA_FS_HELPER', 'filesystem helper');
  const javaHome = configuredAbsolutePath('ARENA_JAVA_HOME', 'Java runtime');
  const paperJarPath = configuredAbsolutePath('ARENA_PAPER_JAR', 'Paper server JAR');
  const pluginJarPath = configuredAbsolutePath('ARENA_PLUGIN_JAR', 'Arena plugin JAR');
  const ownedRoot = Buffer.from(process.cwd(), 'utf8');
  const resolveFrom = (base: Buffer, reference: string) =>
    resolveScenarioResource({ scenarioPath: base, reference: reference as Parameters<typeof resolveScenarioResource>[0]['reference'] });
  const readText = async (path: Buffer, resource: string, signal?: AbortSignal) =>
    decodeSource(await readSource(helperPath, ownedRoot, path, resource, signal), resource);

  return await withProcessAbortSignal(async (signal) => {
    const draft = parseLeagueManifest(await readText(manifestPath, 'league manifest', signal));
    const seeds = parseSeedManifest(await readText(resolveFrom(manifestPath, draft.seeds), 'seed manifest', signal));
    const profiles = new Map<string, CandidateSpec>();
    for (const entry of [...draft.candidateEntries, ...draft.opponentEntries]) {
      if (entry.kind !== 'profile' || profiles.has(entry.path)) continue;
      const source = await readText(resolveFrom(manifestPath, entry.path), 'candidate profile', signal);
      try {
        const profile = compileCandidateProfile(source);
        profiles.set(entry.path, profileSpec({ id: profile.id, params: profile.params }));
      } catch (error) {
        throw mapSpecError(error);
      }
    }
    const manifest = resolveLeagueManifest(draft, profiles);
    const scenarioPath = resolveFrom(manifestPath, manifest.scenario);
    const scenarioSource = await readText(scenarioPath, 'scenario input', signal);
    const runner = new LiveMatchRunner({
      helperPath, ownedRoot, javaExecutable: resolve(javaHome, 'bin', 'java'), paperJarPath, pluginJarPath,
      leagueId: manifest.id, scenarioPath, scenarioSource,
    });
    const store = new OwnedLeagueStore({ helperPath, ownedRoot, leagueId: manifest.id });
    const report = await runLeague({
      manifest, seeds, store, runner, signal, concurrency,
      progress: {
        summary: (text) => writeProgress([text]),
        matchStarted: (plan, index, total) => writeProgress([
          `League ${manifest.id}: match ${index + 1}/${total} ${plan.matchId} (${plan.candidate.id} vs ${plan.opponent.label}, seed ${plan.worldSeed})`,
        ]),
        matchSettled: (plan, observation, reused) => writeProgress([
          `League ${manifest.id}: ${plan.matchId} ${reused ? 'reused' : observation.status}`,
        ]),
      },
    });
    return success(report);
  });
}

async function qualityCommand(args: readonly Buffer[]): Promise<CliResult> {
  let scenarioArgument: Buffer | undefined;
  let seedsText: string | undefined;
  let candidateText: string | undefined;
  let concurrency = 1;
  let accepted = false;
  for (let index = 0; index < args.length;) {
    const option = argumentText(args[index]!, index + 1);
    if (option === '--accept-minecraft-eula') {
      if (accepted) throw invalidInput('quality_accept_minecraft_eula_repeated');
      accepted = true;
      index += 1;
      continue;
    }
    if (index + 1 >= args.length) throw invalidInput('quality_option_requires_value');
    const value = args[index + 1]!;
    if (option === '--scenario' && scenarioArgument === undefined) scenarioArgument = value;
    else if (option === '--seeds' && seedsText === undefined) seedsText = argumentText(value, index + 2);
    else if (option === '--candidate' && candidateText === undefined) candidateText = argumentText(value, index + 2);
    else if (option === '--concurrency') {
      const parsed = parseConcurrency(argumentText(value, index + 2));
      if (parsed === undefined) throw invalidInput('quality_invalid_concurrency');
      concurrency = parsed;
    } else throw invalidInput('unexpected_argument');
    index += 2;
  }
  if (scenarioArgument === undefined) throw invalidInput('quality_requires_scenario');
  if (seedsText === undefined) throw invalidInput('quality_requires_seeds');
  const seeds = seedsText.split(',').map((entry) => {
    if (!/^(0|[1-9][0-9]{0,15})$/.test(entry)) throw invalidInput('quality_invalid_seed');
    return Number(entry);
  });
  if (seeds.length > 64 || new Set(seeds).size !== seeds.length) throw invalidInput('quality_invalid_seeds');
  const candidateId = candidateText ?? 'baseline';
  if (!(CANDIDATE_IDS as readonly string[]).includes(candidateId)) throw invalidInput('quality_unknown_candidate');
  if (!accepted) throw new RunnerError('missing_prerequisite', 'Minecraft EULA', { kind: 'missing_eula' });
  const scenarioPath = normalizeScenarioPath(scenarioArgument);
  const helperPath = configuredAbsolutePath('ARENA_FS_HELPER', 'filesystem helper');
  const javaHome = configuredAbsolutePath('ARENA_JAVA_HOME', 'Java runtime');
  const paperJarPath = configuredAbsolutePath('ARENA_PAPER_JAR', 'Paper server JAR');
  const pluginJarPath = configuredAbsolutePath('ARENA_PLUGIN_JAR', 'Arena plugin JAR');
  const ownedRoot = Buffer.from(process.cwd(), 'utf8');
  return await withProcessAbortSignal(async (signal) => {
    const inputs = await compileScenarioAndPolicy(helperPath, ownedRoot, scenarioPath, signal);
    if (inputs.scenario.mode !== 'hunger_games') throw invalidInput('quality_requires_hunger_games');
    const scenarioSource = decodeSource(await readSource(helperPath, ownedRoot, scenarioPath, 'scenario input', signal), 'scenario input');
    const runner = new LiveMatchRunner({
      helperPath, ownedRoot, javaExecutable: resolve(javaHome, 'bin', 'java'), paperJarPath, pluginJarPath,
      leagueId: 'quality', scenarioPath, scenarioSource,
    });
    const { report, text } = await runQuality({
      request: {
        scenario: scenarioPath.toString('utf8'),
        seeds,
        competitors: Number(inputs.scenario.roster.competitors),
        candidate: { id: candidateId as CandidateSpec['id'], params: {} },
        baseline: { id: 'baseline', params: {} },
        runTag: randomBytes(3).toString('hex'),
      },
      runner, concurrency, signal,
      progress: (message) => writeProgress([`Quality: ${message}`]),
    });
    writeProgress([text]);
    const store = new OwnedLeagueStore({ helperPath, ownedRoot, leagueId: 'quality' });
    const path = await store.writeReport(report);
    return success({ ...report, report_path: path });
  });
}

async function duelCommand(args: readonly Buffer[]): Promise<CliResult> {
  let scenarioArgument: Buffer | undefined;
  let seedsText: string | undefined;
  let candidateText: string | undefined;
  let opponentText: string | undefined;
  let roundsText: string | undefined;
  let concurrency = 1;
  let accepted = false;
  for (let index = 0; index < args.length;) {
    const option = argumentText(args[index]!, index + 1);
    if (option === '--accept-minecraft-eula') {
      if (accepted) throw invalidInput('duel_accept_minecraft_eula_repeated');
      accepted = true;
      index += 1;
      continue;
    }
    if (index + 1 >= args.length) throw invalidInput('duel_option_requires_value');
    const value = args[index + 1]!;
    if (option === '--scenario' && scenarioArgument === undefined) scenarioArgument = value;
    else if (option === '--seeds' && seedsText === undefined) seedsText = argumentText(value, index + 2);
    else if (option === '--candidate' && candidateText === undefined) candidateText = argumentText(value, index + 2);
    else if (option === '--opponent' && opponentText === undefined) opponentText = argumentText(value, index + 2);
    else if (option === '--rounds' && roundsText === undefined) roundsText = argumentText(value, index + 2);
    else if (option === '--concurrency') {
      const parsed = parseConcurrency(argumentText(value, index + 2));
      if (parsed === undefined) throw invalidInput('duel_invalid_concurrency');
      concurrency = parsed;
    } else throw invalidInput('unexpected_argument');
    index += 2;
  }
  if (opponentText === 'pool') throw invalidInput('duel_opponent_pool_unavailable');
  if (scenarioArgument === undefined) throw invalidInput('duel_requires_scenario');
  if (seedsText === undefined) throw invalidInput('duel_requires_seeds');
  if (candidateText === undefined) throw invalidInput('duel_requires_candidate');
  if (opponentText === undefined) throw invalidInput('duel_requires_opponent');
  if (roundsText === undefined) throw invalidInput('duel_requires_rounds');
  const seeds = seedsText.split(',').map((entry) => {
    if (!/^(0|[1-9][0-9]{0,15})$/.test(entry)) throw invalidInput('duel_invalid_seed');
    return Number(entry);
  });
  if (seeds.length === 0 || seeds.length > DUEL_MAX_SEEDS || new Set(seeds).size !== seeds.length) {
    throw invalidInput('duel_invalid_seeds');
  }
  if (!/^[1-9][0-9]?$/.test(roundsText)) throw invalidInput('duel_invalid_rounds');
  const rounds = Number(roundsText);
  if (rounds > DUEL_MAX_ROUNDS) throw invalidInput('duel_invalid_rounds');
  const ids = CANDIDATE_IDS as readonly string[];
  if (!ids.includes(candidateText)) throw invalidInput('duel_unknown_candidate');
  if (!ids.includes(opponentText)) throw invalidInput('duel_unknown_opponent');
  if (!accepted) throw new RunnerError('missing_prerequisite', 'Minecraft EULA', { kind: 'missing_eula' });
  const scenarioPath = normalizeScenarioPath(scenarioArgument);
  const helperPath = configuredAbsolutePath('ARENA_FS_HELPER', 'filesystem helper');
  const ownedRoot = Buffer.from(process.cwd(), 'utf8');
  return await withProcessAbortSignal(async (signal) => {
    const inputs = await compileScenarioAndPolicy(helperPath, ownedRoot, scenarioPath, signal);
    if (inputs.scenario.mode !== 'hunger_games') throw invalidInput('duel_requires_hunger_games');
    if (inputs.scenario.roster.competitors !== 2) throw invalidInput('duel_requires_two_competitors');
    const javaHome = configuredAbsolutePath('ARENA_JAVA_HOME', 'Java runtime');
    const paperJarPath = configuredAbsolutePath('ARENA_PAPER_JAR', 'Paper server JAR');
    const pluginJarPath = configuredAbsolutePath('ARENA_PLUGIN_JAR', 'Arena plugin JAR');
    const scenarioSource = decodeSource(await readSource(helperPath, ownedRoot, scenarioPath, 'scenario input', signal), 'scenario input');
    const runner = new LiveMatchRunner({
      helperPath, ownedRoot, javaExecutable: resolve(javaHome, 'bin', 'java'), paperJarPath, pluginJarPath,
      leagueId: 'duel', scenarioPath, scenarioSource,
    });
    const { report, text } = await runDuel({
      request: {
        scenario: scenarioPath.toString('utf8'),
        seeds,
        rounds,
        candidate: { id: candidateText as CandidateSpec['id'], params: {} },
        opponent: { id: opponentText as CandidateSpec['id'], params: {} },
        runTag: randomBytes(3).toString('hex'),
      },
      runner, concurrency, signal,
      progress: (message) => writeProgress([`Duel: ${message}`]),
    });
    writeProgress([text]);
    const store = new OwnedLeagueStore({ helperPath, ownedRoot, leagueId: 'duel' });
    const path = await store.writeReport(report);
    return success({ ...report, report_path: path });
  });
}

async function explainCommand(args: readonly Buffer[]): Promise<CliResult> {
  if (args.length !== 4 || argumentText(args[0]!, 1) !== '--run-id' || argumentText(args[2]!, 3) !== '--seat') {
    throw invalidInput('explain_requires_run_id_and_seat');
  }
  const runId = argumentText(args[1]!, 2);
  if (!isValidRunId(runId)) throw new RunnerError('invalid_input', 'run id', { kind: 'invalid_run_id' });
  const seatText = argumentText(args[3]!, 4);
  if (!/^(0|[1-9][0-9]{0,2})$/.test(seatText) || Number(seatText) > 255) throw invalidInput('explain_invalid_seat');
  const helperPath = configuredAbsolutePath('ARENA_FS_HELPER', 'filesystem helper');
  const evidence = await readStoppedRunEvidence({ helperPath, ownedRoot: Buffer.from(process.cwd(), 'utf8'), runId });
  writeProgress([renderSeatTimeline(Number(seatText), seatTimeline(evidence, Number(seatText)))]);
  return success(explainSeatJson(evidence, Number(seatText)));
}

async function decisionDiffCommand(args: readonly Buffer[]): Promise<CliResult> {
  let runId: string | undefined;
  let baseline = 'baseline';
  let challenger: string | undefined;
  let seat: number | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const option = argumentText(args[index]!, index + 1);
    if (index + 1 >= args.length) throw invalidInput('decision_diff_option_requires_value');
    const value = argumentText(args[index + 1]!, index + 2);
    if (option === '--run-id' && runId === undefined) runId = value;
    else if (option === '--baseline') baseline = value;
    else if (option === '--candidate' && challenger === undefined) challenger = value;
    else if (option === '--seat' && seat === undefined && /^(0|[1-9][0-9]{0,2})$/.test(value) && Number(value) <= 255) seat = Number(value);
    else throw invalidInput('unexpected_argument');
  }
  if (runId === undefined || challenger === undefined) throw invalidInput('decision_diff_requires_run_id_and_candidate');
  if (!isValidRunId(runId)) throw new RunnerError('invalid_input', 'run id', { kind: 'invalid_run_id' });
  const ids = CANDIDATE_IDS as readonly string[];
  if (!ids.includes(baseline) || !ids.includes(challenger)) throw invalidInput('decision_diff_unknown_candidate');
  const helperPath = configuredAbsolutePath('ARENA_FS_HELPER', 'filesystem helper');
  const evidence = await readStoppedRunEvidence({ helperPath, ownedRoot: Buffer.from(process.cwd(), 'utf8'), runId });
  return success(decisionDiffJson(evidence, {
    baseline: baseline as CandidateSpec['id'], challenger: challenger as CandidateSpec['id'],
    ...(seat === undefined ? {} : { seat }),
  }));
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

type MatchCommand = 'run' | 'play' | 'watch' | 'resume';

interface MatchArguments {
  readonly scenarioArgument: Buffer | undefined;
  readonly checkpoint: string | undefined;
  readonly runId: string | undefined;
  readonly spectatorMode: RuntimeSpectatorMode;
  readonly waitForExternalPlayer: boolean;
  readonly externalSeat: ExternalSeatRequest | undefined;
  readonly joinTimeoutMs: number | undefined;
  readonly workers: number;
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
  let workers: number | undefined;
  let checkpoint: string | undefined;
  const takesLegacyFlags = command === 'run';
  for (let index = 0; index < args.length;) {
    const option = argumentText(args[index]!, index + 1);
    const hasValue = index + 1 < args.length;
    if (command === 'resume' && option === '--checkpoint') {
      if (checkpoint !== undefined || !hasValue) throw invalidInput('resume_requires_checkpoint');
      checkpoint = argumentText(args[index + 1]!, index + 2);
      index += 2;
      continue;
    }
    if (command !== 'resume' && option === '--scenario') {
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
    if (option === '--workers') {
      const text = hasValue ? argumentText(args[index + 1]!, index + 2) : '';
      if (workers !== undefined || !/^[1-9][0-9]?$/.test(text)) throw invalidInput(`${command}_invalid_workers`);
      try { workers = parseWorkerCount(Number(text)); } catch { throw invalidInput(`${command}_invalid_workers`); }
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
  if (command === 'resume' ? checkpoint === undefined : scenarioArgument === undefined) {
    throw invalidInput(command === 'resume' ? 'resume_requires_checkpoint' : `${command}_requires_scenario`);
  }
  if (command === 'play' && username === undefined) throw invalidInput('play_requires_username');
  if (!acceptMinecraftEula) {
    throw new RunnerError('missing_prerequisite', 'Minecraft EULA', { kind: 'missing_eula' });
  }
  return Object.freeze({
    scenarioArgument,
    checkpoint,
    runId,
    spectatorMode: command === 'watch' || reserveSpectatorSlot ? 'reserveExternalSlot' : 'automated',
    waitForExternalPlayer: command === 'watch' || waitForExternalPlayer,
    externalSeat: command === 'play' ? { seat: seat ?? 0, username: username! } : undefined,
    joinTimeoutMs,
    workers: workers ?? 1,
  });
}

function writeProgress(lines: readonly string[]): void {
  process.stderr.write(`${lines.join('\n')}\n`);
}

async function matchCommand(command: MatchCommand, args: readonly Buffer[]): Promise<CliResult> {
  const parsed = parseMatchArguments(command, args);
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
      const resumed = parsed.checkpoint === undefined ? undefined
        : await loadCheckpoint({ helperPath, ownedRoot, checkpointId: parsed.checkpoint, signal });
      const scenarioPath = resumed === undefined
        ? normalizeScenarioPath(parsed.scenarioArgument!)
        : Buffer.from(resumed.manifest.scenario.path, 'utf8');
      const externalSeat = resumed === undefined ? parsed.externalSeat
        : resumed.manifest.scenario.external_seat ?? undefined;
      const inputs = await compileScenarioAndPolicy(helperPath, ownedRoot, scenarioPath, signal);
      const effectiveScenario = externalSeat === undefined
        ? inputs.scenario
        : withExternalSeat(inputs.scenario, externalSeat);
      if (resumed !== undefined && effectiveScenario.semanticId !== resumed.manifest.scenario.semantic_id) {
        throw new RunnerError('invalid_input', 'checkpoint', { kind: 'scenario_changed_since_checkpoint' });
      }
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
        ...(externalSeat === undefined ? {} : { externalSeat }),
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
            workers: parsed.workers,
            checkpointing: true as const,
            checkpointScenario: { externalSeat: externalSeat ?? null },
            ...(resumed === undefined ? {} : { resume: resumed }),
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
        if (completed.checkpoint !== undefined) {
          return success({
            schema: 1,
            run_id: completed.runId,
            checkpointed: {
              checkpoint_id: completed.checkpoint.checkpoint_id,
              epoch: completed.checkpoint.epoch,
              match_tick: completed.checkpoint.match_tick,
              digest: completed.checkpoint.record.digest,
              directory: `.work/arena/checkpoints/${completed.checkpoint.checkpoint_id}`,
            },
          });
        }
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
          ...(completed.degraded === undefined ? {} : {
            degraded: true,
            worker_losses: completed.degraded.map((loss) => ({
              worker: loss.worker, epoch: loss.epoch, seats: loss.seats, reason: loss.reason,
            })),
          }),
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
      'decision-diff --run-id <id> --candidate <id> [--baseline <id>] [--seat <n>]': 'Replay a run\'s recorded observations and memory through two candidates and list the decisions that differ, with reason codes.',
      'explain --run-id <id> --seat <n>': 'Tie one seat\'s recorded decisions to permitted evidence, skill outcomes, funnel stages, and authoritative effects.',
      'bench --profile scale-v1 --accept-minecraft-eula [--workloads <list>] [--layouts <1,2,4>] [--regimes <list>] [--max-level <n>]': 'Measure the highest qualifying population per workload against fixed quality floors.',
      'save --run-id <id> [--checkpoint-id <id>]': 'Checkpoint a running generalized-roster Hunger match, stop it, and publish the checkpoint.',
      'resume --checkpoint <id> --accept-minecraft-eula [--run-id <id>] [--join-timeout-seconds <n>]': 'Resume a saved match in a new run at the next epoch.',
      'league --manifest <path> --accept-minecraft-eula [--concurrency <1-4>]': 'Run or resume a league of candidate policies against frozen opponents and report the paired analysis, per-seat quality, and quality gates.',
      'quality --scenario <path> --seeds <a,b,c> --accept-minecraft-eula [--candidate <id>] [--concurrency <1-4>]': 'Run one Hunger Games match per seed, concurrently on ephemeral ports, and report the per-seat quality table and quality gates.',
      'duel --scenario <path> --candidate <id> --opponent <id|pool> --seeds <a,b,c> --rounds <1-3> --accept-minecraft-eula [--concurrency <1-4>]': 'Run both seat assignments of a two-competitor Hunger Games duel for each seed and round, and report the paired score. --opponent pool is rejected until a frozen opponent pool exists.',
      'prepare --scenario <path> --run-id <id>': 'Compile a scenario and stage its world plan in a new run directory.',
      'validate --scenario <path>': 'Compile the scenario, map, and policy without staging a run.',
      'run --scenario <path> --accept-minecraft-eula [--run-id <id>] [--reserve-external-spectator-slot] [--wait-for-external-player] [--join-timeout-seconds <n>] [--workers <n>]': 'Run a match and report its stopped result.',
      'play --scenario <path> --username <name> [--seat <n>] --accept-minecraft-eula [--run-id <id>] [--join-timeout-seconds <n>] [--workers <n>]': 'Run a match in which one external client holds the reserved competitive seat (default 0).',
      'watch --scenario <path> --accept-minecraft-eula [--run-id <id>] [--join-timeout-seconds <n>] [--workers <n>]': 'Run a match with one reserved spectator slot and wait for an external client before the countdown.',
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
