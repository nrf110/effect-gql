import { Effect, Stream, Queue, Deferred, Layer } from "effect"
import { GraphQLSchema } from "graphql"
import {
  makeGraphQLWSHandler,
  type EffectWebSocket,
  type GraphQLWSOptions,
  WebSocketError,
  type CloseEvent,
} from "@effect-gql/core"
import type { Server, ServerWebSocket } from "bun"

/**
 * Data attached to each WebSocket connection
 */
interface WebSocketData {
  messageQueue: Queue.Queue<string>
  closedDeferred: Deferred.Deferred<CloseEvent, WebSocketError>
  effectSocket: EffectWebSocket
}

/**
 * Options for Bun WebSocket server
 */
export interface BunWSOptions<R> extends GraphQLWSOptions<R> {
  /**
   * Path for WebSocket connections.
   * @default "/graphql"
   */
  readonly path?: string
}

/**
 * Create WebSocket handlers for Bun.serve().
 *
 * Bun has built-in WebSocket support that's configured as part of Bun.serve().
 * This function returns the handlers needed to integrate GraphQL subscriptions.
 *
 * @param schema - The GraphQL schema with subscription definitions
 * @param layer - Effect layer providing services required by resolvers
 * @param options - Optional configuration and lifecycle hooks
 * @returns Object containing upgrade check and WebSocket handlers
 *
 * @example
 * ```typescript
 * const { upgrade, websocket } = createBunWSHandlers(schema, serviceLayer)
 *
 * Bun.serve({
 *   port: 4000,
 *   fetch(req, server) {
 *     // Try WebSocket upgrade first
 *     if (upgrade(req, server)) {
 *       return // Upgraded to WebSocket
 *     }
 *     // Handle HTTP requests...
 *   },
 *   websocket,
 * })
 * ```
 */
export const createBunWSHandlers = <R>(
  schema: GraphQLSchema,
  layer: Layer.Layer<R>,
  options?: BunWSOptions<R>
): {
  /**
   * Check if request should upgrade to WebSocket and perform upgrade.
   * Returns true if upgraded, false otherwise.
   */
  upgrade: (request: Request, server: Server<WebSocketData>) => boolean
  /**
   * WebSocket event handlers for Bun.serve()
   */
  websocket: {
    open: (ws: ServerWebSocket<WebSocketData>) => void
    message: (ws: ServerWebSocket<WebSocketData>, message: string | Buffer) => void
    close: (ws: ServerWebSocket<WebSocketData>, code: number, reason: string) => void
    error: (ws: ServerWebSocket<WebSocketData>, error: Error) => void
  }
} => {
  const path = options?.path ?? "/graphql"
  const handler = makeGraphQLWSHandler(schema, layer, options)

  // Track active connection handlers for cleanup
  const activeHandlers = new Map<ServerWebSocket<WebSocketData>, Promise<void>>()

  const upgrade = (request: Request, server: Server<WebSocketData>): boolean => {
    const url = new URL(request.url)

    // Check if this is a WebSocket upgrade request for the GraphQL path
    if (url.pathname !== path) {
      return false
    }

    const upgradeHeader = request.headers.get("upgrade")
    if (upgradeHeader?.toLowerCase() !== "websocket") {
      return false
    }

    // Check for correct subprotocol
    const protocol = request.headers.get("sec-websocket-protocol")
    if (!protocol?.includes("graphql-transport-ws")) {
      return false
    }

    // Perform upgrade - data will be set in open handler
    const success = server.upgrade(request, {
      data: {} as WebSocketData, // Will be populated in open handler
    })

    return success
  }

  const websocket = {
    open: (ws: ServerWebSocket<WebSocketData>) => {
      // Create Effect-based socket wrapper
      const setupEffect = Effect.gen(function* () {
        const messageQueue = yield* Queue.unbounded<string>()
        const closedDeferred = yield* Deferred.make<CloseEvent, WebSocketError>()

        const effectSocket: EffectWebSocket = {
          protocol: ws.data?.effectSocket?.protocol || "graphql-transport-ws",

          send: (data: string) =>
            Effect.try({
              try: () => {
                ws.send(data)
              },
              catch: (error) => new WebSocketError({ cause: error }),
            }),

          close: (code?: number, reason?: string) =>
            Effect.sync(() => {
              ws.close(code ?? 1000, reason ?? "")
            }),

          messages: Stream.fromQueue(messageQueue).pipe(Stream.catchAll(() => Stream.empty)),

          closed: Deferred.await(closedDeferred),
        }

        // Store in WebSocket data
        ws.data = {
          messageQueue,
          closedDeferred,
          effectSocket,
        }

        return effectSocket
      })

      // Run setup and handler
      const handlerPromise = Effect.runPromise(
        setupEffect.pipe(
          Effect.flatMap((effectSocket) => handler(effectSocket)),
          Effect.catchAllCause(() => Effect.void)
        )
      )

      activeHandlers.set(ws, handlerPromise)
    },

    message: (ws: ServerWebSocket<WebSocketData>, message: string | Buffer) => {
      const data = ws.data as WebSocketData | undefined
      if (data?.messageQueue) {
        const messageStr = typeof message === "string" ? message : message.toString()
        Effect.runPromise(Queue.offer(data.messageQueue, messageStr)).catch(() => {
          // Queue might be shutdown
        })
      }
    },

    close: (ws: ServerWebSocket<WebSocketData>, code: number, reason: string) => {
      const data = ws.data as WebSocketData | undefined
      if (data) {
        Effect.runPromise(
          Effect.all([
            Queue.shutdown(data.messageQueue),
            Deferred.succeed(data.closedDeferred, { code, reason }),
          ])
        ).catch(() => {
          // Already completed
        })
      }
      activeHandlers.delete(ws)
    },

    error: (ws: ServerWebSocket<WebSocketData>, error: Error) => {
      const data = ws.data as WebSocketData | undefined
      if (data) {
        Effect.runPromise(
          Deferred.fail(data.closedDeferred, new WebSocketError({ cause: error }))
        ).catch(() => {
          // Already completed
        })
      }
    },
  }

  return { upgrade, websocket }
}

/**
 * Convert a Bun ServerWebSocket to an EffectWebSocket.
 *
 * This is a lower-level utility for custom WebSocket handling.
 * Most users should use createBunWSHandlers() instead.
 *
 * @param ws - The Bun ServerWebSocket instance
 * @returns An EffectWebSocket that can be used with makeGraphQLWSHandler
 */
export const toBunEffectWebSocket = (
  ws: ServerWebSocket<WebSocketData>
): Effect.Effect<EffectWebSocket, never, never> =>
  Effect.gen(function* () {
    const messageQueue = yield* Queue.unbounded<string>()
    const closedDeferred = yield* Deferred.make<CloseEvent, WebSocketError>()

    const effectSocket: EffectWebSocket = {
      protocol: "graphql-transport-ws",

      send: (data: string) =>
        Effect.try({
          try: () => {
            ws.send(data)
          },
          catch: (error) => new WebSocketError({ cause: error }),
        }),

      close: (code?: number, reason?: string) =>
        Effect.sync(() => {
          ws.close(code ?? 1000, reason ?? "")
        }),

      messages: Stream.fromQueue(messageQueue).pipe(Stream.catchAll(() => Stream.empty)),

      closed: Deferred.await(closedDeferred),
    }

    // Store in WebSocket data for event handlers
    ws.data = {
      messageQueue,
      closedDeferred,
      effectSocket,
    }

    return effectSocket
  })
