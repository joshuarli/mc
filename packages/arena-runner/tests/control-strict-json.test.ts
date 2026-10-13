import assert from "node:assert/strict";
import test from "node:test";
import { parseStrictJson, StrictJsonError } from "../src/control/strict-json.js";

test("strict JSON rejects duplicate decoded object names", () => {
  assert.throws(
    () => parseStrictJson('{"sequence":"1","sequ\\u0065nce":"2"}'),
    (error: unknown) => error instanceof StrictJsonError && error.code === "duplicate_key"
  );
});

test("strict JSON rejects unsafe numeric integers and preserves decimal strings", () => {
  assert.throws(
    () => parseStrictJson('{"tick":9007199254740992}'),
    (error: unknown) => error instanceof StrictJsonError && error.code === "unsafe_number"
  );
  assert.equal(JSON.stringify(parseStrictJson('{"tick":"18446744073709551615"}')), '{"tick":"18446744073709551615"}');
});

test("strict JSON rejects excessive nesting and invalid UTF-8", () => {
  const nested = `${"[".repeat(33)}0${"]".repeat(33)}`;
  assert.throws(
    () => parseStrictJson(nested),
    (error: unknown) => error instanceof StrictJsonError && error.code === "maximum_depth"
  );
  assert.throws(
    () => parseStrictJson(new Uint8Array([0xc3, 0x28])),
    (error: unknown) => error instanceof StrictJsonError && error.code === "invalid_utf8"
  );
});

test("strict JSON rejects malformed Unicode scalar values", () => {
  assert.throws(
    () => parseStrictJson('{"name":"\\ud800"}'),
    (error: unknown) => error instanceof StrictJsonError && error.code === "invalid_json"
  );
});
