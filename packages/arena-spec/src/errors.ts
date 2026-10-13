export const SpecErrorKind = {
  Syntax: "syntax",
  UnknownField: "unknown_field",
  MissingField: "missing_field",
  InvalidValue: "invalid_value",
  Range: "range",
  Conflict: "conflict",
  Geometry: "geometry",
  ResourceLimit: "resource_limit",
} as const;

export type SpecErrorKind = (typeof SpecErrorKind)[keyof typeof SpecErrorKind];

/** A one-based TOML source position. */
export interface SourceLocation {
  readonly line: number;
  readonly column: number;
}

/** A source-aware failure raised while validating a scenario or map. */
export class SpecError extends Error {
  readonly kind: SpecErrorKind;
  readonly path: string;
  readonly sourceLocation: SourceLocation | undefined;

  constructor(
    kind: SpecErrorKind,
    path: string,
    message: string,
    sourceLocation?: SourceLocation,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "SpecError";
    this.kind = kind;
    this.path = path;
    this.sourceLocation = sourceLocation;
  }

  override toString(): string {
    const detail = `${this.path}: ${this.message}`;
    if (this.sourceLocation === undefined) return detail;
    return `${this.sourceLocation.line}:${this.sourceLocation.column}: ${detail}`;
  }
}
