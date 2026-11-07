import { Config, Option } from "effect"
import { ComplexityConfigFromEnv, type ComplexityConfig } from "./complexity"
import type { CacheControlConfig } from "./cache-control"
import { numberFromConfig } from "./config-number"

/**
 * Configuration for the GraphiQL UI
 */
export interface GraphiQLConfig {
  /** Path where GraphiQL UI is served (default: "/graphiql") */
  readonly path: string
  /** URL where GraphiQL sends requests (default: same as graphql path) */
  readonly endpoint: string
  /** WebSocket URL for subscriptions (default: same as endpoint) */
  readonly subscriptionEndpoint?: string
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
  path: Config.String("GRAPHQL_PATH").pipe(Config.withDefault("/graphql")),
  introspection: Config.Boolean("GRAPHQL_INTROSPECTION").pipe(Config.withDefault(true)),
  graphiqlEnabled: Config.Boolean("GRAPHIQL_ENABLED").pipe(Config.withDefault(false)),
  graphiqlPath: Config.String("GRAPHIQL_PATH").pipe(Config.withDefault("/graphiql")),
  graphiqlEndpoint: Config.String("GRAPHIQL_ENDPOINT").pipe(Config.option),
  complexity: ComplexityConfigFromEnv,
  cacheControlEnabled: Config.Boolean("GRAPHQL_CACHE_CONTROL_ENABLED").pipe(
    Config.withDefault(false)
  ),
  cacheControlDefaultMaxAge: Config.schema(
    numberFromConfig,
    "GRAPHQL_CACHE_CONTROL_DEFAULT_MAX_AGE"
  ).pipe(Config.withDefault(0)),
  cacheControlDefaultScope: Config.String("GRAPHQL_CACHE_CONTROL_DEFAULT_SCOPE").pipe(
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
      complexity,
      cacheControlEnabled,
      cacheControlDefaultMaxAge,
      cacheControlDefaultScope,
    }) => {
      // Check if any complexity option is set
      const hasComplexity =
        complexity.maxDepth !== undefined ||
        complexity.maxComplexity !== undefined ||
        complexity.maxAliases !== undefined ||
        complexity.maxFields !== undefined

      return {
        path,
        introspection,
        graphiql: graphiqlEnabled
          ? {
              path: graphiqlPath,
              endpoint: Option.isSome(graphiqlEndpoint) ? graphiqlEndpoint.value : path,
            }
          : (false as const),
        complexity: hasComplexity ? complexity : undefined,
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
