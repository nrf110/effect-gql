import { Context, Layer } from "effect"

/**
 * GraphQL request context containing request-specific data
 */
export interface GraphQLRequestContext {
  readonly request: {
    readonly headers: Record<string, string>
    readonly query: string
    readonly variables?: Record<string, unknown>
    readonly operationName?: string
  }
}

export const GraphQLRequestContext = Context.GenericTag<GraphQLRequestContext>(
  "GraphQLRequestContext"
)

/**
 * Create a layer from request context
 */
export const makeRequestContextLayer = (
  context: GraphQLRequestContext
): Layer.Layer<GraphQLRequestContext> =>
  Layer.succeed(GraphQLRequestContext, context)
