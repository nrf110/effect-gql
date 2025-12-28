/**
 * @effect-gql/opentelemetry
 *
 * OpenTelemetry tracing integration for Effect GraphQL.
 *
 * Provides distributed tracing using Effect's native OpenTelemetry support.
 * Works with any OpenTelemetry-compatible backend (Jaeger, Tempo, Honeycomb, etc.).
 *
 * @example
 * ```typescript
 * import { GraphQLSchemaBuilder } from "@effect-gql/core"
 * import { serve } from "@effect-gql/node"
 * import { withTracing } from "@effect-gql/opentelemetry"
 * import { NodeSdk } from "@effect/opentelemetry"
 * import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
 * import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
 *
 * // Add tracing to schema
 * const builder = GraphQLSchemaBuilder.empty
 *   .query("users", { ... })
 *   .pipe(withTracing({
 *     extension: { exposeTraceIdInResponse: true },
 *     resolver: { excludePatterns: [/^Query\.__/] }
 *   }))
 *
 * // Configure OpenTelemetry
 * const TracingLayer = NodeSdk.layer(() => ({
 *   resource: { serviceName: "my-graphql-api" },
 *   spanProcessor: new BatchSpanProcessor(
 *     new OTLPTraceExporter({ url: "http://localhost:4318/v1/traces" })
 *   )
 * }))
 *
 * // Serve with tracing
 * serve(builder, TracingLayer.pipe(Layer.merge(serviceLayer)))
 * ```
 *
 * @packageDocumentation
 */

import type { GraphQLSchemaBuilder } from "@effect-gql/core"
import { tracingExtension, type TracingExtensionConfig } from "./tracing-extension"
import { resolverTracingMiddleware, type ResolverTracingConfig } from "./tracing-middleware"

/**
 * Complete configuration for GraphQL tracing
 */
export interface GraphQLTracingConfig {
  /**
   * Configuration for phase-level tracing (parse, validate, execute).
   * Uses the Extensions system.
   */
  readonly extension?: TracingExtensionConfig

  /**
   * Configuration for resolver-level tracing.
   * Uses the Middleware system.
   */
  readonly resolver?: ResolverTracingConfig
}

/**
 * Add OpenTelemetry tracing to a GraphQL schema builder.
 *
 * This is a convenience function that registers both the tracing extension
 * (for phase-level spans) and resolver middleware (for field-level spans).
 *
 * **Span Hierarchy:**
 * ```
 * graphql.request (if using traced router)
 * ├── graphql.parse
 * ├── graphql.validate
 * └── graphql.execute
 *     ├── graphql.resolve Query.users
 *     ├── graphql.resolve User.posts
 *     └── graphql.resolve Post.author
 * ```
 *
 * **Requirements:**
 * - An OpenTelemetry tracer must be provided via Effect's tracing layer
 * - Use `@effect/opentelemetry` NodeSdk.layer or OtlpTracer.layer
 *
 * @example
 * ```typescript
 * import { GraphQLSchemaBuilder } from "@effect-gql/core"
 * import { withTracing } from "@effect-gql/opentelemetry"
 *
 * const builder = GraphQLSchemaBuilder.empty
 *   .query("hello", {
 *     type: S.String,
 *     resolve: () => Effect.succeed("world")
 *   })
 *   .pipe(withTracing({
 *     extension: {
 *       exposeTraceIdInResponse: true,  // Add traceId to response extensions
 *       includeQuery: false,            // Don't include query in spans (security)
 *     },
 *     resolver: {
 *       minDepth: 0,                    // Trace all resolvers
 *       excludePatterns: [/^Query\.__/], // Skip introspection
 *       includeArgs: false,             // Don't include args (security)
 *     }
 *   }))
 * ```
 *
 * @param config - Optional tracing configuration
 * @returns A function that adds tracing to a GraphQLSchemaBuilder
 */
export const withTracing =
  <R>(config?: GraphQLTracingConfig) =>
  (builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R> => {
    // Add tracing extension for phase-level spans
    let result = builder.extension(tracingExtension(config?.extension))

    // Add resolver tracing middleware for field-level spans
    result = result.middleware(resolverTracingMiddleware(config?.resolver))

    return result as GraphQLSchemaBuilder<R>
  }

// Re-export components for individual use
export { tracingExtension, type TracingExtensionConfig } from "./tracing-extension"
export { resolverTracingMiddleware, type ResolverTracingConfig } from "./tracing-middleware"
export {
  extractTraceContext,
  parseTraceParent,
  formatTraceParent,
  isSampled,
  TraceContextTag,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  type TraceContext,
} from "./context-propagation"
export { pathToString, getFieldDepth, isIntrospectionField } from "./utils"
export {
  makeTracedGraphQLRouter,
  withTracedRouter,
  type TracedRouterOptions,
} from "./traced-router"
