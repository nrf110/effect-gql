import { Cause, Context, Effect, Layer, Stream } from "effect"
import {
  GraphQLSchema,
  parse,
  validate,
  subscribe,
  GraphQLError,
  Kind,
  type ExecutionResult,
  type DocumentNode,
  type OperationDefinitionNode,
} from "graphql"
import { makeSubscriptionContext, subscriptionOperations } from "../subscription-context"
import {
  SSEError,
  type GraphQLSSEOptions,
  type SSEConnectionContext,
  type SSESubscriptionRequest,
  type SSEEvent,
  formatNextEvent,
  formatErrorEvent,
  formatCompleteEvent,
} from "./sse-types"
import { validateComplexity, type FieldComplexityMap } from "./complexity"

/**
 * Create a subscription event stream for SSE.
 *
 * This function handles the GraphQL subscription lifecycle:
 * 1. Parse and validate the query
 * 2. Check complexity limits if configured
 * 3. Execute the subscription
 * 4. Stream results as SSE events
 *
 * @param schema - The GraphQL schema with subscription definitions
 * @param layer - Effect layer providing services required by resolvers
 * @param request - The subscription request (query, variables, operationName)
 * @param headers - HTTP headers from the request (for auth)
 * @param options - Optional lifecycle hooks and configuration
 * @returns A Stream of SSE events to send to the client
 *
 * @example
 * ```typescript
 * const eventStream = makeSSESubscriptionStream(
 *   schema,
 *   serviceLayer,
 *   { query: "subscription { tick { count } }" },
 *   new Headers(),
 *   { onConnect: (req, headers) => Effect.succeed({ user: "alice" }) }
 * )
 *
 * // In platform-specific code, consume and send events:
 * Stream.runForEach(eventStream, (event) =>
 *   Effect.sync(() => res.write(formatSSEMessage(event)))
 * )
 * ```
 */
export const makeSSESubscriptionStream = <R>(
  schema: GraphQLSchema,
  layer: Layer.Layer<R>,
  request: SSESubscriptionRequest,
  headers: Headers,
  options?: GraphQLSSEOptions<R>
): Stream.Stream<SSEEvent, SSEError> => {
  const complexityConfig = options?.complexity
  const fieldComplexities: FieldComplexityMap = options?.fieldComplexities ?? new Map()
  const onComplete = options?.onComplete

  return Stream.unwrap(
    Effect.gen(function* () {
      // Keep the service layer alive until the subscription stream is finalized.
      const ambient = yield* Effect.context<never>()
      const memoMap = yield* Layer.makeMemoMap
      const scope = yield* Effect.scope
      const services = Context.merge(ambient, yield* Layer.buildWithMemoMap(layer, memoMap, scope))

      const ctx: SSEConnectionContext<R> = {
        services,
        request,
        connectionContext: {},
      }
      let completed = false
      let streaming = false
      let closeSource: Effect.Effect<void> = Effect.void
      const connectionAbort = new AbortController()
      const pendingWork = new Set<Promise<unknown>>()
      const runHook = (hook: () => Effect.Effect<void, never, R>) =>
        Effect.suspend(hook).pipe(
          Effect.provide(services),
          Effect.catchCause(() => Effect.void),
          Effect.uninterruptible
        )
      const errorStream = (errors: readonly unknown[], error: unknown = errors) =>
        Stream.unwrap(
          closeSource.pipe(
            Effect.andThen(
              options?.onError ? runHook(() => options.onError!(ctx, error)) : Effect.void
            ),
            Effect.as(Stream.make(formatErrorEvent(errors), formatCompleteEvent()))
          )
        )

      const setup = Effect.gen(function* () {
        // Run onConnect hook if provided
        let connectionContext: Record<string, unknown> = {}
        if (options?.onConnect) {
          const connected = yield* Effect.try({
            try: () => options.onConnect!(request, headers),
            catch: (error) => error,
          }).pipe(
            Effect.flatMap((effect) => effect),
            Effect.provide(services),
            Effect.match({
              onFailure: (error) =>
                new GraphQLError(error instanceof Error ? error.message : String(error), {
                  extensions: { code: "CONNECTION_REJECTED" },
                }),
              onSuccess: (value) => value,
            })
          )
          if (connected instanceof GraphQLError) {
            return errorStream([connected])
          }
          connectionContext = connected
          Object.assign(ctx.connectionContext, connectionContext)
        }

        // Parse the query
        let document: DocumentNode
        try {
          document = parse(request.query)
        } catch (syntaxError) {
          return errorStream([syntaxError], syntaxError)
        }

        // Validate the query
        const validationErrors = validate(schema, document)
        if (validationErrors.length > 0) {
          return errorStream(validationErrors)
        }

        // Find the subscription operation
        const operations = document.definitions.filter(
          (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION
        )

        const operation = request.operationName
          ? operations.find((o) => o.name?.value === request.operationName)
          : operations[0]

        if (!operation) {
          return errorStream([new GraphQLError("No operation found in query")])
        }

        if (operation.operation !== "subscription") {
          return errorStream([
            new GraphQLError(
              `SSE endpoint only supports subscriptions, received: ${operation.operation}`,
              { extensions: { code: "OPERATION_NOT_SUPPORTED" } }
            ),
          ])
        }

        // Validate complexity if configured
        if (complexityConfig) {
          const complexityResult = yield* validateComplexity(
            request.query,
            request.operationName,
            request.variables,
            schema,
            fieldComplexities,
            complexityConfig
          ).pipe(
            Effect.map(() => null),
            Effect.catch((error) => {
              if (error._tag === "ComplexityLimitExceededError") {
                return Effect.succeed(
                  new GraphQLError(error.message, {
                    extensions: {
                      code: "COMPLEXITY_LIMIT_EXCEEDED",
                      limitType: error.limitType,
                      limit: error.limit,
                      actual: error.actual,
                    },
                  })
                )
              }
              // Log analysis errors but don't block (fail open)
              return Effect.logWarning(
                "Complexity analysis failed for SSE subscription",
                error
              ).pipe(Effect.map(() => null))
            })
          )

          if (complexityResult) {
            return errorStream([complexityResult], complexityResult)
          }
        }

        // Call onSubscribe hook if provided
        if (options?.onSubscribe) {
          yield* Effect.provide(
            Effect.suspend(() => options.onSubscribe!(ctx)),
            services
          )
        }

        // Execute the subscription
        const graphqlContext = makeSubscriptionContext({
          ...connectionContext,
          services,
        })
        const operationState = subscriptionOperations.get(graphqlContext)!
        operationState.runOptions = { signal: connectionAbort.signal }
        operationState.pendingWork = pendingWork

        const subscriptionResult = yield* Effect.tryPromise({
          try: () =>
            subscribe({
              schema,
              document,
              variableValues: request.variables,
              operationName: request.operationName ?? undefined,
              contextValue: graphqlContext,
            }),
          catch: (error) => new SSEError({ cause: error }),
        })

        // Check if subscribe returned an error result instead of async iterator
        if (!isAsyncIterable(subscriptionResult)) {
          // It's an ExecutionResult with errors
          const result = subscriptionResult as ExecutionResult
          if (result.errors) {
            return errorStream(result.errors)
          }
          // Shouldn't happen, but handle gracefully
          return Stream.make(formatNextEvent(result), formatCompleteEvent())
        }

        streaming = true
        const iterator = subscriptionResult[Symbol.asyncIterator]()
        let closing: Promise<unknown> | undefined
        // The native adapter does not await return() while next() is pending.
        // Own it here so resolver cleanup finishes before lifecycle hooks.
        closeSource = Effect.tryPromise({
          try: () => (closing ??= Promise.resolve().then(() => iterator.return?.())),
          catch: (error) => error,
        }).pipe(
          Effect.asVoid,
          Effect.catchCause(() => Effect.void),
          Effect.uninterruptible
        )
        return Stream.fromAsyncIterable(
          { [Symbol.asyncIterator]: () => ({ next: () => iterator.next() }) },
          (error) => error
        ).pipe(
          Stream.mapEffect((result) =>
            Effect.gen(function* () {
              if (result.errors?.length && options?.onError) {
                yield* runHook(() => options.onError!(ctx, result.errors))
              }
              return yield* Effect.try({
                try: () => formatNextEvent(result),
                catch: (error) => error,
              })
            })
          ),
          Stream.concat(Stream.make(formatCompleteEvent())),
          Stream.catch((error) =>
            errorStream(
              [
                error instanceof GraphQLError
                  ? error
                  : new GraphQLError(
                      error instanceof Error ? error.message : "Subscription error",
                      {
                        extensions: { code: "SUBSCRIPTION_ERROR" },
                      }
                    ),
              ],
              error
            )
          )
        )
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.failCause(cause).pipe(Effect.orDie)
          const error = Cause.squash(cause)
          return Effect.succeed(
            errorStream(
              [
                new GraphQLError(error instanceof Error ? error.message : "Internal error", {
                  extensions: { code: "INTERNAL_ERROR" },
                }),
              ],
              error
            )
          )
        })
      )

      return Stream.unwrap(setup).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            if (event.event === "complete") completed = true
          })
        ),
        Stream.ensuring(
          Effect.gen(function* () {
            connectionAbort.abort()
            yield* closeSource
            while (pendingWork.size > 0) {
              yield* Effect.promise(() => Promise.allSettled(pendingWork))
            }
            if (!completed && options?.onDisconnect) {
              yield* runHook(() => options.onDisconnect!(ctx))
            }
            if (streaming && onComplete) {
              yield* runHook(() => onComplete(ctx))
            }
          })
        )
      )
    })
  )
}

/**
 * Create an SSE subscription handler that can be used with platform-specific servers.
 *
 * This is a higher-level API that returns a handler function. The handler
 * takes a request and headers, and returns a Stream of SSE events.
 *
 * @param schema - The GraphQL schema with subscription definitions
 * @param layer - Effect layer providing services required by resolvers
 * @param options - Optional lifecycle hooks and configuration
 * @returns A handler function for SSE subscription requests
 *
 * @example
 * ```typescript
 * const handler = makeGraphQLSSEHandler(schema, serviceLayer, {
 *   onConnect: (request, headers) => Effect.gen(function* () {
 *     const token = headers.get("authorization")
 *     const user = yield* AuthService.validateToken(token)
 *     return { user }
 *   }),
 * })
 *
 * // In platform-specific code:
 * const events = handler(request, headers)
 * // Stream events to client...
 * ```
 */
export const makeGraphQLSSEHandler = <R>(
  schema: GraphQLSchema,
  layer: Layer.Layer<R>,
  options?: GraphQLSSEOptions<R>
): ((request: SSESubscriptionRequest, headers: Headers) => Stream.Stream<SSEEvent, SSEError>) => {
  return (request, headers) => makeSSESubscriptionStream(schema, layer, request, headers, options)
}

/**
 * Type guard to check if a value is an AsyncIterable (subscription result)
 */
function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value
}
