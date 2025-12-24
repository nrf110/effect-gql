import { Layer } from "effect"
import { HttpRouter } from "@effect/platform"
import { GraphQLSchemaBuilder } from "../builder/schema-builder"
import { makeGraphQLRouter } from "./router"
import type { GraphQLRouterConfigInput } from "./config"

/**
 * Convert a GraphQLSchemaBuilder to an HttpRouter.
 *
 * This bridges the GraphQL schema builder with the @effect/platform HTTP server.
 *
 * @param builder - The GraphQL schema builder
 * @param layer - Effect layer providing services required by resolvers
 * @param config - Optional configuration for paths and GraphiQL
 * @returns An HttpRouter that can be composed with other routes
 *
 * @example
 * ```typescript
 * import { GraphQLSchemaBuilder, query, toRouter } from "@effect-gql/core"
 * import { Layer } from "effect"
 * import * as S from "effect/Schema"
 *
 * const builder = GraphQLSchemaBuilder.empty.pipe(
 *   query("hello", { type: S.String, resolve: () => Effect.succeed("world") })
 * )
 *
 * const router = toRouter(builder, Layer.empty, { graphiql: true })
 * ```
 */
export const toRouter = <R, R2>(
  builder: GraphQLSchemaBuilder<R>,
  layer: Layer.Layer<R2>,
  config?: GraphQLRouterConfigInput
): HttpRouter.HttpRouter<never, never> => {
  const schema = builder.buildSchema()
  return makeGraphQLRouter(schema, layer, config)
}
