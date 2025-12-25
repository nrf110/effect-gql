import { Effect, Layer, Runtime, Stream, Queue, Fiber, Option, Deferred, Scope } from "effect"
import { GraphQLSchema, subscribe, ExecutionResult, GraphQLError } from "graphql"
import { makeServer, type ServerOptions, type Context as WSContext } from "graphql-ws"
import type { GraphQLEffectContext } from "../builder/types"
import type {
  EffectWebSocket,
  GraphQLWSOptions,
  ConnectionContext,
  CloseEvent,
  WebSocketError,
} from "./ws-types"

/**
 * Extra context passed through graphql-ws.
 * This is the `extra` field in graphql-ws Context.
 */
interface WSExtra<R> {
  socket: EffectWebSocket
  runtime: Runtime.Runtime<R>
  connectionParams: Record<string, unknown>
}

/**
 * Create a WebSocket handler for GraphQL subscriptions using the graphql-ws protocol.
 *
 * This function creates a handler that can be used with any WebSocket implementation
 * that conforms to the EffectWebSocket interface. Platform packages (node, bun, express)
 * provide adapters that convert their native WebSocket to EffectWebSocket.
 *
 * The handler:
 * - Uses the graphql-ws protocol for client communication
 * - Creates an Effect runtime from the provided layer for each connection
 * - Executes subscriptions using GraphQL's subscribe() function
 * - Properly cleans up resources when connections close
 *
 * @param schema - The GraphQL schema with subscription definitions
 * @param layer - Effect layer providing services required by resolvers
 * @param options - Optional lifecycle hooks for connection/subscription events
 * @returns A function that handles individual WebSocket connections
 *
 * @example
 * ```typescript
 * import { makeGraphQLWSHandler } from "@effect-gql/core"
 *
 * const handler = makeGraphQLWSHandler(schema, serviceLayer, {
 *   onConnect: (params) => Effect.gen(function* () {
 *     const user = yield* AuthService.validateToken(params.authToken)
 *     return { user }
 *   }),
 * })
 *
 * // In platform-specific code:
 * const effectSocket = toEffectWebSocket(rawWebSocket)
 * await Effect.runPromise(handler(effectSocket))
 * ```
 */
export const makeGraphQLWSHandler = <R>(
  schema: GraphQLSchema,
  layer: Layer.Layer<R>,
  options?: GraphQLWSOptions<R>
): (socket: EffectWebSocket) => Effect.Effect<void, never, never> => {
  // Create the graphql-ws server options
  const serverOptions: ServerOptions<Record<string, unknown>, WSExtra<R>> = {
    schema,

    // Context factory - called for each operation
    context: async (ctx): Promise<GraphQLEffectContext<R> & Record<string, unknown>> => {
      const extra = ctx.extra as WSExtra<R>
      return {
        runtime: extra.runtime,
        ...extra.connectionParams,
      }
    },

    // Execute subscriptions
    subscribe: async (args) => {
      const result = await subscribe(args)
      return result
    },

    // Connection init handler
    onConnect: options?.onConnect
      ? async (ctx) => {
          const extra = ctx.extra as WSExtra<R>
          try {
            const result = await Runtime.runPromise(extra.runtime)(
              options.onConnect!(ctx.connectionParams ?? {})
            )
            if (typeof result === "object" && result !== null) {
              // Merge connection result into connectionParams for later use
              Object.assign(extra.connectionParams, result)
            }
            return result !== false
          } catch {
            return false
          }
        }
      : undefined,

    // Disconnect handler
    onDisconnect: options?.onDisconnect
      ? async (ctx) => {
          const extra = ctx.extra as WSExtra<R>
          const connectionCtx: ConnectionContext<R> = {
            runtime: extra.runtime,
            connectionParams: extra.connectionParams,
            socket: extra.socket,
          }
          await Runtime.runPromise(extra.runtime)(
            options.onDisconnect!(connectionCtx)
          ).catch(() => {
            // Ignore cleanup errors
          })
        }
      : undefined,

    // Subscribe handler (per-subscription)
    onSubscribe: options?.onSubscribe
      ? async (ctx, msg) => {
          const extra = ctx.extra as WSExtra<R>
          const connectionCtx: ConnectionContext<R> = {
            runtime: extra.runtime,
            connectionParams: extra.connectionParams,
            socket: extra.socket,
          }
          await Runtime.runPromise(extra.runtime)(
            options.onSubscribe!(connectionCtx, {
              id: msg.id,
              payload: {
                query: msg.payload.query,
                variables: msg.payload.variables ?? undefined,
                operationName: msg.payload.operationName ?? undefined,
                extensions: msg.payload.extensions ?? undefined,
              },
            })
          )
        }
      : undefined,

    // Complete handler
    onComplete: options?.onComplete
      ? async (ctx, msg) => {
          const extra = ctx.extra as WSExtra<R>
          const connectionCtx: ConnectionContext<R> = {
            runtime: extra.runtime,
            connectionParams: extra.connectionParams,
            socket: extra.socket,
          }
          await Runtime.runPromise(extra.runtime)(
            options.onComplete!(connectionCtx, { id: msg.id })
          ).catch(() => {
            // Ignore cleanup errors
          })
        }
      : undefined,

    // Error handler
    onError: options?.onError
      ? async (ctx, _msg, errors) => {
          const extra = ctx.extra as WSExtra<R>
          const connectionCtx: ConnectionContext<R> = {
            runtime: extra.runtime,
            connectionParams: extra.connectionParams,
            socket: extra.socket,
          }
          await Runtime.runPromise(extra.runtime)(
            options.onError!(connectionCtx, errors)
          ).catch(() => {
            // Ignore error handler errors
          })
        }
      : undefined,
  }

  const wsServer = makeServer(serverOptions)

  // Return the connection handler
  return (socket: EffectWebSocket): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      // Create a runtime from the layer for this connection
      const runtime = yield* Effect.provide(Effect.runtime<R>(), layer)

      // Extra context for this connection
      const extra: WSExtra<R> = {
        socket,
        runtime,
        connectionParams: {},
      }

      // Create message queue for bridging Stream to callback
      const messageQueue = yield* Queue.unbounded<string>()
      const closedDeferred = yield* Deferred.make<CloseEvent, WebSocketError>()

      // Fork a fiber to consume socket messages and push to queue
      const messageFiber = yield* Effect.fork(
        Stream.runForEach(socket.messages, (msg) => Queue.offer(messageQueue, msg)).pipe(
          Effect.catchAll((error) => Deferred.fail(closedDeferred, error))
        )
      )

      // Fork a fiber to handle socket close
      const closeFiber = yield* Effect.fork(
        socket.closed.pipe(
          Effect.tap((event) => Deferred.succeed(closedDeferred, event)),
          Effect.catchAll((error) => Deferred.fail(closedDeferred, error))
        )
      )

      // Create the graphql-ws socket adapter
      let messageCallback: ((message: string) => Promise<void>) | null = null

      const graphqlWsSocket = {
        protocol: socket.protocol,

        send: (data: string) =>
          Runtime.runPromise(runtime)(
            socket.send(data).pipe(
              Effect.catchAll((error) => Effect.logError("WebSocket send error", error))
            )
          ),

        close: (code?: number, reason?: string) => {
          Runtime.runPromise(runtime)(socket.close(code, reason)).catch(() => {
            // Ignore close errors
          })
        },

        onMessage: (cb: (message: string) => Promise<void>) => {
          messageCallback = cb
        },

        onPong: (_payload: Record<string, unknown> | undefined) => {
          // Pong handling - can be used for keepalive
        },
      }

      // Open the connection with graphql-ws
      const closedHandler = wsServer.opened(graphqlWsSocket, extra)

      // Fork a fiber to process messages from queue
      const processMessagesFiber = yield* Effect.fork(
        Effect.gen(function* () {
          while (true) {
            const message = yield* Queue.take(messageQueue)
            if (messageCallback) {
              yield* Effect.tryPromise({
                try: () => messageCallback!(message),
                catch: (error) => error,
              }).pipe(Effect.catchAll(() => Effect.void))
            }
          }
        })
      )

      // Wait for connection to close
      yield* Deferred.await(closedDeferred).pipe(
        Effect.catchAll(() => Effect.succeed({ code: 1000, reason: "Error" }))
      )

      // Cleanup
      closedHandler(1000, "Connection closed")
      yield* Fiber.interrupt(messageFiber)
      yield* Fiber.interrupt(closeFiber)
      yield* Fiber.interrupt(processMessagesFiber)
      yield* Queue.shutdown(messageQueue)
    }).pipe(
      Effect.catchAllCause(() => Effect.void),
      Effect.scoped
    )
}

/**
 * Type guard to check if a value is an AsyncIterator (subscription result)
 */
function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value
  )
}
