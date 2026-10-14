export const MAX_CONCURRENCY = 4;

export function parseConcurrency(text: string): number | undefined {
  if (!/^[1-9][0-9]?$/.test(text)) return undefined;
  const value = Number(text);
  return value <= MAX_CONCURRENCY ? value : undefined;
}

export async function mapBounded<Item, Result>(
  items: readonly Item[],
  concurrency: number,
  task: (item: Item, index: number) => Promise<Result>,
  signal?: AbortSignal,
): Promise<readonly Result[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be a positive integer');
  }
  const results = new Array<Result>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      signal?.throwIfAborted();
      const index = next;
      if (index >= items.length) return;
      next += 1;
      try {
        results[index] = await task(items[index]!, index);
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failure !== undefined) throw failure.error;
  return results;
}
