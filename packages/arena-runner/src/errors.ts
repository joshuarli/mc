import { canonicalJson } from './canonical.js';

export type ErrorCategory = 'invalid_input' | 'missing_prerequisite' | 'corrupt_evidence' | 'runtime_failure';

export interface ErrorSource {
  readonly kind: string;
  readonly argument?: number;
  readonly line?: number;
  readonly column?: number;
  readonly os_code?: number;
}

export class RunnerError extends Error {
  constructor(
    readonly category: ErrorCategory,
    readonly resource: string,
    readonly source: ErrorSource,
  ) {
    super(source.kind);
  }

  exitCode(): 2 | 3 | 5 | 6 {
    switch (this.category) {
      case 'invalid_input': return 2;
      case 'missing_prerequisite': return 3;
      case 'corrupt_evidence': return 5;
      case 'runtime_failure': return 6;
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
