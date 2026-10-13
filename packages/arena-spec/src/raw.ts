import { ParseError, parseTOML } from "toml-eslint-parser";
import type { AST } from "toml-eslint-parser";
import { Buffer } from "node:buffer";

import { SpecError, SpecErrorKind } from "./errors.js";

/** Maximum UTF-8 source size accepted for a single map or scenario. */
export const MAX_SOURCE_BYTES = 16 * 1024 * 1024;

export type RawValue =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "integer"; readonly value: bigint }
  | { readonly kind: "float"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "array"; readonly value: readonly RawValue[] }
  | { readonly kind: "table"; readonly value: RawTable }
  | { readonly kind: "other" };

export interface RawEntry {
  readonly value: RawValue;
  readonly sourceLocation: { readonly line: number; readonly column: number };
}

export type RawTable = ReadonlyMap<string, RawEntry>;

const EMPTY_LOCATION = Object.freeze({ line: 1, column: 1 });
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

export function parseDocument(source: string, document: string): RawValue {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    throw new SpecError(
      SpecErrorKind.ResourceLimit,
      `${document}.source`,
      `source exceeds the ${MAX_SOURCE_BYTES / (1024 * 1024)} MiB UTF-8 byte limit`,
    );
  }

  let ast: AST.TOMLProgram;
  try {
    ast = parseTOML(source, { tomlVersion: "1.0" });
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    throw new SpecError(
      SpecErrorKind.Syntax,
      document,
      error.message,
      sourceLocation(source, error.index),
      error,
    );
  }

  const root = new Map<string, RawEntry>();
  for (const node of ast.body[0].body) {
    if (node.type === "TOMLKeyValue") {
      insertPath(root, keyParts(node.key), convertValue(node.value, source, document), sourceLocation(source, node.key.range[0]), document);
    } else {
      addTable(root, node, source, document);
    }
  }
  return { kind: "table", value: root };
}

function addTable(
  root: Map<string, RawEntry>,
  node: AST.TOMLTable,
  source: string,
  document: string,
): void {
  const path = node.resolvedKey;
  const location = sourceLocation(source, node.key.range[0]);
  if (node.kind === "array") {
    appendArrayTable(root, path, tableBody(node.body, source, document), location, document);
    return;
  }
  const target = tableAtPath(root, path, location, document);
  for (const pair of node.body) {
    insertPath(
      target,
      keyParts(pair.key),
      convertValue(pair.value, source, document),
      sourceLocation(source, pair.key.range[0]),
      document,
    );
  }
}

function tableBody(
  body: readonly AST.TOMLKeyValue[],
  source: string,
  document: string,
): Map<string, RawEntry> {
  const table = new Map<string, RawEntry>();
  for (const pair of body) {
    insertPath(
      table,
      keyParts(pair.key),
      convertValue(pair.value, source, document),
      sourceLocation(source, pair.key.range[0]),
      document,
    );
  }
  return table;
}

function convertValue(
  node: AST.TOMLValue | AST.TOMLArray | AST.TOMLInlineTable,
  source: string,
  document: string,
): RawValue {
  switch (node.type) {
    case "TOMLValue":
      switch (node.kind) {
        case "string":
          return { kind: "string", value: node.value };
        case "integer": {
          if (node.bigint < I64_MIN || node.bigint > I64_MAX) {
            throw new SpecError(
              SpecErrorKind.Syntax,
              document,
              "integer is outside the TOML 1.0 signed 64-bit range",
              sourceLocation(source, node.range[0]),
            );
          }
          return { kind: "integer", value: node.bigint };
        }
        case "float":
          return { kind: "float", value: node.value };
        case "boolean":
          return { kind: "boolean", value: node.value };
        default:
          return { kind: "other" };
      }
    case "TOMLArray":
      return {
        kind: "array",
        value: node.elements.map((element) => convertValue(element, source, document)),
      };
    case "TOMLInlineTable":
      return {
        kind: "table",
        value: tableBody(node.body, source, document),
      };
  }
}

function appendArrayTable(
  root: Map<string, RawEntry>,
  path: readonly (string | number)[],
  table: RawTable,
  location: { readonly line: number; readonly column: number },
  document: string,
): void {
  const arrayIndex = path[path.length - 1];
  const key = path[path.length - 2];
  if (typeof arrayIndex !== "number" || typeof key !== "string") {
    throw new SpecError(SpecErrorKind.Syntax, document, "array table has an empty key", location);
  }
  const parent = tableAtPath(root, path.slice(0, -2), location, document);
  const current = parent.get(key);
  if (current === undefined) {
    if (arrayIndex !== 0) {
      throw new SpecError(SpecErrorKind.Syntax, document, `array table ${key} has a missing entry`, location);
    }
    parent.set(key, { value: { kind: "array", value: [{ kind: "table", value: table }] }, sourceLocation: location });
    return;
  }
  if (current.value.kind !== "array" || current.value.value.some((value) => value.kind !== "table")) {
    throw new SpecError(SpecErrorKind.Syntax, document, `array table conflicts with key ${key}`, location);
  }
  if (arrayIndex !== current.value.value.length) {
    throw new SpecError(SpecErrorKind.Syntax, document, `array table ${key} has a conflicting entry index`, location);
  }
  parent.set(key, {
    value: { kind: "array", value: [...current.value.value, { kind: "table", value: table }] },
    sourceLocation: current.sourceLocation,
  });
}

function tableAtPath(
  root: Map<string, RawEntry>,
  path: readonly (string | number)[],
  location: { readonly line: number; readonly column: number },
  document: string,
): Map<string, RawEntry> {
  let current: RawValue = { kind: "table", value: root };
  for (const segment of path) {
    if (typeof segment === "number") {
      if (current.kind !== "array") {
        throw new SpecError(SpecErrorKind.Syntax, document, "array table index conflicts with a non-array value", location);
      }
      const entry = current.value[segment];
      if (entry === undefined || entry.kind !== "table") {
        throw new SpecError(SpecErrorKind.Syntax, document, "array table index does not identify a table", location);
      }
      current = entry;
      continue;
    }
    if (current.kind !== "table") {
      throw new SpecError(SpecErrorKind.Syntax, document, `table conflicts with key ${segment}`, location);
    }
    const currentTable = current.value as Map<string, RawEntry>;
    const entry = currentTable.get(segment);
    if (entry === undefined) {
      const nested = new Map<string, RawEntry>();
      currentTable.set(segment, { value: { kind: "table", value: nested }, sourceLocation: location });
      current = { kind: "table", value: nested };
      continue;
    }
    current = entry.value;
  }
  if (current.kind !== "table") {
    throw new SpecError(SpecErrorKind.Syntax, document, "table path does not identify a table", location);
  }
  return current.value as Map<string, RawEntry>;
}

function insertPath(
  root: Map<string, RawEntry>,
  path: readonly string[],
  value: RawValue,
  location: { readonly line: number; readonly column: number },
  document: string,
): void {
  const parent = tableAtPath(root, path.slice(0, -1), location, document);
  const key = path[path.length - 1];
  if (key === undefined) {
    throw new SpecError(SpecErrorKind.Syntax, document, "key is empty", location);
  }
  if (parent.has(key)) {
    throw new SpecError(SpecErrorKind.Syntax, document, `key ${key} is defined more than once`, location);
  }
  parent.set(key, { value, sourceLocation: location });
}

function keyParts(key: AST.TOMLKey): string[] {
  return key.keys.map((part) => part.type === "TOMLBare" ? part.name : part.value);
}

function sourceLocation(source: string, offset: number): { readonly line: number; readonly column: number } {
  const prefix = source.slice(0, offset);
  const line = prefix.split("\n").length;
  const column = Array.from(prefix.slice(prefix.lastIndexOf("\n") + 1)).length + 1;
  return Object.freeze({ line, column });
}

function typeError(path: string, expected: string): SpecError {
  return new SpecError(SpecErrorKind.InvalidValue, path, `must be a ${expected}`);
}

export function asTable(value: RawValue, path: string): RawTable {
  if (value.kind === "table") return value.value;
  throw typeError(path, "table");
}

export function asArray(value: RawValue, path: string): readonly RawValue[] {
  if (value.kind === "array") return value.value;
  throw typeError(path, "array");
}

export function field(table: RawTable, key: string, path: string): RawValue {
  const entry = table.get(key);
  if (entry !== undefined) return entry.value;
  throw new SpecError(SpecErrorKind.MissingField, `${path}.${key}`, "required field is missing");
}

export function checkFields(
  table: RawTable,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): void {
  const allowedFields = new Set(allowed);
  const unknown = [...table.entries()]
    .filter(([key]) => !allowedFields.has(key))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)[0];
  if (unknown !== undefined) {
    const [key, entry] = unknown;
    throw new SpecError(
      SpecErrorKind.UnknownField,
      `${path}.${key}`,
      "unknown field",
      entry.sourceLocation ?? EMPTY_LOCATION,
    );
  }
  for (const key of required) {
    if (!table.has(key)) {
      throw new SpecError(SpecErrorKind.MissingField, `${path}.${key}`, "required field is missing");
    }
  }
}

export function string(value: RawValue, path: string): string {
  if (value.kind !== "string") throw typeError(path, "string");
  if (value.value.length === 0) {
    throw new SpecError(SpecErrorKind.InvalidValue, path, "must not be empty");
  }
  return value.value;
}

export function integer(value: RawValue, path: string): bigint {
  if (value.kind === "integer") return value.value;
  throw typeError(path, "integer");
}

export function number(value: RawValue, path: string): number {
  let result: number;
  if (value.kind === "integer") result = Number(value.value);
  else if (value.kind === "float") result = value.value;
  else throw typeError(path, "number");
  if (!Number.isFinite(result)) {
    throw new SpecError(SpecErrorKind.Range, path, "must be finite");
  }
  return result;
}

export function boolean(value: RawValue, path: string): boolean {
  if (value.kind === "boolean") return value.value;
  throw typeError(path, "boolean");
}
