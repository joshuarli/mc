import { compileScenario, MAX_SOURCE_BYTES, scenarioMapReference } from '@arena/spec';
import type { ResourceReference, ScenarioIr } from '@arena/spec';
import { TextDecoder } from 'node:util';
import {
  createRunDirectory,
  MAX_WORLD_PLAN_BYTES,
  readOwnedFile,
  removeCreatedDirectory,
  removeCreatedFile,
  stageWorldPlan,
  type FileIdentity,
  OwnedFilesError,
} from './owned-files/index.js';
import { RunnerError } from './errors.js';
import { encodeWorldPlan } from './world-plan.js';

const RUN_DIRECTORY_PREFIX = '.work/arena/runs/';
const WORLD_PLAN_NAME = 'world-plan.json';
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export interface PreparedRun {
  readonly runId: string;
  readonly scenarioPath: Buffer;
  readonly runDirectoryPath: Buffer;
  readonly worldPlanPath: Buffer;
  readonly scenario: ScenarioIr;
  readonly runDirectoryIdentity: FileIdentity;
  readonly worldPlanIdentity: FileIdentity;
}

export async function prepareRun(
  helperPath: string,
  ownedRoot: Buffer,
  scenarioPath: Buffer,
  runId: string,
  signal?: AbortSignal,
): Promise<PreparedRun> {
  const scenarioBytes = await readSource(helperPath, ownedRoot, scenarioPath, 'scenario input', signal);
  const scenarioSource = decodeSource(scenarioBytes, 'scenario input');
  let scenarioMap: ResourceReference;
  try {
    scenarioMap = scenarioMapReference(scenarioSource);
  } catch (error) {
    throw mapSpecError(error);
  }

  const mapPath = resolveScenarioResource({ scenarioPath, reference: scenarioMap });
  const mapBytes = await readSource(helperPath, ownedRoot, mapPath, 'map input', signal);
  const mapSource = decodeSource(mapBytes, 'map input');

  let scenario: ScenarioIr;
  try {
    scenario = compileScenario(scenarioSource, mapSource);
  } catch (error) {
    throw mapSpecError(error);
  }

  let plan: Buffer;
  try {
    plan = encodeWorldPlan(runId, scenario.seed, scenario.map);
  } catch (error) {
    if (error instanceof Error && 'kind' in error && typeof error.kind === 'string') {
      throw new RunnerError('invalid_input', 'world plan', { kind: error.kind });
    }
    throw error;
  }

  const runDirectoryPath = Buffer.from(`${RUN_DIRECTORY_PREFIX}${runId}`, 'utf8');
  const worldPlanPath = Buffer.concat([runDirectoryPath, Buffer.from(`/${WORLD_PLAN_NAME}`, 'utf8')]);
  let runDirectoryIdentity: FileIdentity;
  try {
    runDirectoryIdentity = await createRunDirectory({
      helperPath,
      ownedRoot,
      relativePath: runDirectoryPath,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throw mapPrepareOwnedFilesError(error, 'run directory', signal);
  }

  try {
    const worldPlanIdentity = await stageWorldPlan({
      helperPath,
      ownedRoot,
      destinationRelativePath: worldPlanPath,
      contents: plan,
      maxBytes: MAX_WORLD_PLAN_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
    return Object.freeze({
      runId,
      scenarioPath: Buffer.from(scenarioPath),
      runDirectoryPath,
      worldPlanPath,
      scenario,
      runDirectoryIdentity,
      worldPlanIdentity,
    });
  } catch (stageError) {
    let cleanupError: unknown;
    let published = stageError instanceof OwnedFilesError && stageError.published;
    if (stageError instanceof OwnedFilesError && stageError.published && stageError.identity !== undefined) {
      try {
        await removeCreatedFile({
          helperPath,
          ownedRoot,
          relativePath: worldPlanPath,
          identity: stageError.identity,
        });
        published = false;
      } catch (error) {
        if (error instanceof OwnedFilesError && error.category === 'not_found') published = false;
        else cleanupError = error;
      }
    }
    try {
      await removeCreatedDirectory({
        helperPath,
        ownedRoot,
        relativePath: runDirectoryPath,
        identity: runDirectoryIdentity,
      });
    } catch (error) {
      if (!(error instanceof OwnedFilesError) || error.category !== 'not_found') cleanupError ??= error;
    }

    if (cleanupError !== undefined) throw mapPrepareCleanupError(stageError, cleanupError, published);
    throw mapPrepareOwnedFilesError(stageError, 'world plan', signal, published);
  }
}

async function readSource(
  helperPath: string,
  ownedRoot: Buffer,
  path: Buffer,
  resource: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  try {
    return await readOwnedFile({
      helperPath,
      ownedRoot,
      relativePath: path,
      maxBytes: MAX_SOURCE_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throw mapPrepareOwnedFilesError(error, resource, signal);
  }
}

function decodeSource(bytes: Buffer, resource: string): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new RunnerError('invalid_input', resource, { kind: 'invalid_utf8' });
  }
}

export function resolveScenarioResource(options: Readonly<{
  scenarioPath: Buffer;
  reference: ResourceReference;
}>): Buffer {
  return resolveRepositoryReference(options.scenarioPath, options.reference);
}

function resolveRepositoryReference(scenarioPath: Buffer, reference: string): Buffer {
  const baseEnd = scenarioPath.lastIndexOf(0x2f);
  const stack = baseEnd < 0
    ? []
    : splitPath(scenarioPath.subarray(0, baseEnd));
  for (const component of splitPath(Buffer.from(reference, 'utf8'))) {
    if (component.length === 0 || component.equals(Buffer.from('.', 'ascii'))) continue;
    if (component.equals(Buffer.from('..', 'ascii'))) {
      if (stack.length === 0) throw new RunnerError('invalid_input', 'map reference', { kind: 'outside_repository' });
      stack.pop();
      continue;
    }
    stack.push(component);
  }
  if (stack.length === 0) throw new RunnerError('invalid_input', 'map reference', { kind: 'empty_path' });
  return Buffer.concat(stack.flatMap((component, index) => index === 0
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

function mapSpecError(error: unknown): RunnerError {
  if (error instanceof Error && 'kind' in error && typeof error.kind === 'string') {
    const source: {
      kind: string;
      field?: string;
      line?: number;
      column?: number;
    } = { kind: error.kind };
    if ('path' in error && typeof error.path === 'string') source.field = error.path;
    if ('sourceLocation' in error && error.sourceLocation !== undefined && error.sourceLocation !== null) {
      const position = error.sourceLocation as { readonly line?: unknown; readonly column?: unknown };
      if (typeof position.line === 'number') source.line = position.line;
      if (typeof position.column === 'number') source.column = position.column;
    }
    const resource = source.field?.startsWith('map.') ? 'map input' : 'scenario input';
    return new RunnerError('invalid_input', resource, source);
  }
  return new RunnerError('invalid_input', 'scenario input', { kind: 'invalid_scenario' });
}

function mapOwnedFilesError(error: unknown, resource: string, published?: boolean): RunnerError {
  if (!(error instanceof OwnedFilesError)) {
    return new RunnerError('runtime_failure', resource, { kind: 'owned_file_operation' });
  }

  let category: 'invalid_input' | 'missing_prerequisite' | 'owner_conflict' | 'runtime_failure' | 'cancelled';
  switch (error.category) {
    case 'not_found':
    case 'helper_start':
      category = 'missing_prerequisite';
      break;
    case 'conflict':
      category = 'owner_conflict';
      break;
    case 'cancelled':
      category = 'cancelled';
      break;
    case 'invalid_path':
    case 'symlink_rejected':
    case 'too_large':
    case 'unsupported_file_type':
      category = 'invalid_input';
      break;
    default:
      category = 'runtime_failure';
  }
  return new RunnerError(category, resource, {
    kind: error.category,
    ...(error.errno === undefined ? {} : { os_code: error.errno }),
    ...(error.cleanupErrno === undefined ? {} : { cleanup_os_code: error.cleanupErrno }),
    ...((published ?? error.published) ? { published: true } : {}),
  });
}

function mapPrepareOwnedFilesError(
  error: unknown,
  resource: string,
  signal?: AbortSignal,
  published?: boolean,
): RunnerError {
  if (error instanceof OwnedFilesError && error.category === 'cancelled'
      && signal?.reason instanceof RunnerError) {
    return signal.reason;
  }
  return mapOwnedFilesError(error, resource, published);
}

function mapPrepareCleanupError(stageError: unknown, cleanupError: unknown, published: boolean): RunnerError {
  const stage = stageError instanceof OwnedFilesError ? stageError : undefined;
  const cleanup = cleanupError instanceof OwnedFilesError ? cleanupError : undefined;
  const cleanupErrno = cleanup?.errno ?? stage?.cleanupErrno;
  return new RunnerError('runtime_failure', 'prepared run', {
    kind: 'stage_failed_cleanup_failed',
    ...(stage?.errno === undefined ? {} : { os_code: stage.errno }),
    ...(cleanupErrno === undefined ? {} : { cleanup_os_code: cleanupErrno }),
    ...(published ? { published: true } : {}),
  });
}
