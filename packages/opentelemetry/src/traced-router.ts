import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
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
): HttpRouter.HttpRouter<never, never> => {
  const rootSpanName = options.rootSpanName ?? "graphql.http"

  // Create the base router (handles GraphQL logic)
  const baseRouter = makeGraphQLRouter(schema, layer, options)

  // Convert base router to an HttpApp for Effect-based handling
  const baseApp = HttpRouter.toHttpApp(baseRouter)

  // Wrap with tracing
  return HttpRouter.empty.pipe(
    HttpRouter.all(
      "*",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest

        // Extract trace context from headers (if enabled)
        const traceContext =
          options.propagateContext !== false
            ? yield* extractTraceContext.pipe(Effect.catchAll(() => Effect.succeed(null)))
            : null

        // Create span options with parent context if available
        const spanOptions = createSpanOptions(traceContext, request, options)

        // Execute the request inside a root span
        return yield* Effect.withSpan(rootSpanName, spanOptions)(
          Effect.gen(function* () {
            // Delegate to the base app (which handles the request from context)
            const app = yield* baseApp
            const response = yield* app.pipe(
              Effect.catchTag("RouteNotFound", () =>
                HttpServerResponse.text(
                  JSON.stringify({ errors: [{ message: "Not Found" }] }),
                  { status: 404, headers: { "content-type": "application/json" } }
                )
              )
            )

            // Annotate span with response info
            yield* Effect.annotateCurrentSpan("http.status_code", response.status)

            return response
          })
        )
      })
    )
  )
}

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
export const withTracedRouter = (
  router: HttpRouter.HttpRouter<any, any>,
  options: {
    rootSpanName?: string
    rootSpanAttributes?: Record<string, string | number | boolean>
    propagateContext?: boolean
  } = {}
): HttpRouter.HttpRouter<any, any> => {
  const rootSpanName = options.rootSpanName ?? "graphql.http"

  // Convert router to an HttpApp for Effect-based handling
  const baseApp = HttpRouter.toHttpApp(router)

  return HttpRouter.empty.pipe(
    HttpRouter.all(
      "*",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest

        // Extract trace context from headers
        const traceContext =
          options.propagateContext !== false
            ? yield* extractTraceContext.pipe(Effect.catchAll(() => Effect.succeed(null)))
            : null

        const spanOptions: {
          attributes: Record<string, unknown>
          parent?: Tracer.ExternalSpan
        } = {
          attributes: {
            "http.method": request.method,
            "http.url": request.url,
            ...options.rootSpanAttributes,
          },
        }

        if (traceContext && options.propagateContext !== false) {
          spanOptions.parent = Tracer.externalSpan({
            traceId: traceContext.traceId,
            spanId: traceContext.parentSpanId,
            sampled: (traceContext.traceFlags & 0x01) === 0x01,
          })
        }

        return yield* Effect.withSpan(rootSpanName, spanOptions)(
          Effect.gen(function* () {
            // Delegate to the base app (which handles the request from context)
            const app = yield* baseApp
            const response = yield* app

            // Annotate span with response info
            yield* Effect.annotateCurrentSpan("http.status_code", response.status)

            return response
          })
        )
      })
    )
  )
}
