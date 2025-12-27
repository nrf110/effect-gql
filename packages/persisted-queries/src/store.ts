import { Context, Effect, Option } from "effect"

/**
 * Interface for persisted query storage.
 *
 * Implementations can be in-memory LRU cache, Redis, database, etc.
 * The interface uses Effect for consistency with the rest of the framework.
 */
export interface PersistedQueryStore {
  /**
   * Get a query by its hash.
   * Returns Option.none() if not found.
   */
  readonly get: (hash: string) => Effect.Effect<Option.Option<string>>

  /**
   * Store a query with its hash.
   * In safelist mode, this may be a no-op.
   */
  readonly set: (hash: string, query: string) => Effect.Effect<void>

  /**
   * Check if a hash exists in the store without retrieving the query.
   * More efficient for large queries when you only need existence check.
   */
  readonly has: (hash: string) => Effect.Effect<boolean>
}

/**
 * Service tag for the PersistedQueryStore.
 *
 * Use this tag to provide a store implementation via Effect's dependency injection.
 *
 * @example
 * ```typescript
 * import { PersistedQueryStore, makeMemoryStore } from "@effect-gql/persisted-queries"
 *
 * // Create a layer with the memory store
 * const storeLayer = makeMemoryStore({ maxSize: 1000 })
 *
 * // Use in an Effect
 * const program = Effect.gen(function* () {
 *   const store = yield* PersistedQueryStore
 *   yield* store.set("abc123", "query { hello }")
 *   const query = yield* store.get("abc123")
 *   // query: Option.some("query { hello }")
 * })
 *
 * Effect.runPromise(Effect.provide(program, storeLayer))
 * ```
 */
export const PersistedQueryStore = Context.GenericTag<PersistedQueryStore>(
  "@effect-gql/persisted-queries/PersistedQueryStore"
)
