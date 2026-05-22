// Generic async-iterator helper. Resources delegate cursor walking to this
// so list endpoints share the same pagination semantics.

import type { Paginated } from '../types/common.js';

export type FetchPageFn<T> = (cursor: string | undefined) => Promise<Paginated<T>>;

/**
 * Walks a paginated server endpoint via async iteration.
 *
 * Consumers receive items one-by-one; the helper fetches the next page
 * once the local buffer drains. Stops when the server reports
 * `hasMore: false` or returns an empty page without a `nextCursor`.
 *
 * @param fetchPage - Callback that takes the current cursor and returns the next page.
 * @returns An async iterable that yields items across pages.
 * @example
 * for await (const item of paginate(cursor => api.list({ cursor }))) {
 *   console.log(item);
 * }
 */
export function paginate<T>(fetchPage: FetchPageFn<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let cursor: string | undefined;
      let buffer: T[] = [];
      let exhausted = false;

      return {
        async next(): Promise<IteratorResult<T>> {
          while (buffer.length === 0) {
            if (exhausted) {
              return { value: undefined, done: true };
            }
            const page = await fetchPage(cursor);
            buffer = page.items.slice();
            cursor = page.nextCursor;
            if (!page.hasMore) {
              exhausted = true;
            }
            // Defensive: if the server returned an empty page but said hasMore
            // is true and no nextCursor, stop to avoid an infinite loop.
            if (page.items.length === 0 && cursor === undefined) {
              exhausted = true;
            }
          }
          const next = buffer.shift() as T;
          return { value: next, done: false };
        }
      };
    }
  };
}
