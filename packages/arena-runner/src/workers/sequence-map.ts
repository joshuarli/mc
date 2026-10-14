export class PolicySequenceMap {
  readonly #global = new Map<string, bigint>();
  #next = 1n;

  assign(worker: number, epoch: number, local: string): bigint {
    const key = `${worker}:${epoch}:${local}`;
    if (this.#global.has(key)) throw new RangeError('duplicate source sequence');
    const value = this.#next;
    this.#next += 1n;
    this.#global.set(key, value);
    return value;
  }

  resolve(worker: number, epoch: number, local: string): string | undefined {
    return this.#global.get(`${worker}:${epoch}:${local}`)?.toString();
  }
}
