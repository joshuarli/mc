const rawArgvEnvironmentKey = 'ARENA_RAW_ARGV_V1';
const maxRawArgvCount = 4096;
const maxRawArgvBytes = 48 * 1024;
const maxRawArgvChannelBytes = 64 * 1024;

export type RawArgv = readonly Buffer[];

export class RawArgvError extends Error {
  readonly argumentIndex?: number;

  constructor(message: string, argumentIndex?: number) {
    super(message);
    this.name = 'RawArgvError';
    this.argumentIndex = argumentIndex;
  }
}

function decodeBase64(value: string, context: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new RawArgvError(`${context} has invalid base64`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new RawArgvError(`${context} has non-canonical base64`);
  }
  return decoded;
}

function readDecimal(value: string, context: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new RawArgvError(`${context} is not a canonical decimal`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RawArgvError(`${context} exceeds the supported range`);
  }
  return parsed;
}

export function decodeRawArgvChannel(channel: string, processArguments: readonly string[]): RawArgv {
  if (Buffer.byteLength(channel, 'ascii') > maxRawArgvChannelBytes || /[^\x00-\x7f]/.test(channel)) {
    throw new RawArgvError('raw argument channel exceeds its ASCII size limit');
  }
  const match = /^v1;([0-9]+);/.exec(channel);
  if (match === null) throw new RawArgvError('raw argument channel has an unsupported version');
  const count = readDecimal(match[1]!, 'raw argument count');
  if (count > maxRawArgvCount) throw new RawArgvError('raw argument count exceeds its limit');
  if (processArguments.length !== count) {
    throw new RawArgvError('raw argument count does not match Node argv');
  }

  let offset = match[0].length;
  let totalBytes = 0;
  const arguments_: Buffer[] = [];
  for (let index = 0; index < count; index++) {
    const separator = channel.indexOf(':', offset);
    if (separator < 0) throw new RawArgvError('raw argument length is missing', index);
    const byteLength = readDecimal(channel.slice(offset, separator), `raw argument ${index} length`);
    if (byteLength > maxRawArgvBytes - totalBytes) {
      throw new RawArgvError('raw argument bytes exceed their limit', index);
    }
    const encodedEnd = channel.indexOf(';', separator + 1);
    if (encodedEnd < 0) throw new RawArgvError('raw argument terminator is missing', index);
    const argument = decodeBase64(channel.slice(separator + 1, encodedEnd), `raw argument ${index}`);
    if (argument.length !== byteLength || argument.includes(0)) {
      throw new RawArgvError('raw argument byte length is invalid', index);
    }
    if (argument.toString('utf8') !== processArguments[index]) {
      throw new RawArgvError('raw argument does not match Node argv', index);
    }
    totalBytes += argument.length;
    arguments_.push(argument);
    offset = encodedEnd + 1;
  }
  if (offset !== channel.length) throw new RawArgvError('raw argument channel has trailing data');
  return arguments_;
}

let hasCapturedRawArgv = false;
let capturedRawArgv: RawArgv | undefined;
let hasCapturedRawArgvError = false;
let capturedRawArgvError: unknown;

export function consumeRawArgv(): RawArgv | undefined {
  if (!hasCapturedRawArgv) {
    hasCapturedRawArgv = true;
    const channel = process.env[rawArgvEnvironmentKey];
    delete process.env[rawArgvEnvironmentKey];
    if (channel !== undefined) {
      try {
        capturedRawArgv = decodeRawArgvChannel(channel, process.argv.slice(2));
      } catch (error) {
        hasCapturedRawArgvError = true;
        capturedRawArgvError = error;
      }
    }
  }
  if (hasCapturedRawArgvError) throw capturedRawArgvError;
  return capturedRawArgv?.map((argument) => Buffer.from(argument));
}

export function rawArgumentText(argument: Buffer, index: number): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(argument);
  } catch {
    throw new RawArgvError(`argument ${index} is not valid UTF-8`, index);
  }
}

export function encodeStringArguments(arguments_: readonly string[]): RawArgv {
  return arguments_.map((argument, index) => {
    const bytes = Buffer.from(argument, 'utf8');
    if (argument.includes('\0') || bytes.toString('utf8') !== argument) {
      throw new RawArgvError(`argument ${index} cannot be represented as a POSIX argument`, index);
    }
    return bytes;
  });
}
