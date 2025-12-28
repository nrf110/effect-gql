import { Config, Option } from "effect"
import type { ComplexityConfig } from "./complexity"
import type { CacheControlConfig } from "./cache-control"

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
  /** Enable introspection queries (default: true). Set to false in production. */
  readonly introspection: boolean
  /** Cache control configuration for HTTP Cache-Control headers */
  readonly cacheControl?: CacheControlConfig
}

/**
 * Default configuration values
 */
export const defaultConfig: GraphQLRouterConfig = {
  path: "/graphql",
  graphiql: false,
  complexity: undefined,
  introspection: true,
  cacheControl: undefined,
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
  /** Enable introspection queries (default: true). Set to false in production. */
  readonly introspection?: boolean
  /** Cache control configuration for HTTP Cache-Control headers */
  readonly cacheControl?: CacheControlConfig
}

export const normalizeConfig = (input: GraphQLRouterConfigInput = {}): GraphQLRouterConfig => {
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

  return {
    path,
    graphiql,
    complexity: input.complexity,
    introspection: input.introspection ?? true,
    cacheControl: input.cacheControl,
  }
}

/**
 * Effect Config for loading GraphQL router configuration from environment variables.
 *
 * Environment variables:
 * - GRAPHQL_PATH: Path for GraphQL endpoint (default: "/graphql")
 * - GRAPHQL_INTROSPECTION: Enable introspection queries (default: true)
 * - GRAPHIQL_ENABLED: Enable GraphiQL UI (default: false)
 * - GRAPHIQL_PATH: Path for GraphiQL UI (default: "/graphiql")
 * - GRAPHIQL_ENDPOINT: URL where GraphiQL sends requests (default: same as GRAPHQL_PATH)
 * - GRAPHQL_MAX_DEPTH: Maximum query depth (optional)
 * - GRAPHQL_MAX_COMPLEXITY: Maximum complexity score (optional)
 * - GRAPHQL_MAX_ALIASES: Maximum number of aliases (optional)
 * - GRAPHQL_MAX_FIELDS: Maximum number of fields (optional)
 * - GRAPHQL_DEFAULT_FIELD_COMPLEXITY: Default field complexity (default: 1)
 * - GRAPHQL_CACHE_CONTROL_ENABLED: Enable cache control headers (default: false)
 * - GRAPHQL_CACHE_CONTROL_DEFAULT_MAX_AGE: Default maxAge for root fields (default: 0)
 * - GRAPHQL_CACHE_CONTROL_DEFAULT_SCOPE: Default scope - PUBLIC or PRIVATE (default: PUBLIC)
 */
export const GraphQLRouterConfigFromEnv: Config.Config<GraphQLRouterConfig> = Config.all({
  path: Config.string("GRAPHQL_PATH").pipe(Config.withDefault("/graphql")),
  introspection: Config.boolean("GRAPHQL_INTROSPECTION").pipe(Config.withDefault(true)),
  graphiqlEnabled: Config.boolean("GRAPHIQL_ENABLED").pipe(Config.withDefault(false)),
  graphiqlPath: Config.string("GRAPHIQL_PATH").pipe(Config.withDefault("/graphiql")),
  graphiqlEndpoint: Config.string("GRAPHIQL_ENDPOINT").pipe(Config.option),
  maxDepth: Config.number("GRAPHQL_MAX_DEPTH").pipe(Config.option),
  maxComplexity: Config.number("GRAPHQL_MAX_COMPLEXITY").pipe(Config.option),
  maxAliases: Config.number("GRAPHQL_MAX_ALIASES").pipe(Config.option),
  maxFields: Config.number("GRAPHQL_MAX_FIELDS").pipe(Config.option),
  defaultFieldComplexity: Config.number("GRAPHQL_DEFAULT_FIELD_COMPLEXITY").pipe(
    Config.withDefault(1)
  ),
  cacheControlEnabled: Config.boolean("GRAPHQL_CACHE_CONTROL_ENABLED").pipe(
    Config.withDefault(false)
  ),
  cacheControlDefaultMaxAge: Config.number("GRAPHQL_CACHE_CONTROL_DEFAULT_MAX_AGE").pipe(
    Config.withDefault(0)
  ),
  cacheControlDefaultScope: Config.string("GRAPHQL_CACHE_CONTROL_DEFAULT_SCOPE").pipe(
    Config.withDefault("PUBLIC")
  ),
}).pipe(
  Config.map(
    ({
      path,
      introspection,
      graphiqlEnabled,
      graphiqlPath,
      graphiqlEndpoint,
      maxDepth,
      maxComplexity,
      maxAliases,
      maxFields,
      defaultFieldComplexity,
      cacheControlEnabled,
      cacheControlDefaultMaxAge,
      cacheControlDefaultScope,
    }) => {
      // Check if any complexity option is set
      const hasComplexity =
        Option.isSome(maxDepth) ||
        Option.isSome(maxComplexity) ||
        Option.isSome(maxAliases) ||
        Option.isSome(maxFields)

      return {
        path,
        introspection,
        graphiql: graphiqlEnabled
          ? {
              path: graphiqlPath,
              endpoint: Option.isSome(graphiqlEndpoint) ? graphiqlEndpoint.value : path,
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
        cacheControl: cacheControlEnabled
          ? {
              enabled: true,
              defaultMaxAge: cacheControlDefaultMaxAge,
              defaultScope: (cacheControlDefaultScope === "PRIVATE"
                ? "PRIVATE"
                : "PUBLIC") as import("../builder/types").CacheControlScope,
              calculateHttpHeaders: true,
            }
          : undefined,
      }
    }
  )
)
