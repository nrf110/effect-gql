import {
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http"
import { Cause, Effect, Layer, Schema, Tracer } from "effect"
import type { GraphQLSchema } from "graphql"
import { makeGraphQLRouter, type MakeGraphQLRouterOptions } from "@effect-gql/core/server"
import { extractTraceContext, type TraceContext } from "./context-propagation"

// Inspect only known HTTP errors: Respondable conversion can run user effects.
const failureStatus = (cause: Cause.Cause<unknown>): number | undefined => {
  let error: unknown
  let hasFailure = false
  let isDefect = false
  let responseStatus: number | undefined
  for (const reason of cause.reasons) {
    if (reason._tag === "Fail") {
      hasFailure = true
      error = reason.error
      isDefect = false
    } else if (reason._tag === "Die") {
      hasFailure = true
      if (HttpServerResponse.isHttpServerResponse(reason.defect)) {
        responseStatus = reason.defect.status
      } else {
        error = reason.defect
        isDefect = true
      }
    }
  }
  if (responseStatus !== undefined) return responseStatus
  if (!hasFailure) return undefined
  if (HttpServerResponse.isHttpServerResponse(error)) return error.status
  if (HttpServerError.isHttpServerError(error)) {
    if (error.reason._tag === "RouteNotFound") return 404
    if (error.reason._tag === "RequestParseError") {
      return error.reason.reason === "BodyTooLarge" ? 413 : 400
    }
    return 500
  }
  if (HttpServerRespondable.isRespondable(error)) return undefined
  if (!isDefect) {
    if (Schema.isSchemaError(error)) return 400
    if (Cause.isNoSuchElementError(error)) return 404
  }
  return 500
}

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
 * Tracing wraps dispatch for the shared HttpRouter, including unmatched requests
 * and routes merged alongside this layer. Install it once per router.
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
): Layer.Layer<A, E, R | HttpRouter.HttpRouter> => {
  const tracing = HttpRouter.middleware(
    (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const traceContext = options.propagateContext !== false ? yield* extractTraceContext : null
        const spanOptions = createSpanOptions(traceContext, request, options)

        return yield* httpEffect.pipe(
          Effect.onExit((exit) => {
            const status = exit._tag === "Success" ? exit.value.status : failureStatus(exit.cause)
            return status === undefined
              ? Effect.void
              : Effect.annotateCurrentSpan("http.status_code", status)
          }),
          Effect.withSpan(options.rootSpanName ?? "graphql.http", spanOptions)
        )
      }),
    { global: true }
  )

  return Layer.merge(router, tracing)
}
