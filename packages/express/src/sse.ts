import { Effect, Layer, Stream, Deferred } from "effect"
import type { Request, Response, NextFunction, RequestHandler } from "express"
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
 * Options for Express SSE middleware
 */
export interface ExpressSSEOptions<R> extends GraphQLSSEOptions<R> {
  /**
   * Path for SSE connections.
   * @default "/graphql/stream"
   */
  readonly path?: string
}

/**
 * Create an Express middleware for SSE subscriptions.
 *
 * This middleware handles POST requests to the configured path and streams
 * GraphQL subscription events as Server-Sent Events.
 *
 * @param schema - The GraphQL schema with subscription definitions
 * @param layer - Effect layer providing services required by resolvers
 * @param options - Optional lifecycle hooks and configuration
 * @returns An Express middleware function
 *
 * @example
 * ```typescript
 * import express from "express"
 * import { createServer } from "node:http"
 * import { toMiddleware, sseMiddleware, attachWebSocket } from "@effect-gql/express"
 * import { makeGraphQLRouter } from "@effect-gql/core"
 *
 * const app = express()
 * app.use(express.json())
 *
 * // Regular GraphQL endpoint
 * const router = makeGraphQLRouter(schema, Layer.empty, { graphiql: true })
 * app.use(toMiddleware(router, Layer.empty))
 *
 * // SSE subscriptions endpoint
 * app.use(sseMiddleware(schema, Layer.empty, {
 *   path: "/graphql/stream",
 *   onConnect: (request, headers) => Effect.gen(function* () {
 *     const token = headers.get("authorization")
 *     const user = yield* AuthService.validateToken(token)
 *     return { user }
 *   }),
 * }))
 *
 * const server = createServer(app)
 *
 * // Optional: Also attach WebSocket subscriptions
 * attachWebSocket(server, schema, Layer.empty)
 *
 * server.listen(4000)
 * ```
 */
export const sseMiddleware = <R>(
  schema: GraphQLSchema,
  layer: Layer.Layer<R>,
  options?: ExpressSSEOptions<R>
): RequestHandler => {
  const path = options?.path ?? "/graphql/stream"
  const sseHandler = makeGraphQLSSEHandler(schema, layer, options)

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Check if this request is for our path
    if (req.path !== path) {
      next()
      return
    }

    // Only handle POST requests
    if (req.method !== "POST") {
      next()
      return
    }

    // Check Accept header for SSE support
    const accept = req.headers.accept ?? ""
    if (!accept.includes("text/event-stream") && !accept.includes("*/*")) {
      res.status(406).json({
        errors: [{ message: "Client must accept text/event-stream" }],
      })
      return
    }

    // Parse the GraphQL request from the body
    let subscriptionRequest: SSESubscriptionRequest
    try {
      const body = req.body as Record<string, unknown>
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
      res.status(400).json({
        errors: [{ message: "Invalid GraphQL request body" }],
      })
      return
    }

    // Convert Express headers to web Headers
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
    const eventStream = sseHandler(subscriptionRequest, headers)

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
 * Create a standalone Express route handler for SSE subscriptions.
 *
 * Use this if you want more control over routing than the middleware provides.
 *
 * @param schema - The GraphQL schema with subscription definitions
 * @param layer - Effect layer providing services required by resolvers
 * @param options - Optional lifecycle hooks and configuration
 * @returns An Express request handler
 *
 * @example
 * ```typescript
 * import express from "express"
 * import { createSSEHandler } from "@effect-gql/express"
 *
 * const app = express()
 * app.use(express.json())
 *
 * const sseHandler = createSSEHandler(schema, Layer.empty)
 * app.post("/graphql/stream", sseHandler)
 *
 * app.listen(4000)
 * ```
 */
export const createSSEHandler = <R>(
  schema: GraphQLSchema,
  layer: Layer.Layer<R>,
  options?: Omit<ExpressSSEOptions<R>, "path">
): RequestHandler => {
  const sseHandler = makeGraphQLSSEHandler(schema, layer, options)

  return async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    // Check Accept header for SSE support
    const accept = req.headers.accept ?? ""
    if (!accept.includes("text/event-stream") && !accept.includes("*/*")) {
      res.status(406).json({
        errors: [{ message: "Client must accept text/event-stream" }],
      })
      return
    }

    // Parse the GraphQL request from the body
    let subscriptionRequest: SSESubscriptionRequest
    try {
      const body = req.body as Record<string, unknown>
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
      res.status(400).json({
        errors: [{ message: "Invalid GraphQL request body" }],
      })
      return
    }

    // Convert Express headers to web Headers
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
    const eventStream = sseHandler(subscriptionRequest, headers)

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
