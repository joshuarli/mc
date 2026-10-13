export type StrictJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly StrictJsonValue[]
  | { readonly [key: string]: StrictJsonValue };

export type StrictJsonErrorCode =
  | "invalid_utf8"
  | "invalid_json"
  | "duplicate_key"
  | "maximum_depth"
  | "unsafe_number";

export class StrictJsonError extends Error {
  readonly code: StrictJsonErrorCode;
  readonly offset: number | null;

  constructor(code: StrictJsonErrorCode, offset: number | null, message: string, cause?: unknown) {
    if (cause === undefined) super(message);
    else super(message, { cause });
    this.name = "StrictJsonError";
    this.code = code;
    this.offset = offset;
  }
}
const MAX_NESTING = 32;
const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const NUMBER_PREFIX = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const numberTokens = new WeakMap<object, Map<string | number, string>>();

export function strictJsonNumberToken(owner: object, key: string | number): string | undefined {
  return numberTokens.get(owner)?.get(key);
}

export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function parseStrictJson(input: string | Uint8Array): StrictJsonValue {
  const source = typeof input === "string" ? input : decodeUtf8(input);
  const parser = new JsonParser(source);
  return parser.parse();
}

function decodeUtf8(input: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
  } catch (cause) {
    throw new StrictJsonError("invalid_utf8", null, "JSON input is not valid UTF-8", { cause });
  }
}

class JsonParser {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): StrictJsonValue {
    this.skipWhitespace();
    const value = this.readValue(0);
    this.skipWhitespace();
    if (this.offset !== this.source.length) {
      this.invalid("trailing data after JSON value");
    }
    return value;
  }

  private readValue(parentDepth: number): StrictJsonValue {
    this.skipWhitespace();
    const current = this.source[this.offset];
    switch (current) {
      case "{":
        if (parentDepth === MAX_NESTING) {
          throw new StrictJsonError("maximum_depth", this.offset, "JSON nesting exceeds 32 containers");
        }
        return this.readObject(parentDepth + 1);
      case "[":
        if (parentDepth === MAX_NESTING) {
          throw new StrictJsonError("maximum_depth", this.offset, "JSON nesting exceeds 32 containers");
        }
        return this.readArray(parentDepth + 1);
      case '"':
        return this.readString();
      case "t":
        return this.readLiteral("true", true);
      case "f":
        return this.readLiteral("false", false);
      case "n":
        return this.readLiteral("null", null);
      default:
        return this.readNumber();
    }
  }

  private readObject(depth: number): { readonly [key: string]: StrictJsonValue } {
    this.offset++;
    this.skipWhitespace();
    const result: { [key: string]: StrictJsonValue } = Object.create(null) as {
      [key: string]: StrictJsonValue;
    };
    const seen = new Set<string>();
    if (this.consume("}")) return result;

    while (true) {
      if (this.source[this.offset] !== '"') this.invalid("object key must be a string");
      const keyOffset = this.offset;
      const key = this.readString();
      if (seen.has(key)) {
        throw new StrictJsonError("duplicate_key", keyOffset, "JSON object contains a duplicate key");
      }
      seen.add(key);
      this.skipWhitespace();
      if (!this.consume(":")) this.invalid("object key must be followed by a colon");
      const value = this.readValue(depth);
      result[key] = value;
      if (typeof value === "number") this.recordNumberToken(result, key);
      this.skipWhitespace();
      if (this.consume("}")) return result;
      if (!this.consume(",")) this.invalid("object fields must be separated by commas");
      this.skipWhitespace();
    }
  }

  private readArray(depth: number): readonly StrictJsonValue[] {
    this.offset++;
    this.skipWhitespace();
    const result: StrictJsonValue[] = [];
    if (this.consume("]")) return result;

    while (true) {
      const value = this.readValue(depth);
      result.push(value);
      if (typeof value === "number") this.recordNumberToken(result, result.length - 1);
      this.skipWhitespace();
      if (this.consume("]")) return result;
      if (!this.consume(",")) this.invalid("array values must be separated by commas");
    }
  }

  private readString(): string {
    const start = this.offset;
    this.offset++;
    while (this.offset < this.source.length) {
      const code = this.source.charCodeAt(this.offset);
      if (code === 0x22) {
        this.offset++;
        try {
          const value = JSON.parse(this.source.slice(start, this.offset)) as string;
          if (!isWellFormedUnicode(value)) this.invalid("string contains an unpaired surrogate");
          return value;
        } catch {
          this.invalid("string contains an invalid escape");
        }
      }
      if (code < 0x20) this.invalid("string contains an unescaped control character");
      if (code === 0x5c) {
        this.offset++;
        const escaped = this.source[this.offset];
        if (escaped === "u") {
          for (let digit = 1; digit <= 4; digit++) {
            const hex = this.source[this.offset + digit];
            if (hex === undefined || !/[0-9A-Fa-f]/.test(hex)) this.invalid("string contains an invalid Unicode escape");
          }
          this.offset += 5;
          continue;
        }
        if (escaped === undefined || !'"\\/bfnrt'.includes(escaped)) {
          this.invalid("string contains an invalid escape");
        }
        this.offset++;
        continue;
      }
      this.offset++;
    }
    this.invalid("string is not terminated");
  }

  private readLiteral<T extends null | boolean>(literal: string, value: T): T {
    if (!this.source.startsWith(literal, this.offset)) this.invalid("invalid JSON value");
    this.offset += literal.length;
    return value;
  }

  private readNumber(): number {
    NUMBER_PREFIX.lastIndex = this.offset;
    const match = NUMBER_PREFIX.exec(this.source);
    if (!match) this.invalid("invalid JSON value");
    this.offset += match[0].length;
    const token = match[0];
    const exponentMatch = /[eE]([+-]?)(\d+)$/.exec(token);
    if (exponentMatch) {
      const exponentDigits = exponentMatch[2]!;
      const exponent = exponentDigits.length > 5 ? Infinity : Number(exponentDigits) * (exponentMatch[1] === "-" ? -1 : 1);
      if (!Number.isFinite(exponent) || Math.abs(exponent) > 10_000) {
        throw new StrictJsonError("invalid_json", this.offset - token.length, "JSON number exponent exceeds the supported range");
      }
    }
    const value = Number(token);
    if (!Number.isFinite(value)) {
      throw new StrictJsonError("invalid_json", this.offset - token.length, "JSON number is not finite");
    }
    if (value === 0 && /[1-9]/.test(token.split(/[eE]/, 1)[0]!)) {
      throw new StrictJsonError("invalid_json", this.offset - token.length, "JSON number underflows to zero");
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new StrictJsonError("unsafe_number", this.offset - token.length, "JSON integer exceeds the safe number range");
    }
    this.lastNumberToken = token;
    return value;
  }

  private lastNumberToken: string | null = null;

  private recordNumberToken(owner: object, key: string | number): void {
    const token = this.lastNumberToken;
    if (token === null) throw new Error("missing JSON number token");
    let tokens = numberTokens.get(owner);
    if (!tokens) {
      tokens = new Map();
      numberTokens.set(owner, tokens);
    }
    tokens.set(key, token);
  }

  private skipWhitespace(): void {
    while (this.offset < this.source.length && JSON_WHITESPACE.has(this.source[this.offset]!)) this.offset++;
  }

  private consume(expected: string): boolean {
    if (this.source[this.offset] !== expected) return false;
    this.offset++;
    return true;
  }

  private invalid(message: string): never {
    throw new StrictJsonError("invalid_json", this.offset, message);
  }
}
