import { sha256Json } from '../canonical.js';
import { createHash } from 'node:crypto';
import {
  cloneOwnedTree,
  createOwnedDirectory,
  MAX_OWNED_TREE_BYTES,
  MAX_OWNED_TREE_FILES,
  OwnedFilesError,
} from '../owned-files/index.js';
import { RunnerError } from '../errors.js';
import type { PreparedRun } from '../prepare.js';
import type { ScenarioIr } from '@arena/spec';

const templateBuilds = new Map<string, Promise<void>>();

export async function clonePristineWorld(options: Readonly<{
  helperPath: string;
  ownedRoot: Buffer;
  preparedRun: PreparedRun;
  scenario: ScenarioIr;
  javaExecutable: string;
  paperJarPath: string;
  pluginJarPath: string;
  pluginJarBytes: Buffer;
  serverPath: Buffer;
  signal?: AbortSignal;
  createBootstrapWorld(): Promise<Buffer>;
}>): Promise<void> {
  const templateWorld = templateWorldPath({
    scenario: options.scenario,
    javaExecutable: options.javaExecutable,
    paperJarPath: options.paperJarPath,
    pluginJarPath: options.pluginJarPath,
    pluginJarBytes: options.pluginJarBytes,
  });
  const runWorld = Buffer.concat([options.serverPath, Buffer.from('/world', 'ascii')]);
  try {
    await cloneTree(options, templateWorld, runWorld);
    return;
  } catch (error) {
    if (!isMissingTemplate(error)) throw mapCloneError(error, 'pristine arena world');
  }

  const key = templateWorld.toString('utf8');
  let build = templateBuilds.get(key);
  if (build === undefined) {
    build = buildAndPublishTemplate(options, templateWorld);
    templateBuilds.set(key, build);
    const removeBuild = (): void => {
      if (templateBuilds.get(key) === build) templateBuilds.delete(key);
    };
    void build.then(removeBuild, removeBuild);
  }
  await build;
  try {
    await cloneTree(options, templateWorld, runWorld);
  } catch (error) {
    throw mapCloneError(error, 'pristine arena world');
  }
}

export function templateWorldPath(options: Readonly<{
  scenario: ScenarioIr;
  javaExecutable: string;
  paperJarPath: string;
  pluginJarPath: string;
  pluginJarBytes: Buffer;
}>): Buffer {
  const key = sha256Json({
    scenario_semantic_id: options.scenario.semanticId,
    minecraft_version: options.scenario.server.minecraft,
    java_executable: options.javaExecutable,
    paper_artifact: options.paperJarPath,
    plugin_artifact: options.pluginJarPath,
    plugin_sha256: createHash('sha256').update(options.pluginJarBytes).digest('hex'),
  });
  return Buffer.from(`.work/arena/templates/${key}/world`, 'ascii');
}

async function buildAndPublishTemplate(
  options: Parameters<typeof clonePristineWorld>[0],
  templateWorld: Buffer,
): Promise<void> {
  const bootstrapWorld = await options.createBootstrapWorld();
  await ensureDirectory(options, parentPath(templateWorld));
  try {
    await cloneTree(options, bootstrapWorld, templateWorld);
  } catch (error) {
    if (error instanceof OwnedFilesError && error.category === 'conflict') {
      return;
    }
    throw mapCloneError(error, 'pristine world template');
  }
}

async function ensureDirectory(
  options: Pick<Parameters<typeof clonePristineWorld>[0], 'helperPath' | 'ownedRoot' | 'signal'>,
  relativePath: Buffer,
): Promise<void> {
  try {
    await createOwnedDirectory({
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      relativePath,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (error instanceof OwnedFilesError && error.category === 'conflict') return;
    throw mapCloneError(error, 'pristine world template directory');
  }
}

function parentPath(path: Buffer): Buffer {
  const separator = path.lastIndexOf(0x2f);
  if (separator <= 0) throw new RunnerError('runtime_failure', 'pristine world template', { kind: 'invalid_template_path' });
  return path.subarray(0, separator);
}

async function cloneTree(
  options: Pick<Parameters<typeof clonePristineWorld>[0], 'helperPath' | 'ownedRoot' | 'signal'>,
  sourceRelativePath: Buffer,
  destinationRelativePath: Buffer,
): Promise<void> {
  await cloneOwnedTree({
    helperPath: options.helperPath,
    ownedRoot: options.ownedRoot,
    sourceRelativePath,
    destinationRelativePath,
    maxFiles: MAX_OWNED_TREE_FILES,
    maxBytes: MAX_OWNED_TREE_BYTES,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

function isMissingTemplate(error: unknown): boolean {
  return error instanceof OwnedFilesError && error.category === 'not_found';
}

function mapCloneError(error: unknown, resource: string): RunnerError {
  if (!(error instanceof OwnedFilesError)) {
    return new RunnerError('runtime_failure', resource, { kind: 'clone_failed' });
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
