import { Context, Effect, Ref } from "effect"
import type { DocumentNode, ExecutionResult, GraphQLError, GraphQLSchema } from "graphql"
import type { FieldComplexityMap } from "./server/complexity"

/**
 * Execution arguments passed to onExecuteStart hook
 */
export interface ExecutionArgs {
  readonly source: string
  readonly document: DocumentNode
  readonly variableValues?: Record<string, unknown>
  readonly operationName?: string
  /** The GraphQL schema being executed against */
  readonly schema: GraphQLSchema
  /** Field complexity definitions from the schema builder */
  readonly fieldComplexities: FieldComplexityMap
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
export const ExtensionsService = Context.GenericTag<ExtensionsService>(
  "@effect-gql/ExtensionsService"
)

/**
 * Deep merge two objects
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
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
          if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
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
 * Generic helper to run extension hooks with error handling.
 * Filters extensions that have the specified hook, runs them,
 * and logs warnings if any hook fails.
 */
const runExtensionHooks = <R, K extends keyof GraphQLExtension<R>>(
  extensions: readonly GraphQLExtension<R>[],
  hookName: K,
  getHookEffect: (ext: GraphQLExtension<R>) => Effect.Effect<void, never, R>
): Effect.Effect<void, never, R> =>
  Effect.forEach(
    extensions.filter((ext) => ext[hookName] !== undefined),
    (ext) =>
      getHookEffect(ext).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logWarning(`Extension "${ext.name}" ${String(hookName)} hook failed`, cause)
        )
      ),
    { discard: true }
  ) as Effect.Effect<void, never, R>

/**
 * Run all onParse hooks for registered extensions
 */
export const runParseHooks = <R>(
  extensions: readonly GraphQLExtension<R>[],
  source: string,
  document: DocumentNode
): Effect.Effect<void, never, R> =>
  runExtensionHooks(extensions, "onParse", (ext) => ext.onParse!(source, document))

/**
 * Run all onValidate hooks for registered extensions
 */
export const runValidateHooks = <R>(
  extensions: readonly GraphQLExtension<R>[],
  document: DocumentNode,
  errors: readonly GraphQLError[]
): Effect.Effect<void, never, R> =>
  runExtensionHooks(extensions, "onValidate", (ext) => ext.onValidate!(document, errors))

/**
 * Run all onExecuteStart hooks for registered extensions
 */
export const runExecuteStartHooks = <R>(
  extensions: readonly GraphQLExtension<R>[],
  args: ExecutionArgs
): Effect.Effect<void, never, R> =>
  runExtensionHooks(extensions, "onExecuteStart", (ext) => ext.onExecuteStart!(args))

/**
 * Run all onExecuteEnd hooks for registered extensions
 */
export const runExecuteEndHooks = <R>(
  extensions: readonly GraphQLExtension<R>[],
  result: ExecutionResult
): Effect.Effect<void, never, R> =>
  runExtensionHooks(extensions, "onExecuteEnd", (ext) => ext.onExecuteEnd!(result))
