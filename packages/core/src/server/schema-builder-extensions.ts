import { Layer } from "effect"
import { HttpRouter } from "@effect/platform"
import { GraphQLSchemaBuilder } from "../builder/schema-builder"
import { makeGraphQLRouter, type MakeGraphQLRouterOptions } from "./router"

/**
 * Convert a GraphQLSchemaBuilder to an HttpRouter.
 *
 * This bridges the GraphQL schema builder with the @effect/platform HTTP server.
 * Field complexities are automatically extracted from the builder.
 *
 * @param builder - The GraphQL schema builder
 * @param layer - Effect layer providing services required by resolvers
 * @param options - Optional configuration for paths, GraphiQL, and complexity
 * @returns An HttpRouter that can be composed with other routes
 *
 * @example
 * ```typescript
 * import { GraphQLSchemaBuilder, query, toRouter } from "@effect-gql/core"
 * import { Layer, Effect } from "effect"
 * import * as S from "effect/Schema"
 *
 * const builder = GraphQLSchemaBuilder.empty.pipe(
 *   query("hello", { type: S.String, resolve: () => Effect.succeed("world") })
 * )
 *
 * // Basic usage
 * const router = toRouter(builder, Layer.empty, { graphiql: true })
 *
 * // With complexity limiting
 * const routerWithLimits = toRouter(builder, Layer.empty, {
 *   graphiql: true,
 *   complexity: { maxDepth: 10, maxComplexity: 1000 }
 * })
 * ```
 */
export const toRouter = <R, R2>(
  builder: GraphQLSchemaBuilder<R>,
  layer: Layer.Layer<R2>,
  options?: Omit<MakeGraphQLRouterOptions, "fieldComplexities">
): HttpRouter.HttpRouter<never, never> => {
  const schema = builder.buildSchema()
  const fieldComplexities = builder.getFieldComplexities()
  return makeGraphQLRouter(schema, layer, { ...options, fieldComplexities })
}
