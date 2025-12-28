import { Effect, Layer, Stream, Runtime } from "effect"
import { GraphQLSchema } from "graphql"
import {
  makeGraphQLSSEHandler,
  formatSSEMessage,
  SSE_HEADERS,
  type GraphQLSSEOptions,
  type SSESubscriptionRequest,
} from "@effect-gql/core"

/**
 * Options for Bun SSE handler
 */
export interface BunSSEOptions<R> extends GraphQLSSEOptions<R> {
  /**
   * Path for SSE connections.
   * @default "/graphql/stream"
   */
  readonly path?: string
}

/**
 * Create an SSE handler for Bun.serve().
 *
 * This function creates a handler that returns a streaming Response for SSE
 * subscription requests. It's designed to integrate with Bun.serve()'s fetch handler.
 *
 * @param schema - The GraphQL schema with subscription definitions
 * @param layer - Effect layer providing services required by resolvers
 * @param options - Optional lifecycle hooks and configuration
 * @returns A function that handles SSE requests and returns a Response
 *
 * @example
 * ```typescript
 * const sseHandler = createBunSSEHandler(schema, serviceLayer, {
 *   path: "/graphql/stream",
 * })
 *
 * Bun.serve({
 *   port: 4000,
 *   fetch(req, server) {
 *     const url = new URL(req.url)
 *
 *     // Handle SSE subscriptions
 *     if (url.pathname === "/graphql/stream" && req.method === "POST") {
 *       return sseHandler(req)
 *     }
 *
 *     // Handle other requests...
 *   },
 * })
 * ```
 */
export const createBunSSEHandler = <R>(
  schema: GraphQLSchema,
  layer: Layer.Layer<R>,
  options?: BunSSEOptions<R>
): (request: Request) => Promise<Response> => {
  const sseHandler = makeGraphQLSSEHandler(schema, layer, options)

  return async (request: Request): Promise<Response> => {
    // Check Accept header for SSE support
    const accept = request.headers.get("accept") ?? ""
    if (!accept.includes("text/event-stream") && !accept.includes("*/*")) {
      return new Response(
        JSON.stringify({
          errors: [{ message: "Client must accept text/event-stream" }],
        }),
        { status: 406, headers: { "Content-Type": "application/json" } }
      )
    }

    // Read and parse the request body
    let subscriptionRequest: SSESubscriptionRequest
    try {
      const body = await request.json() as Record<string, unknown>
      if (typeof body.query !== "string") {
        throw new Error("Missing query")
      }
      subscriptionRequest = {
        query: body.query,
        variables: body.variables as Record<string, unknown> | undefined,
        operationName: body.operationName as string | undefined,
        extensions: body.extensions as Record<string, unknown> | undefined,
      }
    } catch {
      return new Response(
        JSON.stringify({
          errors: [{ message: "Invalid GraphQL request body" }],
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    // Get the event stream
    const eventStream = sseHandler(subscriptionRequest, request.headers)

    // Create a ReadableStream from the Effect Stream
    const readableStream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder()

        await Effect.runPromise(
          Stream.runForEach(eventStream, (event) =>
            Effect.sync(() => {
              const message = formatSSEMessage(event)
              controller.enqueue(encoder.encode(message))
            })
          ).pipe(
            Effect.catchAll((error) =>
              Effect.logWarning("SSE stream error", error)
            ),
            Effect.ensuring(
              Effect.sync(() => controller.close())
            )
          )
        )
      },
    })

    return new Response(readableStream, {
      status: 200,
      headers: SSE_HEADERS,
    })
  }
}

/**
 * Create SSE handlers that integrate with Bun.serve().
 *
 * This returns an object with methods to check if a request should be
 * handled as SSE and to handle it.
 *
 * @param schema - The GraphQL schema with subscription definitions
 * @param layer - Effect layer providing services required by resolvers
 * @param options - Optional lifecycle hooks and configuration
 *
 * @example
 * ```typescript
 * const { upgrade: wsUpgrade, websocket } = createBunWSHandlers(schema, layer)
 * const sse = createBunSSEHandlers(schema, layer)
 *
 * Bun.serve({
 *   port: 4000,
 *   fetch(req, server) {
 *     // Try WebSocket upgrade first
 *     if (wsUpgrade(req, server)) {
 *       return
 *     }
 *
 *     // Try SSE subscriptions
 *     if (sse.shouldHandle(req)) {
 *       return sse.handle(req)
 *     }
 *
 *     // Handle other requests...
 *   },
 *   websocket,
 * })
 * ```
 */
export const createBunSSEHandlers = <R>(
  schema: GraphQLSchema,
  layer: Layer.Layer<R>,
  options?: BunSSEOptions<R>
): {
  /** Path this SSE handler responds to */
  readonly path: string
  /** Check if a request should be handled as SSE */
  shouldHandle: (request: Request) => boolean
  /** Handle an SSE request */
  handle: (request: Request) => Promise<Response>
} => {
  const path = options?.path ?? "/graphql/stream"
  const handler = createBunSSEHandler(schema, layer, options)

  return {
    path,
    shouldHandle: (request: Request) => {
      if (request.method !== "POST") return false
      const url = new URL(request.url)
      return url.pathname === path
    },
    handle: handler,
  }
}
