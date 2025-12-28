import { Effect, Layer, Runtime, Stream, Queue, Fiber, Deferred } from "effect"
import { GraphQLSchema, subscribe, GraphQLError } from "graphql"
import { makeServer, type ServerOptions } from "graphql-ws"
import type { GraphQLEffectContext } from "../builder/types"
import type {
  EffectWebSocket,
  GraphQLWSOptions,
  ConnectionContext,
  CloseEvent,
  WebSocketError,
} from "./ws-types"
import { validateComplexity, type FieldComplexityMap } from "./complexity"

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
 * Create a ConnectionContext from WSExtra for use in lifecycle hooks.
 */
const createConnectionContext = <R>(extra: WSExtra<R>): ConnectionContext<R> => ({
  runtime: extra.runtime,
  connectionParams: extra.connectionParams,
  socket: extra.socket,
})

/**
 * Create the onConnect handler for graphql-ws.
 */
const makeOnConnectHandler = <R>(
  options: GraphQLWSOptions<R> | undefined
): ServerOptions<Record<string, unknown>, WSExtra<R>>["onConnect"] => {
  if (!options?.onConnect) return undefined

  return async (ctx) => {
    const extra = ctx.extra as WSExtra<R>
    try {
      const result = await Runtime.runPromise(extra.runtime)(
        options.onConnect!(ctx.connectionParams ?? {})
      )
      if (typeof result === "object" && result !== null) {
        Object.assign(extra.connectionParams, result)
      }
      return result !== false
    } catch {
      return false
    }
  }
}

/**
 * Create the onDisconnect handler for graphql-ws.
 */
const makeOnDisconnectHandler = <R>(
  options: GraphQLWSOptions<R> | undefined
): ServerOptions<Record<string, unknown>, WSExtra<R>>["onDisconnect"] => {
  if (!options?.onDisconnect) return undefined

  return async (ctx) => {
    const extra = ctx.extra as WSExtra<R>
    await Runtime.runPromise(extra.runtime)(
      options.onDisconnect!(createConnectionContext(extra))
    ).catch(() => {
      // Ignore cleanup errors
    })
  }
}

/**
 * Create the onSubscribe handler for graphql-ws with complexity validation.
 */
const makeOnSubscribeHandler = <R>(
  options: GraphQLWSOptions<R> | undefined,
  schema: GraphQLSchema,
  complexityConfig: GraphQLWSOptions<R>["complexity"],
  fieldComplexities: FieldComplexityMap
): ServerOptions<Record<string, unknown>, WSExtra<R>>["onSubscribe"] => {
  // graphql-ws 6.0: signature changed from (ctx, msg) to (ctx, id, payload)
  return async (ctx, id, payload) => {
    const extra = ctx.extra as WSExtra<R>
    const connectionCtx = createConnectionContext(extra)

    // Validate complexity if configured
    if (complexityConfig) {
      const validationEffect = validateComplexity(
        payload.query,
        payload.operationName ?? undefined,
        payload.variables ?? undefined,
        schema,
        fieldComplexities,
        complexityConfig
      ).pipe(
        Effect.catchAll((error) => {
          if (error._tag === "ComplexityLimitExceededError") {
            throw new GraphQLError(error.message, {
              extensions: {
                code: "COMPLEXITY_LIMIT_EXCEEDED",
                limitType: error.limitType,
                limit: error.limit,
                actual: error.actual,
              },
            })
          }
          return Effect.logWarning("Complexity analysis failed for subscription", error)
        })
      )

      await Effect.runPromise(validationEffect)
    }

    // Call user's onSubscribe hook if provided
    if (options?.onSubscribe) {
      await Runtime.runPromise(extra.runtime)(
        options.onSubscribe(connectionCtx, {
          id,
          payload: {
            query: payload.query,
            variables: payload.variables ?? undefined,
            operationName: payload.operationName ?? undefined,
            extensions: payload.extensions ?? undefined,
          },
        })
      )
    }
  }
}

/**
 * Create the onComplete handler for graphql-ws.
 */
const makeOnCompleteHandler = <R>(
  options: GraphQLWSOptions<R> | undefined
): ServerOptions<Record<string, unknown>, WSExtra<R>>["onComplete"] => {
  if (!options?.onComplete) return undefined

  // graphql-ws 6.0: signature changed from (ctx, msg) to (ctx, id, payload)
  return async (ctx, id, _payload) => {
    const extra = ctx.extra as WSExtra<R>
    await Runtime.runPromise(extra.runtime)(
      options.onComplete!(createConnectionContext(extra), { id })
    ).catch(() => {
      // Ignore cleanup errors
    })
  }
}

/**
 * Create the onError handler for graphql-ws.
 */
const makeOnErrorHandler = <R>(
  options: GraphQLWSOptions<R> | undefined
): ServerOptions<Record<string, unknown>, WSExtra<R>>["onError"] => {
  if (!options?.onError) return undefined

  // graphql-ws 6.0: signature changed from (ctx, msg, errors) to (ctx, id, payload, errors)
  return async (ctx, _id, _payload, errors) => {
    const extra = ctx.extra as WSExtra<R>
    await Runtime.runPromise(extra.runtime)(
      options.onError!(createConnectionContext(extra), errors)
    ).catch(() => {
      // Ignore error handler errors
    })
  }
}

/**
 * Create a graphql-ws compatible socket adapter from an EffectWebSocket.
 */
const createGraphqlWsSocketAdapter = <R>(socket: EffectWebSocket, runtime: Runtime.Runtime<R>) => {
  let messageCallback: ((message: string) => Promise<void>) | null = null

  return {
    adapter: {
      protocol: socket.protocol,

      send: (data: string) =>
        Runtime.runPromise(runtime)(
          socket
            .send(data)
            .pipe(Effect.catchAll((error) => Effect.logError("WebSocket send error", error)))
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
    },
    dispatchMessage: async (message: string) => {
      if (messageCallback) {
        await messageCallback(message)
      }
    },
  }
}

/**
 * Run the connection lifecycle - manages message queue, fibers, and cleanup.
 */
const runConnectionLifecycle = <R>(
  socket: EffectWebSocket,
  wsServer: ReturnType<typeof makeServer<Record<string, unknown>, WSExtra<R>>>,
  extra: WSExtra<R>
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    // Create message queue for bridging Stream to callback
    const messageQueue = yield* Queue.unbounded<string>()
    const closedDeferred = yield* Deferred.make<CloseEvent, WebSocketError>()

    // Fork fiber to consume socket messages and push to queue
    const messageFiber = yield* Effect.fork(
      Stream.runForEach(socket.messages, (msg) => Queue.offer(messageQueue, msg)).pipe(
        Effect.catchAll((error) => Deferred.fail(closedDeferred, error))
      )
    )

    // Fork fiber to handle socket close
    const closeFiber = yield* Effect.fork(
      socket.closed.pipe(
        Effect.tap((event) => Deferred.succeed(closedDeferred, event)),
        Effect.catchAll((error) => Deferred.fail(closedDeferred, error))
      )
    )

    // Create the graphql-ws socket adapter
    const { adapter, dispatchMessage } = createGraphqlWsSocketAdapter(socket, extra.runtime)

    // Open the connection with graphql-ws
    const closedHandler = wsServer.opened(adapter, extra)

    // Fork fiber to process messages from queue
    const processMessagesFiber = yield* Effect.fork(
      Effect.gen(function* () {
        while (true) {
          const message = yield* Queue.take(messageQueue)
          yield* Effect.tryPromise({
            try: () => dispatchMessage(message),
            catch: (error) => error,
          }).pipe(Effect.catchAll(() => Effect.void))
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
): ((socket: EffectWebSocket) => Effect.Effect<void, never, never>) => {
  const complexityConfig = options?.complexity
  const fieldComplexities: FieldComplexityMap = options?.fieldComplexities ?? new Map()

  // Build server options using extracted handler factories
  const serverOptions: ServerOptions<Record<string, unknown>, WSExtra<R>> = {
    schema,

    context: async (ctx): Promise<GraphQLEffectContext<R> & Record<string, unknown>> => {
      const extra = ctx.extra as WSExtra<R>
      return {
        runtime: extra.runtime,
        ...extra.connectionParams,
      }
    },

    subscribe: async (args) => subscribe(args),

    onConnect: makeOnConnectHandler(options),
    onDisconnect: makeOnDisconnectHandler(options),
    onSubscribe: makeOnSubscribeHandler(options, schema, complexityConfig, fieldComplexities),
    onComplete: makeOnCompleteHandler(options),
    onError: makeOnErrorHandler(options),
  }

  const wsServer = makeServer(serverOptions)

  // Return the connection handler
  return (socket: EffectWebSocket): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      const runtime = yield* Effect.provide(Effect.runtime<R>(), layer)

      const extra: WSExtra<R> = {
        socket,
        runtime,
        connectionParams: {},
      }

      yield* runConnectionLifecycle(socket, wsServer, extra)
    }).pipe(
      Effect.catchAllCause(() => Effect.void),
      Effect.scoped
    )
}
