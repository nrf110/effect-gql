import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import { GraphQLSchemaBuilder } from "../builder/schema-builder"
import type { GraphQLRequestContext } from "../context"
import { makeGraphQLRouter, type MakeGraphQLRouterOptions } from "./router"

/**
 * Convert a GraphQLSchemaBuilder to an HTTP route registration layer.
 *
 * This bridges the GraphQL schema builder with Effect's HTTP server.
 * Field complexities and cache hints are automatically extracted from the builder.
 *
 * @param builder - The GraphQL schema builder
 * @param layer - Effect layer providing application resolver and argument-decoding services
 * @param options - Optional configuration for paths, GraphiQL, complexity, and caching
 * @returns A route registration layer that can be merged with other routes
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
 *
 * // With cache control
 * const routerWithCaching = toRouter(builder, Layer.empty, {
 *   cacheControl: { enabled: true, defaultMaxAge: 0 }
 * })
 * ```
 */
export const toRouter = <R>(
  builder: GraphQLSchemaBuilder<R>,
  layer: Layer.Layer<NoInfer<Exclude<R, GraphQLRequestContext | HttpRouter.Provided>>>,
  options?: Omit<MakeGraphQLRouterOptions, "fieldComplexities" | "cacheHints">
): Layer.Layer<never, never, HttpRouter.HttpRouter> => {
  const schema = builder.buildSchema()
  const fieldComplexities = builder.getFieldComplexities()
  const cacheHints = builder.getCacheHints()
  return makeGraphQLRouter(schema, layer, { ...options, fieldComplexities, cacheHints })
}
