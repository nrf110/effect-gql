import { Context, Effect, Ref } from "effect"
import type { DocumentNode, ExecutionResult, GraphQLError } from "graphql"

/**
 * Execution arguments passed to onExecuteStart hook
 */
export interface ExecutionArgs {
  readonly source: string
  readonly document: DocumentNode
  readonly variableValues?: Record<string, unknown>
  readonly operationName?: string
}

/**
 * Configuration for a GraphQL extension
 *
 * Extensions provide lifecycle hooks that run at each phase of request processing,
 * and can contribute data to the response's `extensions` field.
 *
 * @example
 * ```typescript
 * // Tracing extension
 * extension({
 *   name: "tracing",
 *   onExecuteStart: () => Effect.gen(function*() {
 *     const ext = yield* ExtensionsService
 *     yield* ext.set("tracing", { startTime: Date.now() })
 *   }),
 *   onExecuteEnd: () => Effect.gen(function*() {
 *     const ext = yield* ExtensionsService
 *     yield* ext.merge("tracing", { endTime: Date.now() })
 *   }),
 * })
 * ```
 */
export interface GraphQLExtension<R = never> {
  readonly name: string
  readonly description?: string

  /**
   * Called after the query source is parsed into a DocumentNode.
   * Useful for query analysis, caching parsed documents, etc.
   */
  readonly onParse?: (source: string, document: DocumentNode) => Effect.Effect<void, never, R>

  /**
   * Called after validation completes.
   * Receives the document and any validation errors.
   * Useful for complexity analysis, query whitelisting, etc.
   */
  readonly onValidate?: (
    document: DocumentNode,
    errors: readonly GraphQLError[]
  ) => Effect.Effect<void, never, R>

  /**
   * Called before execution begins.
   * Receives the full execution arguments.
   * Useful for setting up tracing, logging, etc.
   */
  readonly onExecuteStart?: (args: ExecutionArgs) => Effect.Effect<void, never, R>

  /**
   * Called after execution completes.
   * Receives the execution result (including data and errors).
   * Useful for recording metrics, finalizing traces, etc.
   */
  readonly onExecuteEnd?: (result: ExecutionResult) => Effect.Effect<void, never, R>
}

/**
 * Service for accumulating extension data during request processing.
 *
 * This service is automatically provided for each request and allows
 * extensions, middleware, and resolvers to contribute to the response
 * extensions field.
 *
 * @example
 * ```typescript
 * Effect.gen(function*() {
 *   const ext = yield* ExtensionsService
 *
 *   // Set a value (overwrites existing)
 *   yield* ext.set("complexity", { score: 42 })
 *
 *   // Merge into existing value
 *   yield* ext.merge("tracing", { endTime: Date.now() })
 *
 *   // Get all accumulated extensions
 *   const all = yield* ext.get()
 * })
 * ```
 */
export interface ExtensionsService {
  /**
   * Set a key-value pair in the extensions.
   * Overwrites any existing value for this key.
   */
  readonly set: (key: string, value: unknown) => Effect.Effect<void>

  /**
   * Deep merge an object into an existing key's value.
   * If the key doesn't exist, sets the value.
   * If the existing value is not an object, overwrites it.
   */
  readonly merge: (key: string, value: Record<string, unknown>) => Effect.Effect<void>

  /**
   * Get all accumulated extensions as a record.
   */
  readonly get: () => Effect.Effect<Record<string, unknown>>
}

/**
 * Tag for the ExtensionsService
 */
export const ExtensionsService = Context.GenericTag<ExtensionsService>("@effect-gql/ExtensionsService")

/**
 * Deep merge two objects
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    const sourceValue = source[key]
    const targetValue = result[key]

    if (
      typeof sourceValue === "object" &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === "object" &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      )
    } else {
      result[key] = sourceValue
    }
  }
  return result
}

/**
 * Create a new ExtensionsService backed by a Ref
 */
export const makeExtensionsService = (): Effect.Effect<ExtensionsService, never, never> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<Record<string, unknown>>({})

    return ExtensionsService.of({
      set: (key, value) => Ref.update(ref, (current) => ({ ...current, [key]: value })),

      merge: (key, value) =>
        Ref.update(ref, (current) => {
          const existing = current[key]
          if (
            typeof existing === "object" &&
            existing !== null &&
            !Array.isArray(existing)
          ) {
            return {
              ...current,
              [key]: deepMerge(existing as Record<string, unknown>, value),
            }
          }
          return { ...current, [key]: value }
        }),

      get: () => Ref.get(ref),
    })
  })

/**
 * Run all onParse hooks for registered extensions
 */
export const runParseHooks = <R>(
  extensions: readonly GraphQLExtension<R>[],
  source: string,
  document: DocumentNode
): Effect.Effect<void, never, R> =>
  Effect.forEach(
    extensions.filter((ext) => ext.onParse !== undefined),
    (ext) =>
      ext.onParse!(source, document).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logWarning(`Extension "${ext.name}" onParse hook failed`, cause)
        )
      ),
    { discard: true }
  ) as Effect.Effect<void, never, R>

/**
 * Run all onValidate hooks for registered extensions
 */
export const runValidateHooks = <R>(
  extensions: readonly GraphQLExtension<R>[],
  document: DocumentNode,
  errors: readonly GraphQLError[]
): Effect.Effect<void, never, R> =>
  Effect.forEach(
    extensions.filter((ext) => ext.onValidate !== undefined),
    (ext) =>
      ext.onValidate!(document, errors).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logWarning(`Extension "${ext.name}" onValidate hook failed`, cause)
        )
      ),
    { discard: true }
  ) as Effect.Effect<void, never, R>

/**
 * Run all onExecuteStart hooks for registered extensions
 */
export const runExecuteStartHooks = <R>(
  extensions: readonly GraphQLExtension<R>[],
  args: ExecutionArgs
): Effect.Effect<void, never, R> =>
  Effect.forEach(
    extensions.filter((ext) => ext.onExecuteStart !== undefined),
    (ext) =>
      ext.onExecuteStart!(args).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logWarning(`Extension "${ext.name}" onExecuteStart hook failed`, cause)
        )
      ),
    { discard: true }
  ) as Effect.Effect<void, never, R>

/**
 * Run all onExecuteEnd hooks for registered extensions
 */
export const runExecuteEndHooks = <R>(
  extensions: readonly GraphQLExtension<R>[],
  result: ExecutionResult
): Effect.Effect<void, never, R> =>
  Effect.forEach(
    extensions.filter((ext) => ext.onExecuteEnd !== undefined),
    (ext) =>
      ext.onExecuteEnd!(result).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logWarning(`Extension "${ext.name}" onExecuteEnd hook failed`, cause)
        )
      ),
    { discard: true }
  ) as Effect.Effect<void, never, R>
