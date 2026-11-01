import { HttpRouter, HttpServerRequest } from "effect/http"
import { Effect, Layer, Tracer } from "effect"
import type { GraphQLSchema } from "graphql"
import { makeGraphQLRouter, type MakeGraphQLRouterOptions } from "@effect-gql/core/server"
import { extractTraceContext, type TraceContext } from "./context-propagation"

/**
 * Options for the traced GraphQL router
 */
export interface TracedRouterOptions extends MakeGraphQLRouterOptions {
  /**
   * Name for the root HTTP span.
   * Default: "graphql.http"
   */
  readonly rootSpanName?: string

  /**
   * Additional attributes to add to the root span.
   */
  readonly rootSpanAttributes?: Record<string, string | number | boolean>

  /**
   * Whether to propagate trace context from incoming HTTP headers.
   * Uses W3C Trace Context (traceparent header).
   * Default: true
   */
  readonly propagateContext?: boolean
}

/**
 * Create an Effect span options object from trace context
 */
const createSpanOptions = (
  traceContext: TraceContext | null,
  request: HttpServerRequest.HttpServerRequest,
  config: TracedRouterOptions
): {
  attributes?: Record<string, unknown>
  parent?: Tracer.ExternalSpan
} => {
  const attributes: Record<string, unknown> = {
    "http.method": request.method,
    "http.url": request.url,
    "http.target": request.url,
    ...config.rootSpanAttributes,
  }

  if (traceContext && config.propagateContext !== false) {
    return {
      attributes,
      parent: Tracer.externalSpan({
        traceId: traceContext.traceId,
        spanId: traceContext.parentSpanId,
        sampled: (traceContext.traceFlags & 0x01) === 0x01,
      }),
    }
  }

  return { attributes }
}

/**
 * Creates a GraphQL router with OpenTelemetry tracing at the HTTP level.
 *
 * This wraps the standard makeGraphQLRouter to:
 * 1. Extract trace context from incoming HTTP headers (W3C Trace Context)
 * 2. Create a root span for the entire HTTP request
 * 3. Propagate trace context to child spans created by extensions/middleware
 *
 * **Span Hierarchy:**
 * ```
 * graphql.http (created by this router)
 * ├── graphql.parse (from tracing extension)
 * ├── graphql.validate (from tracing extension)
 * └── graphql.resolve Query.* (from tracing middleware)
 * ```
 *
 * @example
 * ```typescript
 * import { makeTracedGraphQLRouter } from "@effect-gql/opentelemetry"
 * import { NodeSdk } from "@effect/opentelemetry"
 *
 * const router = makeTracedGraphQLRouter(schema, serviceLayer, {
 *   path: "/graphql",
 *   graphiql: { path: "/graphiql" },
 *   rootSpanName: "graphql.http",
 *   rootSpanAttributes: {
 *     "service.name": "my-api"
 *   }
 * })
 *
 * // Provide OpenTelemetry layer when serving
 * const TracingLayer = NodeSdk.layer(() => ({
 *   resource: { serviceName: "my-graphql-api" },
 *   spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter())
 * }))
 * ```
 *
 * @param schema - The GraphQL schema
 * @param layer - Effect layer providing services required by resolvers
 * @param options - Router and tracing configuration
 * @returns An HttpRouter with tracing enabled
 */
export const makeTracedGraphQLRouter = <R>(
  schema: GraphQLSchema,
  layer: Layer.Layer<R>,
  options: TracedRouterOptions = {}
): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  withTracedRouter(makeGraphQLRouter(schema, layer, options), options)

/**
 * Wrap an existing HttpRouter with OpenTelemetry tracing.
 *
 * This is useful when you already have a router and want to add
 * request-level tracing without recreating it.
 *
 * @example
 * ```typescript
 * import { toRouter } from "@effect-gql/core/server"
 * import { withTracedRouter } from "@effect-gql/opentelemetry"
 *
 * const baseRouter = toRouter(builder, serviceLayer)
 * const tracedRouter = withTracedRouter(baseRouter, {
 *   rootSpanName: "graphql.http"
 * })
 * ```
 */
export const withTracedRouter = <A, E, R>(
  router: Layer.Layer<A, E, R>,
  options: {
    rootSpanName?: string
    rootSpanAttributes?: Record<string, string | number | boolean>
    propagateContext?: boolean
  } = {}
): Layer.Layer<A, E, R> => {
  const tracing = HttpRouter.middleware((httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const traceContext = options.propagateContext !== false ? yield* extractTraceContext : null
      const spanOptions = createSpanOptions(traceContext, request, options)

      return yield* httpEffect.pipe(
        Effect.tap((response) => Effect.annotateCurrentSpan("http.status_code", response.status)),
        Effect.withSpan(options.rootSpanName ?? "graphql.http", spanOptions)
      )
    })
  )

  return router.pipe(Layer.provide(tracing.layer))
}
