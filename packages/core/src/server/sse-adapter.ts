import { Effect, Layer, Stream } from "effect"
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
import type { GraphQLEffectContext } from "../builder/types"
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

  return Stream.unwrap(
    Effect.gen(function* () {
      // Create a runtime from the layer
      const runtime = yield* Effect.provide(Effect.runtime<R>(), layer)

      // Run onConnect hook if provided
      let connectionContext: Record<string, unknown> = {}
      if (options?.onConnect) {
        try {
          connectionContext = yield* Effect.provide(options.onConnect(request, headers), layer)
        } catch {
          // Connection rejected
          return Stream.make(
            formatErrorEvent([
              new GraphQLError("Subscription connection rejected", {
                extensions: { code: "CONNECTION_REJECTED" },
              }),
            ]),
            formatCompleteEvent()
          )
        }
      }

      // Parse the query
      let document: DocumentNode
      try {
        document = parse(request.query)
      } catch (syntaxError) {
        return Stream.make(formatErrorEvent([syntaxError]), formatCompleteEvent())
      }

      // Validate the query
      const validationErrors = validate(schema, document)
      if (validationErrors.length > 0) {
        return Stream.make(formatErrorEvent(validationErrors), formatCompleteEvent())
      }

      // Find the subscription operation
      const operations = document.definitions.filter(
        (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION
      )

      const operation = request.operationName
        ? operations.find((o) => o.name?.value === request.operationName)
        : operations[0]

      if (!operation) {
        return Stream.make(
          formatErrorEvent([new GraphQLError("No operation found in query")]),
          formatCompleteEvent()
        )
      }

      if (operation.operation !== "subscription") {
        return Stream.make(
          formatErrorEvent([
            new GraphQLError(
              `SSE endpoint only supports subscriptions, received: ${operation.operation}`,
              { extensions: { code: "OPERATION_NOT_SUPPORTED" } }
            ),
          ]),
          formatCompleteEvent()
        )
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
          Effect.catchAll((error) => {
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
            return Effect.logWarning("Complexity analysis failed for SSE subscription", error).pipe(
              Effect.map(() => null)
            )
          })
        )

        if (complexityResult) {
          return Stream.make(formatErrorEvent([complexityResult]), formatCompleteEvent())
        }
      }

      // Build the context for the subscription
      const ctx: SSEConnectionContext<R> = {
        runtime,
        request,
        connectionContext,
      }

      // Call onSubscribe hook if provided
      if (options?.onSubscribe) {
        yield* Effect.provide(options.onSubscribe(ctx), layer).pipe(
          Effect.catchAll(() => Effect.void)
        )
      }

      // Execute the subscription
      const graphqlContext: GraphQLEffectContext<R> & Record<string, unknown> = {
        runtime,
        ...connectionContext,
      }

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
          return Stream.make(formatErrorEvent(result.errors), formatCompleteEvent())
        }
        // Shouldn't happen, but handle gracefully
        return Stream.make(formatNextEvent(result), formatCompleteEvent())
      }

      // Create a stream from the async iterator
      const asyncIterator = subscriptionResult[Symbol.asyncIterator]()

      const eventStream = Stream.async<SSEEvent, SSEError>((emit) => {
        let done = false

        const iterate = async () => {
          try {
            while (!done) {
              const result = await asyncIterator.next()
              if (result.done) {
                emit.end()
                break
              }
              emit.single(formatNextEvent(result.value))
            }
          } catch (error) {
            if (!done) {
              emit.single(
                formatErrorEvent([
                  error instanceof GraphQLError
                    ? error
                    : new GraphQLError(
                        error instanceof Error ? error.message : "Subscription error",
                        { extensions: { code: "SUBSCRIPTION_ERROR" } }
                      ),
                ])
              )
              emit.end()
            }
          }
        }

        iterate()

        // Return cleanup function
        return Effect.sync(() => {
          done = true
          asyncIterator.return?.()
        })
      })

      // Add complete event at the end and handle cleanup
      return eventStream.pipe(
        Stream.onDone(() =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {})
          }).pipe(Effect.asVoid)
        ),
        Stream.concat(Stream.make(formatCompleteEvent())),
        Stream.onDone(() => {
          if (options?.onComplete) {
            return Effect.provide(options.onComplete(ctx), layer).pipe(
              Effect.catchAll(() => Effect.void)
            )
          }
          return Effect.void
        })
      )
    }).pipe(
      Effect.catchAll((error) =>
        Effect.succeed(
          Stream.make(
            formatErrorEvent([
              new GraphQLError(error instanceof Error ? error.message : "Internal error", {
                extensions: { code: "INTERNAL_ERROR" },
              }),
            ]),
            formatCompleteEvent()
          )
        )
      )
    )
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
