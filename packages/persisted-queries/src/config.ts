import { Config, Layer } from "effect"
import type { PersistedQueryStore } from "./store"
import type { MakeGraphQLRouterOptions } from "@effect-gql/core/server"

/**
 * Operating mode for persisted queries.
 *
 * - `"apq"`: Automatic Persisted Queries - clients can register queries at runtime
 * - `"safelist"`: Only pre-registered queries are allowed (security mode)
 */
export type PersistedQueryMode = "apq" | "safelist"

/**
 * Hash algorithm used for query hashing.
 * Must match what clients use - Apollo clients use SHA-256.
 */
export type HashAlgorithm = "sha256" | "sha512"

/**
 * Configuration for the persisted queries feature.
 */
export interface PersistedQueriesConfig {
  /**
   * Operating mode.
   *
   * - `"apq"`: Automatic Persisted Queries - clients can register queries at runtime.
   *   Unknown hashes trigger PERSISTED_QUERY_NOT_FOUND, prompting clients to retry with query.
   *
   * - `"safelist"`: Only pre-registered queries are allowed.
   *   Unknown hashes return PERSISTED_QUERY_NOT_ALLOWED error.
   *   Use with `makeSafelistStore()` for production security.
   *
   * Default: `"apq"`
   */
  readonly mode?: PersistedQueryMode

  /**
   * Layer providing the PersistedQueryStore service.
   *
   * Defaults to in-memory LRU store with 1000 entries.
   * Use `makeMemoryStore()` for custom size or `makeSafelistStore()` for safelist mode.
   *
   * @example
   * ```typescript
   * // Custom memory store
   * store: makeMemoryStore({ maxSize: 5000 })
   *
   * // Safelist store
   * store: makeSafelistStore({ "hash1": "query {...}", "hash2": "query {...}" })
   * ```
   */
  readonly store?: Layer.Layer<PersistedQueryStore>

  /**
   * Whether to support GET requests with query parameters.
   *
   * When enabled, the router accepts:
   * ```
   * GET /graphql?extensions={"persistedQuery":{"version":1,"sha256Hash":"..."}}&variables={...}&operationName=...
   * ```
   *
   * This enables CDN caching since the same hash always maps to the same URL.
   *
   * Default: `true`
   */
  readonly enableGet?: boolean

  /**
   * Validate that the provided query matches its hash when storing.
   *
   * This prevents hash collision attacks where a malicious client could
   * register a different query under someone else's hash.
   *
   * Has a slight performance overhead for computing the hash.
   *
   * Default: `true`
   */
  readonly validateHash?: boolean

  /**
   * Hash algorithm to use for validation.
   * Must match what clients use - Apollo clients use SHA-256.
   *
   * Default: `"sha256"`
   */
  readonly hashAlgorithm?: HashAlgorithm
}

/**
 * Options for the persisted queries router.
 *
 * Extends the standard GraphQL router options with persisted query configuration.
 */
export interface PersistedQueriesRouterOptions
  extends MakeGraphQLRouterOptions,
    PersistedQueriesConfig {}

/**
 * Effect Config for loading persisted queries settings from environment variables.
 *
 * Environment variables:
 * - `PERSISTED_QUERIES_MODE`: `"apq"` | `"safelist"` (default: `"apq"`)
 * - `PERSISTED_QUERIES_ENABLE_GET`: boolean (default: `true`)
 * - `PERSISTED_QUERIES_VALIDATE_HASH`: boolean (default: `true`)
 *
 * Note: The store must still be provided programmatically.
 *
 * @example
 * ```typescript
 * import { PersistedQueriesConfigFromEnv } from "@effect-gql/persisted-queries"
 *
 * const config = yield* Config.unwrap(PersistedQueriesConfigFromEnv)
 * ```
 */
export const PersistedQueriesConfigFromEnv: Config.Config<
  Omit<PersistedQueriesConfig, "store">
> = Config.all({
  mode: Config.literal("apq", "safelist")("PERSISTED_QUERIES_MODE").pipe(
    Config.withDefault("apq" as const)
  ),
  enableGet: Config.boolean("PERSISTED_QUERIES_ENABLE_GET").pipe(
    Config.withDefault(true)
  ),
  validateHash: Config.boolean("PERSISTED_QUERIES_VALIDATE_HASH").pipe(
    Config.withDefault(true)
  ),
})
