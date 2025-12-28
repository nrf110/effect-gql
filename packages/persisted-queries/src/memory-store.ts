import { Effect, Layer, Option } from "effect"
import { PersistedQueryStore } from "./store"

/**
 * Configuration for the in-memory LRU store
 */
export interface MemoryStoreConfig {
  /**
   * Maximum number of queries to cache.
   * When exceeded, least recently used queries are evicted.
   * Default: 1000
   */
  readonly maxSize?: number
}

/**
 * Create an in-memory LRU (Least Recently Used) store for persisted queries.
 *
 * This implementation uses Map's natural insertion order for O(1) LRU operations:
 * - get: O(1) - delete and re-insert to move to end (most recently used)
 * - set: O(1) - insert at end, evict from front if needed
 * - eviction: O(1) - delete first entry (least recently used)
 *
 * This is the default store implementation suitable for single-instance servers.
 * For multi-instance deployments, consider using a shared store like Redis.
 *
 * @param config - Optional configuration for cache size
 * @returns A Layer providing the PersistedQueryStore service
 *
 * @example
 * ```typescript
 * import { makeMemoryStore, makePersistedQueriesRouter } from "@effect-gql/persisted-queries"
 *
 * // Default store with 1000 entry limit
 * const router1 = makePersistedQueriesRouter(schema, serviceLayer)
 *
 * // Custom store with larger cache
 * const router2 = makePersistedQueriesRouter(schema, serviceLayer, {
 *   store: makeMemoryStore({ maxSize: 5000 })
 * })
 * ```
 */
export const makeMemoryStore = (
  config: MemoryStoreConfig = {}
): Layer.Layer<PersistedQueryStore> => {
  const maxSize = config.maxSize ?? 1000

  // Map maintains insertion order - we use this for O(1) LRU
  // First entry = least recently used, last entry = most recently used
  const cache = new Map<string, string>()

  // Move entry to end (most recently used) by deleting and re-inserting
  const touch = (hash: string, query: string): void => {
    cache.delete(hash)
    cache.set(hash, query)
  }

  // Evict oldest entry (first in Map) if over capacity - O(1)
  const evictIfNeeded = (): void => {
    if (cache.size <= maxSize) return
    // Map.keys().next() gives us the first (oldest) key in O(1)
    const oldestKey = cache.keys().next().value
    if (oldestKey !== undefined) {
      cache.delete(oldestKey)
    }
  }

  return Layer.succeed(
    PersistedQueryStore,
    PersistedQueryStore.of({
      get: (hash) =>
        Effect.sync(() => {
          const query = cache.get(hash)
          if (query === undefined) {
            return Option.none<string>()
          }
          // Move to end (most recently used)
          touch(hash, query)
          return Option.some(query)
        }),

      set: (hash, query) =>
        Effect.sync(() => {
          // If key exists, delete first to ensure it moves to end
          cache.delete(hash)
          cache.set(hash, query)
          evictIfNeeded()
        }),

      has: (hash) => Effect.sync(() => cache.has(hash)),
    })
  )
}

/**
 * Create a pre-populated safelist store.
 *
 * This store only allows queries that were provided at creation time.
 * Any attempt to store new queries is silently ignored.
 * Use this for production security where you want to allowlist specific operations.
 *
 * @param queries - Record mapping SHA-256 hashes to query strings
 * @returns A Layer providing the PersistedQueryStore service
 *
 * @example
 * ```typescript
 * import { makeSafelistStore, makePersistedQueriesRouter } from "@effect-gql/persisted-queries"
 *
 * // Pre-register allowed queries
 * const router = makePersistedQueriesRouter(schema, serviceLayer, {
 *   mode: "safelist",
 *   store: makeSafelistStore({
 *     "ecf4edb46db40b5132295c0291d62fb65d6759a9eedfa4d5d612dd5ec54a6b38": "query GetUser($id: ID!) { user(id: $id) { name email } }",
 *     "a1b2c3d4...": "query GetPosts { posts { title } }",
 *   }),
 * })
 * ```
 */
export const makeSafelistStore = (
  queries: Record<string, string>
): Layer.Layer<PersistedQueryStore> =>
  Layer.succeed(
    PersistedQueryStore,
    PersistedQueryStore.of({
      get: (hash) =>
        Effect.succeed(queries[hash] !== undefined ? Option.some(queries[hash]) : Option.none()),

      // No-op for safelist mode - queries cannot be added at runtime
      set: () => Effect.void,

      has: (hash) => Effect.succeed(queries[hash] !== undefined),
    })
  )
