import { createHash, type Hash } from "node:crypto";

declare const semanticIdBrand: unique symbol;

/** A lowercase hexadecimal SHA-256 identity produced from canonical IR. */
export type SemanticId = string & { readonly [semanticIdBrand]: true };

export class CanonicalHasher {
  readonly #hash: Hash;
  readonly #scratch = Buffer.allocUnsafe(8);

  constructor(domain: string) {
    this.#hash = createHash("sha256");
    this.#hash.update(domain, "utf8");
  }

  u8(value: number): void {
    this.#scratch.writeUInt8(value, 0);
    this.#hash.update(this.#scratch.subarray(0, 1));
  }

  u16(value: number): void {
    this.#scratch.writeUInt16LE(value, 0);
    this.#hash.update(this.#scratch.subarray(0, 2));
  }

  u32(value: number): void {
    this.#scratch.writeUInt32LE(value, 0);
    this.#hash.update(this.#scratch.subarray(0, 4));
  }

  u64(value: bigint): void {
    this.#scratch.writeBigUInt64LE(value, 0);
    this.#hash.update(this.#scratch);
  }

  i32(value: number): void {
    this.#scratch.writeInt32LE(value, 0);
    this.#hash.update(this.#scratch.subarray(0, 4));
  }

  f64(value: number): void {
    this.#scratch.writeDoubleLE(value, 0);
    this.#hash.update(this.#scratch);
  }

  bytes(value: Uint8Array): void {
    this.u64(BigInt(value.byteLength));
    this.#hash.update(value);
  }

  string(value: string): void {
    this.bytes(Buffer.from(value, "utf8"));
  }

  finish(): SemanticId {
    return this.#hash.digest("hex") as SemanticId;
  }
}
