import { Context, Effect, Layer, Stream, Queue, Fiber, Deferred } from "effect"
import { GraphQLSchema, subscribe, GraphQLError, type ExecutionResult } from "graphql"
import type { ServerOptions } from "graphql-ws"
import { makeSubscriptionContext } from "../subscription-context"
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
  services: Context.Context<R>
  connectionParams: Record<string, unknown>
  closing: boolean
  pendingReturns: Set<Promise<unknown>>
}

/**
 * Create a ConnectionContext from WSExtra for use in lifecycle hooks.
 */
const createConnectionContext = <R>(extra: WSExtra<R>): ConnectionContext<R> => ({
  services: extra.services,
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
      const result = await Effect.runPromiseWith(extra.services)(
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
    await Effect.runPromiseWith(extra.services)(
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
        Effect.catch((error) => {
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
      await Effect.runPromiseWith(extra.services)(
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
    await Effect.runPromiseWith(extra.services)(
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
    await Effect.runPromiseWith(extra.services)(
      options.onError!(createConnectionContext(extra), errors)
    ).catch(() => {
      // Ignore error handler errors
    })
  }
}

/**
 * Create a graphql-ws compatible socket adapter from an EffectWebSocket.
 */
const createGraphqlWsSocketAdapter = <R>(socket: EffectWebSocket, extra: WSExtra<R>) => {
  const services = extra.services
  let messageCallback: ((message: string) => Promise<void>) | null = null

  return {
    adapter: {
      protocol: socket.protocol,

      send: (data: string) =>
        extra.closing
          ? Promise.resolve()
          : Effect.runPromiseWith(services)(
              socket
                .send(data)
                .pipe(Effect.catch((error) => Effect.logError("WebSocket send error", error)))
            ),

      close: (code?: number, reason?: string) => {
        Effect.runPromiseWith(services)(socket.close(code, reason)).catch(() => {
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
      if (!extra.closing && messageCallback) {
        await messageCallback(message)
      }
    },
  }
}

/**
 * Type alias for the graphql-ws server instance.
 */
type GraphQLWSServer<R> = ReturnType<
  typeof import("graphql-ws").makeServer<Record<string, unknown>, WSExtra<R>>
>

/**
 * Run the connection lifecycle - manages message queue, fibers, and cleanup.
 */
const runConnectionLifecycle = <R>(
  socket: EffectWebSocket,
  wsServer: GraphQLWSServer<R>,
  extra: WSExtra<R>
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    // Create message queue for bridging Stream to callback
    const messageQueue = yield* Queue.unbounded<string>()
    const closedDeferred = yield* Deferred.make<CloseEvent, WebSocketError>()
    let activeDispatch: Promise<void> | undefined
    const stopDispatching = Effect.sync(() => {
      extra.closing = true
    })

    // Fork fiber to consume socket messages and push to queue
    const messageFiber = yield* Effect.forkChild(
      Stream.runForEach(socket.messages, (msg) => Queue.offer(messageQueue, msg)).pipe(
        Effect.catch((error) =>
          stopDispatching.pipe(Effect.andThen(Deferred.fail(closedDeferred, error)))
        )
      )
    )

    // Fork fiber to handle socket close
    const closeFiber = yield* Effect.forkChild(
      socket.closed.pipe(
        Effect.tap((event) =>
          stopDispatching.pipe(Effect.andThen(Deferred.succeed(closedDeferred, event)))
        ),
        Effect.catch((error) =>
          stopDispatching.pipe(Effect.andThen(Deferred.fail(closedDeferred, error)))
        )
      )
    )

    // Create the graphql-ws socket adapter
    const { adapter, dispatchMessage } = createGraphqlWsSocketAdapter(socket, extra)

    // Open the connection with graphql-ws
    const closedHandler = wsServer.opened(adapter, extra)

    // Fork fiber to process messages from queue
    const processMessagesFiber = yield* Effect.forkChild(
      Effect.gen(function* () {
        while (!extra.closing) {
          const message = yield* Queue.take(messageQueue)
          yield* Effect.tryPromise({
            try: () => (activeDispatch = dispatchMessage(message)),
            catch: (error) => error,
          }).pipe(Effect.catch(() => Effect.void))
        }
      })
    )

    // Wait for connection to close
    yield* Deferred.await(closedDeferred).pipe(
      Effect.catch(() => Effect.void),
      Effect.ensuring(
        Effect.gen(function* () {
          yield* stopDispatching
          yield* Fiber.interrupt(messageFiber)
          yield* Fiber.interrupt(closeFiber)
          yield* Fiber.interrupt(processMessagesFiber)
          yield* Queue.shutdown(messageQueue)

          // A streaming dispatch only settles after its source is closed.
          yield* Effect.tryPromise({
            try: () => closedHandler(1000, "Connection closed"),
            catch: (error) => error,
          }).pipe(Effect.catchCause(() => Effect.void))

          // Interrupting the Effect does not cancel its native dispatch Promise.
          // Keep services alive through late setup, iterator cleanup, and hooks.
          const pending = activeDispatch
          if (pending) {
            yield* Effect.tryPromise({
              try: () => pending,
              catch: (error) => error,
            }).pipe(Effect.catchCause(() => Effect.void))
          }
          if (extra.pendingReturns.size > 0) {
            yield* Effect.promise(() => Promise.allSettled(extra.pendingReturns))
          }
        })
      )
    )
  }).pipe(
    Effect.catchCause(() => Effect.void),
    Effect.scoped
  )

/**
 * Dynamically import graphql-ws to avoid requiring it at module load time.
 * This allows @effect-gql/core to be used without graphql-ws installed
 * as long as WebSocket functionality isn't used.
 */
const importGraphqlWs = Effect.tryPromise({
  try: () => import("graphql-ws"),
  catch: () =>
    new Error(
      "graphql-ws is required for WebSocket subscriptions. Install it with: npm install graphql-ws"
    ),
})

/**
 * Create a WebSocket handler for GraphQL subscriptions using the graphql-ws protocol.
 *
 * This function creates a handler that can be used with any WebSocket implementation
 * that conforms to the EffectWebSocket interface. Platform packages (node, bun, express)
 * provide adapters that convert their native WebSocket to EffectWebSocket.
 *
 * The handler:
 * - Uses the graphql-ws protocol for client communication
 * - Builds scoped services from the provided layer for each connection
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
export const makeGraphQLWSHandler = <R, LE = never>(
  schema: GraphQLSchema,
  layer: Layer.Layer<R, LE>,
  options?: GraphQLWSOptions<R>
): ((socket: EffectWebSocket) => Effect.Effect<void, never, never>) => {
  const complexityConfig = options?.complexity
  const fieldComplexities: FieldComplexityMap = options?.fieldComplexities ?? new Map()

  // Lazily create the server on first connection
  let wsServerPromise: Promise<GraphQLWSServer<R>> | null = null

  const getOrCreateServer = async () => {
    if (!wsServerPromise) {
      wsServerPromise = Effect.runPromise(importGraphqlWs).then(({ makeServer }) => {
        // Build server options using extracted handler factories
        const serverOptions: ServerOptions<Record<string, unknown>, WSExtra<R>> = {
          schema,

          context: async (ctx) => {
            const extra = ctx.extra as WSExtra<R>
            return makeSubscriptionContext({
              ...extra.connectionParams,
              services: extra.services,
            })
          },

          subscribe: async (args) => subscribe(args),

          onOperation: (ctx, _id, _payload, _args, result) => {
            if (!(Symbol.asyncIterator in result)) return
            const extra = ctx.extra as WSExtra<R>
            const iterator = result[Symbol.asyncIterator]()
            let returned: Promise<IteratorResult<ExecutionResult>> | undefined
            const stream = {
              [Symbol.asyncIterator]() {
                return this
              },
              next: (value?: unknown): Promise<IteratorResult<ExecutionResult>> =>
                extra.closing ? stream.return(value) : iterator.next(value),
              return: (value?: unknown) => {
                if (!returned) {
                  const pending = Promise.resolve().then(
                    () => iterator.return?.(value) ?? { done: true as const, value }
                  )
                  returned = pending
                  extra.pendingReturns.add(pending)
                  const settled = () => {
                    extra.pendingReturns.delete(pending)
                  }
                  void pending.then(settled, settled)
                }
                return returned
              },
            }
            // Track every return: closure can land after this hook returns but
            // before graphql-ws registers the iterator, and that path does not
            // await return(). No event payloads or iterator results are wrapped.
            return extra.closing ? stream.return().then(() => ({})) : stream
          },

          onConnect: makeOnConnectHandler(options),
          onDisconnect: makeOnDisconnectHandler(options),
          onSubscribe: makeOnSubscribeHandler(options, schema, complexityConfig, fieldComplexities),
          onComplete: makeOnCompleteHandler(options),
          onError: makeOnErrorHandler(options),
        }

        return makeServer(serverOptions)
      })
    }
    return wsServerPromise
  }

  // Return the connection handler
  return (socket: EffectWebSocket): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      const wsServer = yield* Effect.tryPromise({
        try: () => getOrCreateServer(),
        catch: (error) => error as Error,
      })

      const ambient = yield* Effect.context<never>()
      const memoMap = yield* Layer.makeMemoMap
      const scope = yield* Effect.scope
      const services = Context.merge(ambient, yield* Layer.buildWithMemoMap(layer, memoMap, scope))

      const extra: WSExtra<R> = {
        socket,
        services,
        connectionParams: {},
        closing: false,
        pendingReturns: new Set(),
      }

      yield* runConnectionLifecycle(socket, wsServer, extra)
    }).pipe(
      Effect.catchCause(() =>
        socket.close(1011, "Internal server error").pipe(Effect.catchCause(() => Effect.void))
      ),
      Effect.scoped
    )
}
