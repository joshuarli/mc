import { RunnerError } from '../errors.js';

export type TomlValue = string | number | boolean | readonly TomlValue[] | TomlTable;
export interface TomlTable { readonly [key: string]: TomlValue }

const MAX_BYTES = 256 * 1024;
const KEY = /^[A-Za-z0-9_-]+$/;

export function parseTomlSubset(source: string, resource: string): TomlTable {
  if (Buffer.byteLength(source, 'utf8') > MAX_BYTES) throw fail(resource, 'source_too_large', 1);
  const root: Record<string, TomlValue> = {};
  let current: Record<string, TomlValue> = root;
  const lines = source.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = stripComment(rawLine, resource, lineNumber).trim();
    if (line.length === 0) continue;
    if (line.startsWith('[[')) {
      if (!line.endsWith(']]')) throw fail(resource, 'invalid_table_header', lineNumber);
      const name = line.slice(2, -2).trim();
      if (!KEY.test(name)) throw fail(resource, 'invalid_table_name', lineNumber);
      const existing = root[name];
      if (existing !== undefined && !Array.isArray(existing)) throw fail(resource, 'duplicate_key', lineNumber);
      const list = (existing as TomlValue[] | undefined) ?? [];
      const table: Record<string, TomlValue> = {};
      list.push(table);
      root[name] = list;
      current = table;
      continue;
    }
    if (line.startsWith('[')) {
      if (!line.endsWith(']')) throw fail(resource, 'invalid_table_header', lineNumber);
      const name = line.slice(1, -1).trim();
      if (!KEY.test(name) || Object.hasOwn(root, name)) throw fail(resource, 'invalid_table_name', lineNumber);
      const table: Record<string, TomlValue> = {};
      root[name] = table;
      current = table;
      continue;
    }
    const equals = line.indexOf('=');
    if (equals < 0) throw fail(resource, 'expected_key_value', lineNumber);
    const key = line.slice(0, equals).trim();
    if (!KEY.test(key)) throw fail(resource, 'invalid_key', lineNumber);
    if (Object.hasOwn(current, key)) throw fail(resource, 'duplicate_key', lineNumber);
    const cursor = { text: line.slice(equals + 1).trim(), position: 0 };
    current[key] = readValue(cursor, resource, lineNumber, 0);
    skipSpaces(cursor);
    if (cursor.position !== cursor.text.length) throw fail(resource, 'trailing_characters', lineNumber);
  }
  return root;
}

interface Cursor { readonly text: string; position: number }

function readValue(cursor: Cursor, resource: string, line: number, depth: number): TomlValue {
  if (depth > 4) throw fail(resource, 'nesting_limit_exceeded', line);
  skipSpaces(cursor);
  const text = cursor.text;
  const char = text[cursor.position];
  if (char === '"') return readString(cursor, resource, line);
  if (char === '[') {
    cursor.position += 1;
    const values: TomlValue[] = [];
    for (;;) {
      skipSpaces(cursor);
      if (text[cursor.position] === ']') { cursor.position += 1; return values; }
      values.push(readValue(cursor, resource, line, depth + 1));
      skipSpaces(cursor);
      if (text[cursor.position] === ',') { cursor.position += 1; continue; }
      if (text[cursor.position] !== ']') throw fail(resource, 'invalid_array', line);
    }
  }
  if (char === '{') {
    cursor.position += 1;
    const table: Record<string, TomlValue> = {};
    for (;;) {
      skipSpaces(cursor);
      if (text[cursor.position] === '}') { cursor.position += 1; return table; }
      const match = /^[A-Za-z0-9_-]+/.exec(text.slice(cursor.position));
      if (match === null) throw fail(resource, 'invalid_inline_table', line);
      const key = match[0];
      cursor.position += key.length;
      skipSpaces(cursor);
      if (text[cursor.position] !== '=') throw fail(resource, 'invalid_inline_table', line);
      cursor.position += 1;
      if (Object.hasOwn(table, key)) throw fail(resource, 'duplicate_key', line);
      table[key] = readValue(cursor, resource, line, depth + 1);
      skipSpaces(cursor);
      if (text[cursor.position] === ',') { cursor.position += 1; continue; }
      if (text[cursor.position] !== '}') throw fail(resource, 'invalid_inline_table', line);
    }
  }
  const rest = text.slice(cursor.position);
  const word = /^[^\s,\]}]+/.exec(rest)?.[0];
  if (word === undefined) throw fail(resource, 'missing_value', line);
  cursor.position += word.length;
  if (word === 'true') return true;
  if (word === 'false') return false;
  if (/^-?(0|[1-9][0-9]*)$/.test(word)) {
    const value = Number(word);
    if (!Number.isSafeInteger(value)) throw fail(resource, 'integer_out_of_range', line);
    return value;
  }
  if (/^-?(0|[1-9][0-9]*)\.[0-9]+$/.test(word)) return Number(word);
  throw fail(resource, 'invalid_value', line);
}

function readString(cursor: Cursor, resource: string, line: number): string {
  const text = cursor.text;
  let value = '';
  cursor.position += 1;
  for (;;) {
    const char = text[cursor.position];
    if (char === undefined) throw fail(resource, 'unterminated_string', line);
    cursor.position += 1;
    if (char === '"') return value;
    if (char === '\\') {
      const next = text[cursor.position];
      cursor.position += 1;
      if (next === '"' || next === '\\') value += next;
      else throw fail(resource, 'unsupported_escape', line);
    } else {
      value += char;
    }
  }
}

function skipSpaces(cursor: Cursor): void {
  while (cursor.position < cursor.text.length && (cursor.text[cursor.position] === ' ' || cursor.text[cursor.position] === '\t')) {
    cursor.position += 1;
  }
}

function stripComment(line: string, resource: string, lineNumber: number): string {
  let inString = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '\\' && inString) { index += 1; continue; }
    if (char === '"') inString = !inString;
    else if (char === '#' && !inString) return line.slice(0, index);
  }
  if (inString) throw fail(resource, 'unterminated_string', lineNumber);
  return line;
}

function fail(resource: string, kind: string, line: number): RunnerError {
  return new RunnerError('invalid_input', resource, { kind, line });
}
