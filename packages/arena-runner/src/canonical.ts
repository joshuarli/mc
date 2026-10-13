import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value)!;
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)!;
  if (Array.isArray(value)) return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;

  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  throw new TypeError('value is not JSON serializable');
}

export function sha256Json(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
