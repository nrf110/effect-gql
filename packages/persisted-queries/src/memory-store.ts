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

interface CacheEntry {
  readonly query: string
  accessOrder: number
}

// Global counter for access ordering (monotonically increasing)
let accessCounter = 0

/**
 * Create an in-memory LRU (Least Recently Used) store for persisted queries.
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

  // Create the cache once when the layer is created (not when it's used)
  const cache = new Map<string, CacheEntry>()

  const getNextAccessOrder = () => ++accessCounter

  const evictLRU = (): void => {
    if (cache.size <= maxSize) return

    // Find and remove LRU entry (lowest access order)
    let oldestKey: string | undefined
    let oldestOrder = Infinity
    for (const [key, entry] of cache) {
      if (entry.accessOrder < oldestOrder) {
        oldestOrder = entry.accessOrder
        oldestKey = key
      }
    }

    if (oldestKey) {
      cache.delete(oldestKey)
    }
  }

  return Layer.succeed(
    PersistedQueryStore,
    PersistedQueryStore.of({
      get: (hash) =>
        Effect.sync(() => {
          const entry = cache.get(hash)
          if (!entry) {
            return Option.none<string>()
          }
          // Update access order
          entry.accessOrder = getNextAccessOrder()
          return Option.some(entry.query)
        }),

      set: (hash, query) =>
        Effect.sync(() => {
          cache.set(hash, { query, accessOrder: getNextAccessOrder() })
          evictLRU()
        }),

      has: (hash) =>
        Effect.sync(() => cache.has(hash)),
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
        Effect.succeed(
          queries[hash] !== undefined
            ? Option.some(queries[hash])
            : Option.none()
        ),

      // No-op for safelist mode - queries cannot be added at runtime
      set: () => Effect.void,

      has: (hash) => Effect.succeed(queries[hash] !== undefined),
    })
  )
