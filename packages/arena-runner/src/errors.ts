import { canonicalJson } from './canonical.js';

export type ErrorCategory =
  | 'invalid_input'
  | 'missing_prerequisite'
  | 'owner_conflict'
  | 'corrupt_evidence'
  | 'runtime_failure'
  | 'cancelled';

export interface ErrorSource {
  readonly kind: string;
  readonly argument?: number;
  readonly field?: string;
  readonly record?: number;
  readonly line?: number;
  readonly column?: number;
  readonly os_code?: number;
  readonly cleanup_os_code?: number;
  readonly cleanup_kind?: string;
  readonly published?: boolean;
  readonly reason?: string;
  readonly run_id?: string;
  readonly relative_artifact?: string;
}

export class RunnerError extends Error {
  constructor(
    readonly category: ErrorCategory,
    readonly resource: string,
    readonly source: ErrorSource,
  ) {
    super(source.kind);
  }

  exitCode(): 2 | 3 | 4 | 5 | 6 | 130 {
    switch (this.category) {
      case 'invalid_input': return 2;
      case 'missing_prerequisite': return 3;
      case 'owner_conflict': return 4;
      case 'corrupt_evidence': return 5;
      case 'runtime_failure': return 6;
      case 'cancelled': return 130;
    }
  }

  toJson(): string {
    return canonicalJson({
      error: {
        category: this.category,
        resource: this.resource,
        source: this.source,
      },
    });
  }
}
