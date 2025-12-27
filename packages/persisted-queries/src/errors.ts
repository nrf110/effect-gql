import { Data } from "effect"

/**
 * GraphQL error format for APQ responses.
 * Compatible with Apollo Client's error handling.
 */
export interface PersistedQueryGraphQLError {
  readonly message: string
  readonly extensions: {
    readonly code: string
    readonly [key: string]: unknown
  }
}

/**
 * Error returned when a persisted query hash is not found in the store
 * and no query body was provided.
 *
 * Apollo clients recognize this error and automatically retry with the full query.
 * This is the expected flow for Automatic Persisted Queries (APQ).
 */
export class PersistedQueryNotFoundError extends Data.TaggedError(
  "PersistedQueryNotFoundError"
)<{
  readonly hash: string
}> {
  /**
   * Convert to GraphQL error format compatible with Apollo protocol.
   */
  toGraphQLError(): PersistedQueryGraphQLError {
    return {
      message: "PersistedQueryNotFound",
      extensions: {
        code: "PERSISTED_QUERY_NOT_FOUND",
      },
    }
  }
}

/**
 * Error returned when the persisted query protocol version is not supported.
 *
 * Currently only version 1 is supported, which uses SHA-256 hashing.
 */
export class PersistedQueryVersionError extends Data.TaggedError(
  "PersistedQueryVersionError"
)<{
  readonly version: number
}> {
  toGraphQLError(): PersistedQueryGraphQLError {
    return {
      message: `Unsupported persisted query version: ${this.version}`,
      extensions: {
        code: "PERSISTED_QUERY_VERSION_NOT_SUPPORTED",
        version: this.version,
      },
    }
  }
}

/**
 * Error returned when the provided query doesn't match its hash.
 *
 * This can indicate a client bug or a potential hash collision attack.
 * Hash validation is enabled by default and can be disabled if needed.
 */
export class PersistedQueryHashMismatchError extends Data.TaggedError(
  "PersistedQueryHashMismatchError"
)<{
  readonly providedHash: string
  readonly computedHash: string
}> {
  toGraphQLError(): PersistedQueryGraphQLError {
    return {
      message: "Query hash does not match provided hash",
      extensions: {
        code: "PERSISTED_QUERY_HASH_MISMATCH",
      },
    }
  }
}

/**
 * Error returned when trying to execute a query that is not in the safelist.
 *
 * In safelist mode, only pre-registered queries are allowed.
 * This error is returned when a client tries to register a new query.
 */
export class PersistedQueryNotAllowedError extends Data.TaggedError(
  "PersistedQueryNotAllowedError"
)<{
  readonly hash: string
}> {
  toGraphQLError(): PersistedQueryGraphQLError {
    return {
      message: "Query not in safelist",
      extensions: {
        code: "PERSISTED_QUERY_NOT_ALLOWED",
      },
    }
  }
}

/**
 * Union type of all APQ-related errors
 */
export type PersistedQueryError =
  | PersistedQueryNotFoundError
  | PersistedQueryVersionError
  | PersistedQueryHashMismatchError
  | PersistedQueryNotAllowedError
