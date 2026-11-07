import { Effect, Layer } from "effect"
import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocket, WebSocketServer } from "ws"
import { GraphQLSchema } from "graphql"
import {
  makeGraphQLWSHandler,
  toEffectWebSocketFromWs,
  type EffectWebSocket,
  type GraphQLWSOptions,
} from "@effect-gql/core"

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
export const toEffectWebSocket = (ws: WebSocket): EffectWebSocket => toEffectWebSocketFromWs(ws)

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
export const createGraphQLWSServer = <R, LE = never>(
  schema: GraphQLSchema,
  layer: Layer.Layer<R, LE>,
  options?: NodeWSOptions<R>
): {
  /** The underlying WebSocketServer instance */
  wss: WebSocketServer
  /** Handle HTTP upgrade requests */
  handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  /** Close the WebSocket server */
  close: () => Promise<void>
} => {
  const wss = new WebSocketServer({ noServer: true })
  const path = options?.path ?? "/graphql"

  // Create the handler from core
  const handler = makeGraphQLWSHandler(schema, layer, options)

  // Keep handlers until their connection scopes have finished finalizing.
  const activeHandlers = new Map<WebSocket, Promise<void>>()
  let closePromise: Promise<void> | undefined

  wss.on("connection", (ws, _request) => {
    if (closePromise) {
      ws.close(1001, "Server shutting down")
      return
    }

    const effectSocket = toEffectWebSocket(ws)

    // Run the handler
    const handlerPromise = Effect.runPromise(
      handler(effectSocket).pipe(
        Effect.catchCause((cause) => Effect.logError("GraphQL WebSocket handler error", cause))
      )
    ).finally(() => {
      activeHandlers.delete(ws)
    })
    activeHandlers.set(ws, handlerPromise)
  })

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (closePromise) {
      socket.destroy()
      return
    }

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

  const close = () => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      const pending = Array.from(activeHandlers.values())
      for (const ws of activeHandlers.keys()) {
        ws.close(1001, "Server shutting down")
      }

      try {
        await new Promise<void>((resolve, reject) => {
          wss.close((error) => {
            if (error) reject(error)
            else resolve()
          })
        })
      } finally {
        await Promise.all(pending)
      }
    })()
    return closePromise
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
export const attachWebSocketToServer = <R, LE = never>(
  server: Server,
  schema: GraphQLSchema,
  layer: Layer.Layer<R, LE>,
  options?: NodeWSOptions<R>
): { close: () => Promise<void> } => {
  const { handleUpgrade, close } = createGraphQLWSServer(schema, layer, options)

  server.on("upgrade", (request, socket, head) => {
    handleUpgrade(request, socket as Duplex, head)
  })

  return { close }
}
