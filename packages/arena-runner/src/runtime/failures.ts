import { boundedErrorReason, RunnerError } from '../errors.js';
import { OwnedFilesError } from '../owned-files/index.js';
import type { OperationalFailureCleanupV1 } from './failure-artifact.js';
import { ControlSessionError } from './session.js';

export function ownedFilesFailure(error: unknown, resource: string): RunnerError {
  if (!(error instanceof OwnedFilesError)) {
    return new RunnerError('runtime_failure', resource, { kind: 'owned_file_operation' }, { cause: error });
  }
  if (error.category === 'conflict' && error.operation === 'hold-run-lease') {
    return new RunnerError('owner_conflict', 'run lease', { kind: 'owner_conflict' }, { cause: error });
  }
  if (error.category === 'cancelled') {
    return new RunnerError('cancelled', resource, { kind: 'cancelled' }, { cause: error });
  }
  const category = error.category === 'not_found' || error.category === 'helper_start'
    ? 'missing_prerequisite'
    : error.category === 'invalid_path' || error.category === 'too_large'
      ? 'invalid_input'
      : 'runtime_failure';
  return new RunnerError(category, resource, {
    kind: error.category,
    ...(error.errno === undefined ? {} : { os_code: error.errno }),
  }, { cause: error });
}

export function mapRuntimeFailure(error: unknown): RunnerError {
  if (error instanceof RunnerError) {
    return error.source.kind === 'cancelled' && error.category === 'runtime_failure'
      ? new RunnerError('cancelled', error.resource, error.source, { cause: error })
      : error;
  }
  if (error instanceof ControlSessionError) return controlFailure(error);
  if (error instanceof OwnedFilesError) return ownedFilesFailure(error, 'owned run');
  const reason = boundedErrorReason(error);
  return new RunnerError('runtime_failure', 'arena run', {
    kind: errorKind(error),
    ...(reason === undefined ? {} : { reason }),
  }, { cause: error });
}

export function cleanupErrorUnlessPrimary(error: unknown, primaryFailure: unknown): unknown | undefined {
  if (error === undefined) return undefined;
  if (primaryFailure !== undefined && isSameFailure(error, primaryFailure)) return undefined;
  return error;
}

export function failureCleanup(error: unknown, primaryFailure: unknown): OperationalFailureCleanupV1 {
  const cleanupError = cleanupErrorUnlessPrimary(error, primaryFailure);
  if (cleanupError === undefined) return Object.freeze({ status: 'succeeded', source: null });
  return Object.freeze({ status: 'failed', source: mapRuntimeFailure(cleanupError).source });
}

export function withCleanupFailure(primaryFailure: unknown, cleanupFailure: unknown): RunnerError {
  const primary = mapRuntimeFailure(primaryFailure);
  const cleanupOsCode = systemErrorCode(cleanupFailure);
  return new RunnerError('runtime_failure', primary.resource, {
    ...primary.source,
    cleanup_kind: errorKind(cleanupFailure),
    ...(cleanupOsCode === undefined ? {} : { cleanup_os_code: cleanupOsCode }),
  }, { cause: primary });
}

export function cancelledFailure(): RunnerError {
  return new RunnerError('cancelled', 'arena run', { kind: 'cancelled' });
}

function isSameFailure(left: unknown, right: unknown): boolean {
  return causeChainContains(left, right) || causeChainContains(right, left);
}

function causeChainContains(origin: unknown, target: unknown): boolean {
  const seen = new Set<object>();
  let current = origin;
  while (current !== null && (typeof current === 'object' || typeof current === 'function')) {
    if (current === target) return true;
    const object = current as object;
    if (seen.has(object)) return false;
    seen.add(object);
    current = current instanceof Error ? current.cause : undefined;
  }
  return current === target;
}

function controlFailure(error: ControlSessionError): RunnerError {
  if (error.code === 'cancelled') {
    return new RunnerError('cancelled', 'arena run', { kind: 'cancelled' }, { cause: error });
  }
  const osCode = systemErrorCode(error.cause);
  if (error.code === 'listener_failed' && systemErrorName(error.cause) === 'EADDRINUSE') {
    return new RunnerError('owner_conflict', 'control port', {
      kind: 'port_in_use',
      ...(osCode === undefined ? {} : { os_code: osCode }),
    }, { cause: error });
  }
  return new RunnerError('runtime_failure', 'control session', { kind: error.code }, { cause: error });
}

function errorKind(error: unknown): string {
  if (error instanceof RunnerError) return error.source.kind;
  return error instanceof Error ? error.name : 'unknown_error';
}

function systemErrorCode(error: unknown): number | undefined {
  return error instanceof Error && 'errno' in error && typeof error.errno === 'number'
    ? error.errno
    : undefined;
}

function systemErrorName(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}
