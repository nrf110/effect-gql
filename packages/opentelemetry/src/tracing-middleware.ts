import { Effect } from "effect"
import type { GraphQLResolveInfo } from "graphql"
import type { MiddlewareRegistration, MiddlewareContext } from "@effect-gql/core"
import { pathToString, getFieldDepth, isIntrospectionField } from "./utils"

/**
 * Configuration for resolver tracing middleware
 */
export interface ResolverTracingConfig {
  /**
   * Minimum field depth to trace.
   * Depth 0 = root fields (Query.*, Mutation.*).
   * Default: 0 (trace all fields)
   */
  readonly minDepth?: number

  /**
   * Maximum field depth to trace.
   * Default: Infinity (no limit)
   */
  readonly maxDepth?: number

  /**
   * Field patterns to exclude from tracing.
   * Patterns are matched against "TypeName.fieldName".
   *
   * @example
   * // Exclude introspection and internal fields
   * excludePatterns: [/^Query\.__/, /\.id$/]
   */
  readonly excludePatterns?: readonly RegExp[]

  /**
   * Whether to include field arguments in span attributes.
   * Default: false (for security - args may contain sensitive data)
   */
  readonly includeArgs?: boolean

  /**
   * Whether to include parent type in span attributes.
   * Default: true
   */
  readonly includeParentType?: boolean

  /**
   * Whether to trace introspection fields (__schema, __type, etc.).
   * Default: false
   */
  readonly traceIntrospection?: boolean

  /**
   * Custom span name generator.
   * Default: "graphql.resolve TypeName.fieldName"
   */
  readonly spanNameGenerator?: (info: GraphQLResolveInfo) => string
}

/**
 * Check if a field should be traced based on configuration
 */
const shouldTraceField = (info: GraphQLResolveInfo, config?: ResolverTracingConfig): boolean => {
  // Skip introspection fields unless explicitly enabled
  if (!config?.traceIntrospection && isIntrospectionField(info)) {
    return false
  }

  const depth = getFieldDepth(info)

  // Check depth bounds
  if (config?.minDepth !== undefined && depth < config.minDepth) {
    return false
  }
  if (config?.maxDepth !== undefined && depth > config.maxDepth) {
    return false
  }

  // Check exclude patterns
  if (config?.excludePatterns) {
    const fieldPath = `${info.parentType.name}.${info.fieldName}`
    for (const pattern of config.excludePatterns) {
      if (pattern.test(fieldPath)) {
        return false
      }
    }
  }

  return true
}

/**
 * Creates middleware that wraps each resolver in an OpenTelemetry span.
 *
 * Each resolver execution creates a child span with GraphQL-specific attributes:
 * - `graphql.field.name`: The field being resolved
 * - `graphql.field.path`: Full path to the field (e.g., "Query.users.0.posts")
 * - `graphql.field.type`: The return type of the field
 * - `graphql.parent.type`: The parent type name
 * - `graphql.operation.name`: The operation name (if available)
 * - `error`: Set to true if the resolver fails
 * - `error.type`: Error type/class name
 * - `error.message`: Error message
 *
 * Requires an OpenTelemetry tracer to be provided via Effect's tracing layer.
 *
 * @example
 * ```typescript
 * import { resolverTracingMiddleware } from "@effect-gql/opentelemetry"
 *
 * const builder = GraphQLSchemaBuilder.empty.pipe(
 *   middleware(resolverTracingMiddleware({
 *     minDepth: 0,
 *     excludePatterns: [/^Query\.__/],
 *     includeArgs: false
 *   })),
 *   query("users", { ... })
 * )
 * ```
 */
export const resolverTracingMiddleware = (
  config?: ResolverTracingConfig
): MiddlewareRegistration<never> => ({
  name: "opentelemetry-resolver-tracing",
  description: "Wraps resolvers in OpenTelemetry spans",

  match: (info: GraphQLResolveInfo) => shouldTraceField(info, config),

  apply: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    context: MiddlewareContext
  ): Effect.Effect<A, E, R> => {
    const { info } = context

    const spanName = config?.spanNameGenerator
      ? config.spanNameGenerator(info)
      : `graphql.resolve ${info.parentType.name}.${info.fieldName}`

    return Effect.withSpan(spanName)(
      Effect.gen(function* () {
        // Add standard attributes
        yield* Effect.annotateCurrentSpan("graphql.field.name", info.fieldName)
        yield* Effect.annotateCurrentSpan("graphql.field.path", pathToString(info.path))
        yield* Effect.annotateCurrentSpan("graphql.field.type", String(info.returnType))

        if (config?.includeParentType !== false) {
          yield* Effect.annotateCurrentSpan("graphql.parent.type", info.parentType.name)
        }

        if (info.operation?.name?.value) {
          yield* Effect.annotateCurrentSpan("graphql.operation.name", info.operation.name.value)
        }

        if (config?.includeArgs && context.args && Object.keys(context.args).length > 0) {
          yield* Effect.annotateCurrentSpan("graphql.field.args", JSON.stringify(context.args))
        }

        // Execute resolver and handle errors
        const result = yield* effect.pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              yield* Effect.annotateCurrentSpan("error", true)
              yield* Effect.annotateCurrentSpan(
                "error.type",
                error instanceof Error ? error.constructor.name : "Error"
              )
              yield* Effect.annotateCurrentSpan(
                "error.message",
                error instanceof Error ? error.message : String(error)
              )
            })
          )
        )

        return result
      })
    ) as Effect.Effect<A, E, R>
  },
})
