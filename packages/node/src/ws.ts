import { Effect, Stream, Queue, Deferred, Fiber, Layer, Runtime } from "effect"
import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocket, WebSocketServer } from "ws"
import { GraphQLSchema } from "graphql"
import {
  makeGraphQLWSHandler,
  type EffectWebSocket,
  type GraphQLWSOptions,
  WebSocketError,
  type CloseEvent,
} from "@effect-graphql/core"

/**
 * Options for Node.js WebSocket server
 */
export interface NodeWSOptions<R> extends GraphQLWSOptions<R> {
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
 *
 * @example
 * ```typescript
 * wss.on("connection", (ws, req) => {
 *   const effectSocket = toEffectWebSocket(ws)
 *   Effect.runPromise(handler(effectSocket))
 * })
 * ```
 */
export const toEffectWebSocket = (ws: WebSocket): EffectWebSocket => {
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
 * Create a WebSocket server that handles GraphQL subscriptions.
 *
 * This function creates a WebSocketServer and returns utilities for
 * integrating it with an HTTP server via the upgrade event.
 *
 * @param schema - The GraphQL schema with subscription definitions
 * @param layer - Effect layer providing services required by resolvers
 * @param options - Optional configuration and lifecycle hooks
 * @returns Object containing the WebSocketServer and handlers
 *
 * @example
 * ```typescript
 * const httpServer = createServer(requestHandler)
 * const { wss, handleUpgrade } = createGraphQLWSServer(schema, serviceLayer)
 *
 * httpServer.on("upgrade", (request, socket, head) => {
 *   if (request.url === "/graphql") {
 *     handleUpgrade(request, socket, head)
 *   }
 * })
 *
 * httpServer.listen(4000)
 * ```
 */
export const createGraphQLWSServer = <R>(
  schema: GraphQLSchema,
  layer: Layer.Layer<R>,
  options?: NodeWSOptions<R>
): {
  /** The underlying WebSocketServer instance */
  wss: WebSocketServer
  /** Handle HTTP upgrade requests */
  handleUpgrade: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ) => void
  /** Close the WebSocket server */
  close: () => Promise<void>
} => {
  const wss = new WebSocketServer({ noServer: true })
  const path = options?.path ?? "/graphql"

  // Create the handler from core
  const handler = makeGraphQLWSHandler(schema, layer, options)

  // Track active connections for cleanup
  const activeConnections = new Set<WebSocket>()

  wss.on("connection", (ws, _request) => {
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

  return { wss, handleUpgrade, close }
}

/**
 * Attach WebSocket subscription support to an existing HTTP server.
 *
 * This is a convenience function that creates a GraphQL WebSocket server
 * and attaches it to an HTTP server's upgrade event.
 *
 * @param server - The HTTP server to attach to
 * @param schema - The GraphQL schema with subscription definitions
 * @param layer - Effect layer providing services required by resolvers
 * @param options - Optional configuration and lifecycle hooks
 * @returns Cleanup function to close the WebSocket server
 *
 * @example
 * ```typescript
 * const httpServer = createServer(requestHandler)
 *
 * const cleanup = attachWebSocketToServer(httpServer, schema, serviceLayer, {
 *   path: "/graphql",
 * })
 *
 * httpServer.listen(4000)
 *
 * // Later, to cleanup:
 * await cleanup()
 * ```
 */
export const attachWebSocketToServer = <R>(
  server: Server,
  schema: GraphQLSchema,
  layer: Layer.Layer<R>,
  options?: NodeWSOptions<R>
): { close: () => Promise<void> } => {
  const { handleUpgrade, close } = createGraphQLWSServer(schema, layer, options)

  server.on("upgrade", (request, socket, head) => {
    handleUpgrade(request, socket as Duplex, head)
  })

  return { close }
}
