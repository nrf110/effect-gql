import { Effect } from "effect"
import { createHash } from "crypto"
import type { HashAlgorithm } from "./config"

/**
 * Compute the hash of a query string.
 *
 * @param query - The GraphQL query string to hash
 * @param algorithm - Hash algorithm to use (default: sha256)
 * @returns Effect that resolves to the hex-encoded hash
 */
export const computeHash = (
  query: string,
  algorithm: HashAlgorithm = "sha256"
): Effect.Effect<string> =>
  Effect.sync(() => createHash(algorithm).update(query).digest("hex"))

/**
 * Structure of the persisted query extension in GraphQL requests.
 * This follows the Apollo APQ protocol.
 */
export interface PersistedQueryExtension {
  readonly version: number
  readonly sha256Hash: string
}

/**
 * Parse and validate the persisted query extension from request extensions.
 *
 * @param extensions - The extensions object from the GraphQL request
 * @returns The parsed persisted query extension, or null if not present/invalid
 */
export const parsePersistedQueryExtension = (
  extensions: unknown
): PersistedQueryExtension | null => {
  if (
    typeof extensions !== "object" ||
    extensions === null ||
    !("persistedQuery" in extensions)
  ) {
    return null
  }

  const pq = (extensions as Record<string, unknown>).persistedQuery

  if (
    typeof pq !== "object" ||
    pq === null ||
    !("version" in pq) ||
    !("sha256Hash" in pq)
  ) {
    return null
  }

  const version = (pq as Record<string, unknown>).version
  const sha256Hash = (pq as Record<string, unknown>).sha256Hash

  if (typeof version !== "number" || typeof sha256Hash !== "string") {
    return null
  }

  return { version, sha256Hash }
}

/**
 * GraphQL request body structure with optional persisted query extension.
 */
export interface GraphQLRequestBody {
  query?: string
  variables?: Record<string, unknown>
  operationName?: string
  extensions?: {
    persistedQuery?: PersistedQueryExtension
    [key: string]: unknown
  }
}

/**
 * Parse a GET request's query parameters into a GraphQL request body.
 *
 * Supports the following query parameters:
 * - `query`: The GraphQL query string (optional with persisted queries)
 * - `variables`: JSON-encoded variables object
 * - `operationName`: Name of the operation to execute
 * - `extensions`: JSON-encoded extensions object containing persistedQuery
 *
 * @param searchParams - URLSearchParams from the request URL
 * @returns Effect that resolves to the parsed request body or fails with parse error
 */
export const parseGetRequestBody = (
  searchParams: URLSearchParams
): Effect.Effect<GraphQLRequestBody, Error> =>
  Effect.try({
    try: () => {
      const extensionsRaw = searchParams.get("extensions")
      const variablesRaw = searchParams.get("variables")

      const result: GraphQLRequestBody = {}

      const query = searchParams.get("query")
      if (query) {
        result.query = query
      }

      const operationName = searchParams.get("operationName")
      if (operationName) {
        result.operationName = operationName
      }

      if (variablesRaw) {
        result.variables = JSON.parse(variablesRaw)
      }

      if (extensionsRaw) {
        result.extensions = JSON.parse(extensionsRaw)
      }

      return result
    },
    catch: (e) => new Error(`Failed to parse query parameters: ${e}`),
  })
