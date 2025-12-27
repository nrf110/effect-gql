import { Effect, Option } from "effect"
import type { DocumentNode, ExecutionResult, GraphQLError, OperationDefinitionNode } from "graphql"
import type { GraphQLExtension, ExecutionArgs } from "@effect-gql/core"
import { ExtensionsService } from "@effect-gql/core"

/**
 * Configuration for the GraphQL tracing extension
 */
export interface TracingExtensionConfig {
  /**
   * Include the query source in span attributes.
   * Default: false (for security - queries may contain sensitive data)
   */
  readonly includeQuery?: boolean

  /**
   * Include variables in span attributes.
   * Default: false (for security - variables may contain sensitive data)
   */
  readonly includeVariables?: boolean

  /**
   * Add trace ID and span ID to the GraphQL response extensions.
   * Useful for correlating client requests with backend traces.
   * Default: false
   */
  readonly exposeTraceIdInResponse?: boolean

  /**
   * Custom attributes to add to all spans.
   */
  readonly customAttributes?: Record<string, string | number | boolean>
}

/**
 * Extract the operation name from a parsed GraphQL document
 */
const getOperationName = (document: DocumentNode): string | undefined => {
  for (const definition of document.definitions) {
    if (definition.kind === "OperationDefinition") {
      return definition.name?.value
    }
  }
  return undefined
}

/**
 * Extract the operation type (query, mutation, subscription) from a parsed document
 */
const getOperationType = (document: DocumentNode): string => {
  for (const definition of document.definitions) {
    if (definition.kind === "OperationDefinition") {
      return (definition as OperationDefinitionNode).operation
    }
  }
  return "unknown"
}

/**
 * Creates a GraphQL extension that adds OpenTelemetry tracing to all execution phases.
 *
 * This extension:
 * - Creates spans for parse, validate phases
 * - Annotates the current span with operation metadata during execution
 * - Optionally exposes trace ID in response extensions
 *
 * Requires an OpenTelemetry tracer to be provided via Effect's tracing layer
 * (e.g., `@effect/opentelemetry` NodeSdk.layer or OtlpTracer.layer).
 *
 * @example
 * ```typescript
 * import { tracingExtension } from "@effect-gql/opentelemetry"
 *
 * const builder = GraphQLSchemaBuilder.empty.pipe(
 *   extension(tracingExtension({
 *     exposeTraceIdInResponse: true
 *   })),
 *   query("hello", { ... })
 * )
 * ```
 */
export const tracingExtension = (
  config?: TracingExtensionConfig
): GraphQLExtension<ExtensionsService> => ({
  name: "opentelemetry-tracing",
  description: "Adds OpenTelemetry tracing to GraphQL execution phases",

  onParse: (source: string, document: DocumentNode) =>
    Effect.withSpan("graphql.parse")(
      Effect.gen(function* () {
        const operationName = getOperationName(document) ?? "anonymous"
        yield* Effect.annotateCurrentSpan("graphql.document.name", operationName)
        yield* Effect.annotateCurrentSpan(
          "graphql.document.operation_count",
          document.definitions.filter((d) => d.kind === "OperationDefinition").length
        )

        if (config?.includeQuery) {
          yield* Effect.annotateCurrentSpan("graphql.source", source)
        }

        // Add custom attributes if provided
        if (config?.customAttributes) {
          for (const [key, value] of Object.entries(config.customAttributes)) {
            yield* Effect.annotateCurrentSpan(key, value)
          }
        }
      })
    ),

  onValidate: (document: DocumentNode, errors: readonly GraphQLError[]) =>
    Effect.withSpan("graphql.validate")(
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan("graphql.validation.error_count", errors.length)

        if (errors.length > 0) {
          yield* Effect.annotateCurrentSpan(
            "graphql.validation.errors",
            JSON.stringify(errors.map((e) => e.message))
          )
          yield* Effect.annotateCurrentSpan("error", true)
        }
      })
    ),

  onExecuteStart: (args: ExecutionArgs) =>
    Effect.gen(function* () {
      const operationName = args.operationName ?? getOperationName(args.document) ?? "anonymous"
      const operationType = getOperationType(args.document)

      yield* Effect.annotateCurrentSpan("graphql.operation.name", operationName)
      yield* Effect.annotateCurrentSpan("graphql.operation.type", operationType)

      if (config?.includeVariables && args.variableValues) {
        yield* Effect.annotateCurrentSpan(
          "graphql.variables",
          JSON.stringify(args.variableValues)
        )
      }

      // Expose trace ID in response extensions if configured
      if (config?.exposeTraceIdInResponse) {
        const currentSpanOption = yield* Effect.option(Effect.currentSpan)
        if (Option.isSome(currentSpanOption)) {
          const span = currentSpanOption.value
          const ext = yield* ExtensionsService
          yield* ext.set("tracing", {
            traceId: span.traceId,
            spanId: span.spanId,
          })
        }
      }
    }),

  onExecuteEnd: (result: ExecutionResult) =>
    Effect.gen(function* () {
      const hasErrors = result.errors !== undefined && result.errors.length > 0

      yield* Effect.annotateCurrentSpan("graphql.response.has_errors", hasErrors)
      yield* Effect.annotateCurrentSpan(
        "graphql.response.has_data",
        result.data !== null && result.data !== undefined
      )

      if (hasErrors) {
        yield* Effect.annotateCurrentSpan("error", true)
        yield* Effect.annotateCurrentSpan(
          "graphql.errors",
          JSON.stringify(
            result.errors!.map((e) => ({
              message: e.message,
              path: e.path,
            }))
          )
        )
      }
    }),
})
