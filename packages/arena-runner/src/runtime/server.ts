import { readOwnedFile, stageOwnedFile, createOwnedDirectory, OwnedFilesError, MAX_OWNED_READ_BYTES } from '../owned-files/index.js';
import type { PreparedRun } from '../prepare.js';
import type { ScenarioIr } from '@arena/spec';
import { RunnerError } from '../errors.js';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_PLUGIN_JAR_BYTES = MAX_OWNED_READ_BYTES;
const EULA_PATH = Buffer.from('/eula.txt', 'ascii');
const SERVER_PROPERTIES_PATH = Buffer.from('/server.properties', 'ascii');
const BUKKIT_PROPERTIES_PATH = Buffer.from('/bukkit.yml', 'ascii');
const PLUGIN_PATH = Buffer.from('/plugins/arena-plugin.jar', 'ascii');

export interface RuntimeServerInputs {
  readonly preparedRun: PreparedRun;
  readonly helperPath: string;
  readonly ownedRoot: Buffer;
  readonly javaExecutable: string;
  readonly paperJarPath: string;
  readonly pluginJarPath: string;
  readonly javaTmpDir: string;
  readonly resumeCheckpointPath?: string;
  readonly signal?: AbortSignal;
}

export async function readRuntimePluginJar(options: RuntimeServerInputs): Promise<Buffer> {
  const relativePath = repositoryRelativePath(options.ownedRoot, options.pluginJarPath);
  try {
    return await readOwnedFile({
      helperPath: options.helperPath,
      ownedRoot: options.ownedRoot,
      relativePath,
      maxBytes: MAX_PLUGIN_JAR_BYTES,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    throw mapOwnedFileError(error, 'Paper plugin JAR');
  }
}

export async function stageServerDirectory(options: Readonly<{
  inputs: RuntimeServerInputs;
  scenario: ScenarioIr;
  relativePath: Buffer;
  pluginBytes: Buffer;
  signal?: AbortSignal;
}>): Promise<void> {
  const { inputs, scenario, relativePath, pluginBytes, signal } = options;
  const serverPath = Buffer.from(relativePath);
  const pluginsPath = Buffer.concat([serverPath, Buffer.from('/plugins', 'ascii')]);
  try {
    await createOwnedDirectory({
      helperPath: inputs.helperPath,
      ownedRoot: inputs.ownedRoot,
      relativePath: pluginsPath,
      ...(signal === undefined ? {} : { signal }),
    });
    await stageOwnedFile({
      helperPath: inputs.helperPath,
      ownedRoot: inputs.ownedRoot,
      relativePath: Buffer.concat([serverPath, EULA_PATH]),
      contents: Buffer.from('eula=true\n', 'ascii'),
      maxBytes: 64,
      ...(signal === undefined ? {} : { signal }),
    });
    await stageOwnedFile({
      helperPath: inputs.helperPath,
      ownedRoot: inputs.ownedRoot,
      relativePath: Buffer.concat([serverPath, SERVER_PROPERTIES_PATH]),
      contents: serverProperties(scenario),
      maxBytes: 16 * 1024,
      ...(signal === undefined ? {} : { signal }),
    });
    if (scenario.map.terrain === 'planned') {
      await stageOwnedFile({
        helperPath: inputs.helperPath,
        ownedRoot: inputs.ownedRoot,
        relativePath: Buffer.concat([serverPath, BUKKIT_PROPERTIES_PATH]),
        contents: Buffer.from('worlds:\n  world:\n    generator: ArenaFoundation:plan\n', 'ascii'),
        maxBytes: 1024,
        ...(signal === undefined ? {} : { signal }),
      });
    }
    await stageOwnedFile({
      helperPath: inputs.helperPath,
      ownedRoot: inputs.ownedRoot,
      relativePath: Buffer.concat([serverPath, PLUGIN_PATH]),
      contents: pluginBytes,
      maxBytes: MAX_PLUGIN_JAR_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throw mapOwnedFileError(error, 'Paper server files');
  }
}

export function serverWorkingDirectory(ownedRoot: Buffer, relativePath: Buffer): string {
  return resolve(ownedRoot.toString('utf8'), relativePath.toString('utf8'));
}

export function generationPlanAbsolutePath(ownedRoot: Buffer, preparedRun: PreparedRun): string {
  return resolve(ownedRoot.toString('utf8'), preparedRun.worldPlanPath.toString('utf8'));
}

export function paperArguments(
  options: RuntimeServerInputs,
  controlPort: number,
  runId: string,
): readonly string[] {
  return Object.freeze([
    '-Xms512m',
    '-Xmx2g',
    `-Djava.io.tmpdir=${options.javaTmpDir}`,
    '-Dterminal.jline=false',
    '-Dterminal.ansi=false',
    `-Darena.control-port=${controlPort}`,
    `-Darena.run-id=${runId}`,
    `-Darena.generation-plan=${generationPlanAbsolutePath(options.ownedRoot, options.preparedRun)}`,
    ...(options.resumeCheckpointPath === undefined ? [] : [`-Darena.resume-checkpoint=${options.resumeCheckpointPath}`]),
    '-jar',
    options.paperJarPath,
    '--nogui',
  ]);
}

export function validateJavaTempDirectory(ownedRoot: Buffer): string {
  const configured = process.env.ARENA_JAVA_TMPDIR;
  if (configured === undefined || configured.length === 0) {
    throw new RunnerError('missing_prerequisite', 'Java temporary directory', { kind: 'java_temp_not_configured' });
  }
  const expected = resolve(ownedRoot.toString('utf8'), '.work', 'tmp');
  const actual = resolve(configured);
  if (actual !== expected) {
    throw new RunnerError('invalid_input', 'Java temporary directory', { kind: 'java_temp_outside_repository_work' });
  }
  return actual;
}

function serverProperties(scenario: ScenarioIr): Buffer {
  const spectatorCapacity = scenario.roster.spectatorCapacity;
  const maxPlayers = BigInt(scenario.roster.competitors) + spectatorCapacity;
  if (maxPlayers > 2_147_483_647n) {
    throw new RunnerError('invalid_input', 'scenario roster', { kind: 'server_capacity_exceeded' });
  }
  const contents = [
    'server-ip=127.0.0.1',
    'server-port=25565',
    'online-mode=false',
    'enforce-secure-profile=false',
    'white-list=false',
    'pvp=true',
    'gamemode=survival',
    'difficulty=easy',
    'spawn-protection=0',
    'spawn-radius=0',
    `max-players=${maxPlayers}`,
    `view-distance=${scenario.server.viewDistanceChunks}`,
    `simulation-distance=${scenario.server.simulationDistanceChunks}`,
    ...(scenario.map.terrain === 'vanilla'
      ? [`level-seed=${BigInt.asIntN(64, scenario.seed).toString(10)}`]
      : []),
    'level-name=world',
    'level-type=minecraft:normal',
    'generate-structures=false',
    'spawn-monsters=false',
    'spawn-animals=false',
    'enable-query=false',
    'enable-rcon=false',
    'motd=Arena headless match',
    '',
  ].join('\n');
  return Buffer.from(contents, 'ascii');
}

function repositoryRelativePath(ownedRoot: Buffer, absolutePath: string): Buffer {
  if (!isAbsolute(absolutePath)) {
    throw new RunnerError('invalid_input', 'Paper plugin JAR', { kind: 'artifact_path_not_absolute' });
  }
  const rootPath = resolve(ownedRoot.toString('utf8'));
  const normalizedPath = resolve(absolutePath);
  const relativePath = relative(rootPath, normalizedPath);
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new RunnerError('invalid_input', 'Paper plugin JAR', { kind: 'artifact_path_outside_repository' });
  }
  return Buffer.from(relativePath.split(sep).join('/'), 'utf8');
}

function mapOwnedFileError(error: unknown, resource: string): RunnerError {
  if (!(error instanceof OwnedFilesError)) {
    return new RunnerError('runtime_failure', resource, { kind: 'owned_file_operation' });
  }
  const category = error.category === 'not_found' || error.category === 'helper_start'
    ? 'missing_prerequisite'
    : error.category === 'too_large' || error.category === 'invalid_path'
      ? 'invalid_input'
      : 'runtime_failure';
  return new RunnerError(category, resource, {
    kind: error.category,
    ...(error.errno === undefined ? {} : { os_code: error.errno }),
  });
}
