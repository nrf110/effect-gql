import { Effect, Stream, Queue, Deferred, Layer } from "effect"
import type { Server } from "node:http"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocket, WebSocketServer } from "ws"
import { GraphQLSchema } from "graphql"
import {
  makeGraphQLWSHandler,
  type EffectWebSocket,
  type GraphQLWSOptions,
  WebSocketError,
  type CloseEvent,
} from "@effect-gql/core"

/**
 * Options for Express WebSocket server
 */
export interface ExpressWSOptions<R> extends GraphQLWSOptions<R> {
  /**
   * Path for WebSocket connections.
   * @default "/graphql"
   */
  readonly path?: string
}

/**
 * Convert a Node.js WebSocket (from 'ws' library) to an EffectWebSocket.
 *
 * This creates an Effect-based wrapper around the ws WebSocket instance,
 * providing a Stream for incoming messages and Effect-based send/close operations.
 *
 * @param ws - The WebSocket instance from the 'ws' library
 * @returns An EffectWebSocket that can be used with makeGraphQLWSHandler
 */
const toEffectWebSocket = (ws: WebSocket): EffectWebSocket => {
  // Create the message stream using a queue
  const messagesEffect = Effect.gen(function* () {
    const queue = yield* Queue.unbounded<string>()
    const closed = yield* Deferred.make<CloseEvent, WebSocketError>()

    // Set up message listener
    ws.on("message", (data) => {
      const message = data.toString()
      Effect.runPromise(Queue.offer(queue, message)).catch(() => {
        // Queue might be shutdown
      })
    })

    // Set up error listener
    ws.on("error", (error) => {
      Effect.runPromise(
        Deferred.fail(closed, new WebSocketError({ cause: error }))
      ).catch(() => {
        // Already completed
      })
    })

    // Set up close listener
    ws.on("close", (code, reason) => {
      Effect.runPromise(
        Queue.shutdown(queue).pipe(
          Effect.andThen(
            Deferred.succeed(closed, { code, reason: reason.toString() })
          )
        )
      ).catch(() => {
        // Already completed
      })
    })

    return { queue, closed }
  })

  // Create the message stream
  const messages: Stream.Stream<string, WebSocketError> = Stream.unwrap(
    messagesEffect.pipe(
      Effect.map(({ queue }) =>
        Stream.fromQueue(queue).pipe(
          Stream.catchAll(() => Stream.empty)
        )
      )
    )
  )

  return {
    protocol: ws.protocol || "graphql-transport-ws",

    send: (data: string) =>
      Effect.async<void, WebSocketError>((resume) => {
        ws.send(data, (error) => {
          if (error) {
            resume(Effect.fail(new WebSocketError({ cause: error })))
          } else {
            resume(Effect.succeed(undefined))
          }
        })
      }),

    close: (code?: number, reason?: string) =>
      Effect.sync(() => {
        ws.close(code ?? 1000, reason ?? "")
      }),

    messages,

    closed: Effect.async<CloseEvent, WebSocketError>((resume) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resume(Effect.succeed({ code: 1000, reason: "" }))
        return
      }

      const onClose = (code: number, reason: Buffer) => {
        cleanup()
        resume(Effect.succeed({ code, reason: reason.toString() }))
      }

      const onError = (error: Error) => {
        cleanup()
        resume(Effect.fail(new WebSocketError({ cause: error })))
      }

      const cleanup = () => {
        ws.removeListener("close", onClose)
        ws.removeListener("error", onError)
      }

      ws.on("close", onClose)
      ws.on("error", onError)

      return Effect.sync(cleanup)
    }),
  }
}

/**
 * Attach WebSocket subscription support to an Express HTTP server.
 *
 * Since Express middleware doesn't own the HTTP server, this function
 * must be called separately with the HTTP server instance to enable
 * WebSocket subscriptions.
 *
 * @param server - The HTTP server running the Express app
 * @param schema - The GraphQL schema with subscription definitions
 * @param layer - Effect layer providing services required by resolvers
 * @param options - Optional configuration and lifecycle hooks
 * @returns Object with cleanup function
 *
 * @example
 * ```typescript
 * import express from "express"
 * import { createServer } from "node:http"
 * import { toMiddleware, attachWebSocket } from "@effect-gql/express"
 * import { makeGraphQLRouter, GraphQLSchemaBuilder } from "@effect-gql/core"
 * import { Layer, Effect, Stream } from "effect"
 * import * as S from "effect/Schema"
 *
 * // Build schema with subscriptions
 * const schema = GraphQLSchemaBuilder.empty
 *   .query("hello", { type: S.String, resolve: () => Effect.succeed("world") })
 *   .subscription("counter", {
 *     type: S.Int,
 *     subscribe: () => Effect.succeed(Stream.fromIterable([1, 2, 3]))
 *   })
 *   .buildSchema()
 *
 * // Create Express app with middleware
 * const app = express()
 * app.use(express.json())
 * const router = makeGraphQLRouter(schema, Layer.empty, { graphiql: true })
 * app.use(toMiddleware(router, Layer.empty))
 *
 * // Create HTTP server and attach WebSocket support
 * const server = createServer(app)
 * const ws = attachWebSocket(server, schema, Layer.empty, {
 *   path: "/graphql"
 * })
 *
 * server.listen(4000, () => {
 *   console.log("Server running on http://localhost:4000")
 *   console.log("WebSocket subscriptions available at ws://localhost:4000/graphql")
 * })
 *
 * // Cleanup on shutdown
 * process.on("SIGINT", async () => {
 *   await ws.close()
 *   server.close()
 * })
 * ```
 */
export const attachWebSocket = <R>(
  server: Server,
  schema: GraphQLSchema,
  layer: Layer.Layer<R>,
  options?: ExpressWSOptions<R>
): { close: () => Promise<void> } => {
  const wss = new WebSocketServer({ noServer: true })
  const path = options?.path ?? "/graphql"

  // Create the handler from core
  const handler = makeGraphQLWSHandler(schema, layer, options)

  // Track active connections for cleanup
  const activeConnections = new Set<WebSocket>()

  wss.on("connection", (ws) => {
    activeConnections.add(ws)

    const effectSocket = toEffectWebSocket(ws)

    // Run the handler
    Effect.runPromise(handler(effectSocket))
      .catch((error) => {
        console.error("GraphQL WebSocket handler error:", error)
      })
      .finally(() => {
        activeConnections.delete(ws)
      })
  })

  const handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ) => {
    // Check if this is the GraphQL WebSocket path
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`)
    if (url.pathname !== path) {
      socket.destroy()
      return
    }

    // Check for correct WebSocket subprotocol
    const protocol = request.headers["sec-websocket-protocol"]
    if (!protocol?.includes("graphql-transport-ws")) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n")
      socket.destroy()
      return
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request)
    })
  }

  // Attach upgrade handler to server
  server.on("upgrade", (request, socket, head) => {
    handleUpgrade(request, socket as Duplex, head)
  })

  const close = async () => {
    // Close all active connections
    for (const ws of activeConnections) {
      ws.close(1001, "Server shutting down")
    }
    activeConnections.clear()

    // Close the WebSocket server
    return new Promise<void>((resolve, reject) => {
      wss.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  return { close }
}
