/**
 * Run `fn` over `items` with at most `limit` in flight; results keep input order.
 * On the first failure no new items start, in-flight ones are awaited, then the first
 * error is thrown — so nothing keeps writing after the caller has handled the failure.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const errors: unknown[] = [];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && errors.length === 0) {
      const i = next++;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (error) {
        errors.push(error);
      }
    }
  });
  await Promise.all(workers);
  if (errors.length > 0) throw errors[0];
  return results;
}
