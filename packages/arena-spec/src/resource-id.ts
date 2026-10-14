import * as raw from "./raw.js";
import { SpecError, SpecErrorKind } from "./errors.js";

/** Normalizes and validates Minecraft resource identifiers shared by map and scenario inputs. */
export function parseResourceId(value: raw.RawValue, path: string): string {
  const text = raw.string(value, path);
  const separator = text.indexOf(":");
  const namespace = separator === -1 ? "minecraft" : text.slice(0, separator);
  const resourcePath = separator === -1 ? text : text.slice(separator + 1);
  if (separator !== -1 && resourcePath.includes(":")) return invalidResourceId(path);
  if (
    namespace.length === 0
    || resourcePath.length === 0
    || ![...namespace].every(validNamespaceCharacter)
    || ![...resourcePath].every(validPathCharacter)
    || resourcePath.startsWith("/")
    || resourcePath.endsWith("/")
    || resourcePath.includes("//")
  ) return invalidResourceId(path);
  return `${namespace}:${resourcePath}`;
}

function invalidResourceId(path: string): never {
  throw new SpecError(SpecErrorKind.InvalidValue, path, "must be a valid Minecraft resource identifier");
}

function validNamespaceCharacter(character: string): boolean {
  return /^[a-z0-9_.-]$/.test(character);
}

function validPathCharacter(character: string): boolean {
  return character === "/" || validNamespaceCharacter(character);
}
