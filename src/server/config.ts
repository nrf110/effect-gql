import { Config } from "effect"

/**
 * Configuration for the GraphiQL UI
 */
export interface GraphiQLConfig {
  /** Path where GraphiQL UI is served (default: "/graphiql") */
  readonly path: string
  /** URL where GraphiQL sends requests (default: same as graphql path) */
  readonly endpoint: string
}

/**
 * Configuration for the GraphQL router
 */
export interface GraphQLRouterConfig {
  /** Path for GraphQL endpoint (default: "/graphql") */
  readonly path: string
  /** GraphiQL configuration, or false to disable */
  readonly graphiql: false | GraphiQLConfig
}

/**
 * Default configuration values
 */
export const defaultConfig: GraphQLRouterConfig = {
  path: "/graphql",
  graphiql: false,
}

/**
 * Normalize user-provided config (which may use boolean shorthand for graphiql)
 * into the full GraphQLRouterConfig format
 */
export interface GraphQLRouterConfigInput {
  readonly path?: string
  readonly graphiql?: boolean | Partial<GraphiQLConfig>
}

export const normalizeConfig = (
  input: GraphQLRouterConfigInput = {}
): GraphQLRouterConfig => {
  const path = input.path ?? defaultConfig.path

  let graphiql: false | GraphiQLConfig = false
  if (input.graphiql === true) {
    graphiql = { path: "/graphiql", endpoint: path }
  } else if (input.graphiql && typeof input.graphiql === "object") {
    graphiql = {
      path: input.graphiql.path ?? "/graphiql",
      endpoint: input.graphiql.endpoint ?? path,
    }
  }

  return { path, graphiql }
}

/**
 * Effect Config for loading GraphQL router configuration from environment variables.
 *
 * Environment variables:
 * - GRAPHQL_PATH: Path for GraphQL endpoint (default: "/graphql")
 * - GRAPHIQL_ENABLED: Enable GraphiQL UI (default: false)
 * - GRAPHIQL_PATH: Path for GraphiQL UI (default: "/graphiql")
 * - GRAPHIQL_ENDPOINT: URL where GraphiQL sends requests (default: same as GRAPHQL_PATH)
 */
export const GraphQLRouterConfigFromEnv: Config.Config<GraphQLRouterConfig> =
  Config.all({
    path: Config.string("GRAPHQL_PATH").pipe(Config.withDefault("/graphql")),
    graphiqlEnabled: Config.boolean("GRAPHIQL_ENABLED").pipe(
      Config.withDefault(false)
    ),
    graphiqlPath: Config.string("GRAPHIQL_PATH").pipe(
      Config.withDefault("/graphiql")
    ),
    graphiqlEndpoint: Config.string("GRAPHIQL_ENDPOINT").pipe(Config.option),
  }).pipe(
    Config.map(({ path, graphiqlEnabled, graphiqlPath, graphiqlEndpoint }) => ({
      path,
      graphiql: graphiqlEnabled
        ? {
            path: graphiqlPath,
            endpoint: graphiqlEndpoint._tag === "Some"
              ? graphiqlEndpoint.value
              : path,
          }
        : (false as const),
    }))
  )
