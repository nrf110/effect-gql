import { Data } from "effect"

/**
 * Base class for GraphQL errors in Effect
 */
export class GraphQLError extends Data.TaggedError("GraphQLError")<{
  message: string
  extensions?: Record<string, unknown>
}> {}

/**
 * Validation error for input validation failures
 */
export class ValidationError extends Data.TaggedError("ValidationError")<{
  message: string
  field?: string
}> {}

/**
 * Authorization error for access control failures
 */
export class AuthorizationError extends Data.TaggedError("AuthorizationError")<{
  message: string
}> {}

/**
 * Not found error for missing resources
 */
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  message: string
  resource?: string
}> {}
