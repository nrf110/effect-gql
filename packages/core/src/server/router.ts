import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect, Layer } from "effect"
import { GraphQLSchema, graphql } from "graphql"
import type { GraphQLEffectContext } from "../builder/types"
import { graphiqlHtml } from "./graphiql"
import { normalizeConfig, type GraphQLRouterConfigInput } from "./config"
import {
  validateComplexity,
  ComplexityLimitExceededError,
  type FieldComplexityMap,
} from "./complexity"

/**
 * Options for makeGraphQLRouter
 */
export interface MakeGraphQLRouterOptions extends GraphQLRouterConfigInput {
  /**
   * Field complexity definitions from the schema builder.
   * If using toRouter(), this is automatically extracted from the builder.
   * If using makeGraphQLRouter() directly, call builder.getFieldComplexities().
   */
  readonly fieldComplexities?: FieldComplexityMap
}

/**
 * Create an HttpRouter configured for GraphQL
 *
 * The router handles:
 * - POST requests to the GraphQL endpoint
 * - GET requests to the GraphiQL UI (if enabled)
 * - Query complexity validation (if configured)
 *
 * @param schema - The GraphQL schema
 * @param layer - Effect layer providing services required by resolvers
 * @param options - Optional configuration for paths, GraphiQL, and complexity
 * @returns An HttpRouter that can be composed with other routes
 *
 * @example
 * ```typescript
 * const router = makeGraphQLRouter(schema, Layer.empty, {
 *   path: "/graphql",
 *   graphiql: { path: "/graphiql" },
 *   complexity: { maxDepth: 10, maxComplexity: 1000 },
 *   fieldComplexities: builder.getFieldComplexities()
 * })
 *
 * // Compose with other routes
 * const app = HttpRouter.empty.pipe(
 *   HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" })),
 *   HttpRouter.concat(router)
 * )
 * ```
 */
export const makeGraphQLRouter = <R>(
  schema: GraphQLSchema,
  layer: Layer.Layer<R>,
  options: MakeGraphQLRouterOptions = {}
): HttpRouter.HttpRouter<never, never> => {
  const resolvedConfig = normalizeConfig(options)
  const fieldComplexities = options.fieldComplexities ?? new Map()

  // GraphQL POST handler
  const graphqlHandler = Effect.gen(function* () {
    // Get the runtime from the layer
    const runtime = yield* Effect.runtime<R>()

    // Parse request body
    const request = yield* HttpServerRequest.HttpServerRequest
    const body = yield* request.json as Effect.Effect<{
      query: string
      variables?: Record<string, unknown>
      operationName?: string
    }>

    // Validate query complexity if configured
    if (resolvedConfig.complexity) {
      yield* validateComplexity(
        body.query,
        body.operationName,
        body.variables,
        schema,
        fieldComplexities,
        resolvedConfig.complexity
      ).pipe(
        Effect.catchTag("ComplexityLimitExceededError", (error) =>
          Effect.fail(error)
        ),
        Effect.catchTag("ComplexityAnalysisError", (error) =>
          // Log analysis errors but don't block execution
          Effect.logWarning("Complexity analysis failed", error)
        )
      )
    }

    // Execute GraphQL query
    const result = yield* Effect.tryPromise({
      try: () =>
        graphql({
          schema,
          source: body.query,
          variableValues: body.variables,
          operationName: body.operationName,
          contextValue: { runtime } satisfies GraphQLEffectContext<R>,
        }),
      catch: (error) => new Error(String(error)),
    })

    return yield* HttpServerResponse.json(result)
  }).pipe(
    Effect.provide(layer),
    Effect.catchAll((error) => {
      // Handle complexity limit exceeded error specifically
      if (error instanceof ComplexityLimitExceededError) {
        return HttpServerResponse.json(
          {
            errors: [
              {
                message: error.message,
                extensions: {
                  code: "COMPLEXITY_LIMIT_EXCEEDED",
                  limitType: error.limitType,
                  limit: error.limit,
                  actual: error.actual,
                },
              },
            ],
          },
          { status: 400 }
        ).pipe(Effect.orDie)
      }
      // Re-throw other errors to be caught by catchAllCause
      return Effect.fail(error)
    }),
    Effect.catchAllCause((cause) =>
      // Log the full error for debugging (server-side only)
      (process.env.NODE_ENV !== "production"
        ? Effect.logError("GraphQL error", cause)
        : Effect.void
      ).pipe(
        // Return sanitized error message to client
        Effect.andThen(
          HttpServerResponse.json(
            {
              errors: [
                {
                  message: "An error occurred processing your request",
                },
              ],
            },
            { status: 400 }
          ).pipe(Effect.orDie)
        )
      )
    )
  )

  // Build router with GraphQL endpoint
  let router = HttpRouter.empty.pipe(
    HttpRouter.post(resolvedConfig.path as HttpRouter.PathInput, graphqlHandler)
  )

  // Add GraphiQL route if enabled
  if (resolvedConfig.graphiql) {
    const { path, endpoint } = resolvedConfig.graphiql
    router = router.pipe(
      HttpRouter.get(
        path as HttpRouter.PathInput,
        HttpServerResponse.html(graphiqlHtml(endpoint))
      )
    )
  }

  return router
}
