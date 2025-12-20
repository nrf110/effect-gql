import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect, Layer } from "effect"
import { GraphQLSchema, graphql } from "graphql"
import type { GraphQLEffectContext } from "../builder/types"
import { graphiqlHtml } from "./graphiql"
import { normalizeConfig, type GraphQLRouterConfigInput } from "./config"

/**
 * Create an HttpRouter configured for GraphQL
 *
 * The router handles:
 * - POST requests to the GraphQL endpoint
 * - GET requests to the GraphiQL UI (if enabled)
 *
 * @param schema - The GraphQL schema
 * @param layer - Effect layer providing services required by resolvers
 * @param config - Optional configuration for paths and GraphiQL
 * @returns An HttpRouter that can be composed with other routes
 *
 * @example
 * ```typescript
 * const router = makeGraphQLRouter(schema, Layer.empty, {
 *   path: "/graphql",
 *   graphiql: { path: "/graphiql" }
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
  config: GraphQLRouterConfigInput = {}
): HttpRouter.HttpRouter<never, never> => {
  const resolvedConfig = normalizeConfig(config)

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
    Effect.catchAllCause((cause) =>
      HttpServerResponse.json(
        {
          errors: [
            {
              message:
                cause._tag === "Fail"
                  ? cause.error instanceof Error
                    ? cause.error.message
                    : String(cause.error)
                  : "Internal server error",
            },
          ],
        },
        { status: 400 }
      ).pipe(Effect.orDie)
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
