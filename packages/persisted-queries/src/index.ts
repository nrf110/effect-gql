/**
 * @effect-gql/persisted-queries
 *
 * Apollo Persisted Queries support for Effect GraphQL.
 *
 * Supports both Automatic Persisted Queries (APQ) mode for runtime registration
 * and Safelist mode for pre-registered query allowlisting.
 *
 * ## Quick Start
 *
 * @example APQ Mode (runtime registration)
 * ```typescript
 * import { makePersistedQueriesRouter } from "@effect-gql/persisted-queries"
 *
 * const router = makePersistedQueriesRouter(schema, serviceLayer, {
 *   mode: "apq",
 *   enableGet: true, // Enable CDN caching
 *   graphiql: { path: "/graphiql" },
 * })
 * ```
 *
 * @example Safelist Mode (pre-registered queries only)
 * ```typescript
 * import { makePersistedQueriesRouter, makeSafelistStore } from "@effect-gql/persisted-queries"
 *
 * const router = makePersistedQueriesRouter(schema, serviceLayer, {
 *   mode: "safelist",
 *   store: makeSafelistStore({
 *     "ecf4edb46db40b5132295c0291d62fb65d6759a9eedfa4d5d612dd5ec54a6b38": "query GetUser($id: ID!) { user(id: $id) { name email } }",
 *     "a1b2c3d4...": "query GetPosts { posts { title } }",
 *   }),
 * })
 * ```
 *
 * @example Custom Store Size
 * ```typescript
 * import { makePersistedQueriesRouter, makeMemoryStore } from "@effect-gql/persisted-queries"
 *
 * const router = makePersistedQueriesRouter(schema, serviceLayer, {
 *   store: makeMemoryStore({ maxSize: 5000 }),
 * })
 * ```
 *
 * @packageDocumentation
 */

// Router
export { makePersistedQueriesRouter } from "./persisted-queries-router"

// Store interface and implementations
export { PersistedQueryStore } from "./store"
export type { PersistedQueryStore as PersistedQueryStoreInterface } from "./store"
export { makeMemoryStore, makeSafelistStore } from "./memory-store"
export type { MemoryStoreConfig } from "./memory-store"

// Configuration
export type {
  PersistedQueriesConfig,
  PersistedQueriesRouterOptions,
  PersistedQueryMode,
  HashAlgorithm,
} from "./config"
export { PersistedQueriesConfigFromEnv } from "./config"

// Errors
export {
  PersistedQueryNotFoundError,
  PersistedQueryVersionError,
  PersistedQueryHashMismatchError,
  PersistedQueryNotAllowedError,
  type PersistedQueryError,
  type PersistedQueryGraphQLError,
} from "./errors"

// Utilities
export { computeHash, parsePersistedQueryExtension, parseGetRequestBody } from "./utils"
export type { PersistedQueryExtension, GraphQLRequestBody } from "./utils"
