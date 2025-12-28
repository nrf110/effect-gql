import { Effect, Layer, Stream, Runtime, Fiber, Deferred } from "effect"
import type { IncomingMessage, ServerResponse } from "node:http"
import { GraphQLSchema } from "graphql"
import {
  makeGraphQLSSEHandler,
  formatSSEMessage,
  SSE_HEADERS,
  type GraphQLSSEOptions,
  type SSESubscriptionRequest,
  SSEError,
} from "@effect-gql/core"

/**
 * Options for Node.js SSE handler
 */
export interface NodeSSEOptions<R> extends GraphQLSSEOptions<R> {
  /**
   * Path for SSE connections.
   * @default "/graphql/stream"
   */
  readonly path?: string
}

/**
 * Create an SSE handler for Node.js HTTP server.
 *
 * This function creates a handler that can process SSE subscription requests.
 * It handles:
 * - Parsing the GraphQL subscription request from the HTTP body
 * - Setting up the SSE connection with proper headers
 * - Streaming subscription events to the client
 * - Detecting client disconnection and cleaning up
 *
 * @param schema - The GraphQL schema with subscription definitions
 * @param layer - Effect layer providing services required by resolvers
 * @param options - Optional lifecycle hooks and configuration
 * @returns A request handler function
 *
 * @example
 * ```typescript
 * import { createServer } from "node:http"
 * import { createSSEHandler } from "@effect-gql/node"
 *
 * const sseHandler = createSSEHandler(schema, serviceLayer, {
 *   path: "/graphql/stream",
 *   onConnect: (request, headers) => Effect.gen(function* () {
 *     const user = yield* AuthService.validateToken(headers.get("authorization"))
 *     return { user }
 *   }),
 * })
 *
 * const server = createServer((req, res) => {
 *   const url = new URL(req.url, `http://${req.headers.host}`)
 *   if (url.pathname === "/graphql/stream" && req.method === "POST") {
 *     sseHandler(req, res)
 *   } else {
 *     // Handle other requests...
 *   }
 * })
 *
 * server.listen(4000)
 * ```
 */
export const createSSEHandler = <R>(
  schema: GraphQLSchema,
  layer: Layer.Layer<R>,
  options?: NodeSSEOptions<R>
): (req: IncomingMessage, res: ServerResponse) => Promise<void> => {
  const sseHandler = makeGraphQLSSEHandler(schema, layer, options)

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Check Accept header for SSE support
    const accept = req.headers.accept ?? ""
    if (!accept.includes("text/event-stream") && !accept.includes("*/*")) {
      res.statusCode = 406
      res.end(JSON.stringify({
        errors: [{ message: "Client must accept text/event-stream" }],
      }))
      return
    }

    // Read the request body
    let body: string
    try {
      body = await readBody(req)
    } catch {
      res.statusCode = 400
      res.end(JSON.stringify({
        errors: [{ message: "Failed to read request body" }],
      }))
      return
    }

    // Parse the GraphQL request
    let request: SSESubscriptionRequest
    try {
      const parsed = JSON.parse(body)
      if (typeof parsed.query !== "string") {
        throw new Error("Missing query")
      }
      request = {
        query: parsed.query,
        variables: parsed.variables,
        operationName: parsed.operationName,
        extensions: parsed.extensions,
      }
    } catch {
      res.statusCode = 400
      res.end(JSON.stringify({
        errors: [{ message: "Invalid GraphQL request body" }],
      }))
      return
    }

    // Convert Node.js headers to web Headers
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) {
        if (Array.isArray(value)) {
          value.forEach((v) => headers.append(key, v))
        } else {
          headers.set(key, value)
        }
      }
    }

    // Set SSE headers
    res.writeHead(200, SSE_HEADERS)

    // Get the event stream
    const eventStream = sseHandler(request, headers)

    // Create the streaming effect
    const streamEffect = Effect.gen(function* () {
      // Track client disconnection
      const clientDisconnected = yield* Deferred.make<void, SSEError>()

      req.on("close", () => {
        Effect.runPromise(Deferred.succeed(clientDisconnected, undefined)).catch(() => {})
      })

      req.on("error", (error) => {
        Effect.runPromise(Deferred.fail(clientDisconnected, new SSEError({ cause: error }))).catch(() => {})
      })

      // Stream events to the client
      const runStream = Stream.runForEach(eventStream, (event) =>
        Effect.async<void, SSEError>((resume) => {
          const message = formatSSEMessage(event)
          res.write(message, (error) => {
            if (error) {
              resume(Effect.fail(new SSEError({ cause: error })))
            } else {
              resume(Effect.succeed(undefined))
            }
          })
        })
      )

      // Race between stream completion and client disconnection
      yield* Effect.race(
        runStream.pipe(
          Effect.catchAll((error) =>
            Effect.logWarning("SSE stream error", error)
          )
        ),
        Deferred.await(clientDisconnected)
      )
    })

    await Effect.runPromise(
      streamEffect.pipe(
        Effect.ensuring(Effect.sync(() => res.end())),
        Effect.catchAll(() => Effect.void)
      )
    )
  }
}

/**
 * Read the request body as a string.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString()))
    req.on("error", reject)
  })
}

/**
 * Create SSE middleware that can be used with the serve() function.
 *
 * This returns an object that can be used to integrate SSE subscriptions
 * with the HTTP server when using the custom subscription mode.
 *
 * @param schema - The GraphQL schema with subscription definitions
 * @param layer - Effect layer providing services required by resolvers
 * @param options - Optional lifecycle hooks and configuration
 *
 * @example
 * ```typescript
 * // In serve.ts with custom HTTP server setup
 * const sseServer = createSSEServer(schema, layer, { path: "/graphql/stream" })
 *
 * httpServer.on("request", (req, res) => {
 *   if (sseServer.shouldHandle(req)) {
 *     sseServer.handle(req, res)
 *   }
 * })
 * ```
 */
export const createSSEServer = <R>(
  schema: GraphQLSchema,
  layer: Layer.Layer<R>,
  options?: NodeSSEOptions<R>
): {
  /** Path this SSE server handles */
  readonly path: string
  /** Check if a request should be handled by this SSE server */
  shouldHandle: (req: IncomingMessage) => boolean
  /** Handle an SSE request */
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>
} => {
  const path = options?.path ?? "/graphql/stream"
  const handler = createSSEHandler(schema, layer, options)

  return {
    path,
    shouldHandle: (req: IncomingMessage) => {
      if (req.method !== "POST") return false
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
      return url.pathname === path
    },
    handle: handler,
  }
}
