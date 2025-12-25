import { Config, Option } from "effect"
import type { ComplexityConfig } from "./complexity"

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
  /** Query complexity limiting configuration */
  readonly complexity?: ComplexityConfig
}

/**
 * Default configuration values
 */
export const defaultConfig: GraphQLRouterConfig = {
  path: "/graphql",
  graphiql: false,
  complexity: undefined,
}

/**
 * Normalize user-provided config (which may use boolean shorthand for graphiql)
 * into the full GraphQLRouterConfig format
 */
export interface GraphQLRouterConfigInput {
  readonly path?: string
  readonly graphiql?: boolean | Partial<GraphiQLConfig>
  /** Query complexity limiting configuration */
  readonly complexity?: ComplexityConfig
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

  return { path, graphiql, complexity: input.complexity }
}

/**
 * Effect Config for loading GraphQL router configuration from environment variables.
 *
 * Environment variables:
 * - GRAPHQL_PATH: Path for GraphQL endpoint (default: "/graphql")
 * - GRAPHIQL_ENABLED: Enable GraphiQL UI (default: false)
 * - GRAPHIQL_PATH: Path for GraphiQL UI (default: "/graphiql")
 * - GRAPHIQL_ENDPOINT: URL where GraphiQL sends requests (default: same as GRAPHQL_PATH)
 * - GRAPHQL_MAX_DEPTH: Maximum query depth (optional)
 * - GRAPHQL_MAX_COMPLEXITY: Maximum complexity score (optional)
 * - GRAPHQL_MAX_ALIASES: Maximum number of aliases (optional)
 * - GRAPHQL_MAX_FIELDS: Maximum number of fields (optional)
 * - GRAPHQL_DEFAULT_FIELD_COMPLEXITY: Default field complexity (default: 1)
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
    maxDepth: Config.number("GRAPHQL_MAX_DEPTH").pipe(Config.option),
    maxComplexity: Config.number("GRAPHQL_MAX_COMPLEXITY").pipe(Config.option),
    maxAliases: Config.number("GRAPHQL_MAX_ALIASES").pipe(Config.option),
    maxFields: Config.number("GRAPHQL_MAX_FIELDS").pipe(Config.option),
    defaultFieldComplexity: Config.number("GRAPHQL_DEFAULT_FIELD_COMPLEXITY").pipe(
      Config.withDefault(1)
    ),
  }).pipe(
    Config.map(({
      path,
      graphiqlEnabled,
      graphiqlPath,
      graphiqlEndpoint,
      maxDepth,
      maxComplexity,
      maxAliases,
      maxFields,
      defaultFieldComplexity,
    }) => {
      // Check if any complexity option is set
      const hasComplexity =
        Option.isSome(maxDepth) ||
        Option.isSome(maxComplexity) ||
        Option.isSome(maxAliases) ||
        Option.isSome(maxFields)

      return {
        path,
        graphiql: graphiqlEnabled
          ? {
              path: graphiqlPath,
              endpoint: Option.isSome(graphiqlEndpoint)
                ? graphiqlEndpoint.value
                : path,
            }
          : (false as const),
        complexity: hasComplexity
          ? {
              maxDepth: Option.getOrUndefined(maxDepth),
              maxComplexity: Option.getOrUndefined(maxComplexity),
              maxAliases: Option.getOrUndefined(maxAliases),
              maxFields: Option.getOrUndefined(maxFields),
              defaultFieldComplexity,
            }
          : undefined,
      }
    })
  )
