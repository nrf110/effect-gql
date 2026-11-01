import { describe, it, expect } from "vitest"
import { Config, ConfigProvider, Effect } from "effect"
import { buildSchema } from "graphql"
import {
  defaultConfig,
  GraphQLRouterConfigFromEnv,
  normalizeConfig,
} from "../../../src/server/config"
import { ComplexityConfigFromEnv, validateComplexity } from "../../../src/server/complexity"
import {
  CacheControlConfigFromEnv,
  computeCachePolicyFromQuery,
  toCacheControlHeader,
} from "../../../src/server/cache-control"

describe("config.ts", () => {
  // ==========================================================================
  // defaultConfig
  // ==========================================================================
  describe("defaultConfig", () => {
    it("should have correct default path", () => {
      expect(defaultConfig.path).toBe("/graphql")
    })

    it("should have graphiql disabled by default", () => {
      expect(defaultConfig.graphiql).toBe(false)
    })
  })

  // ==========================================================================
  // normalizeConfig
  // ==========================================================================
  describe("normalizeConfig", () => {
    describe("path configuration", () => {
      it("should use default path when not specified", () => {
        const config = normalizeConfig({})
        expect(config.path).toBe("/graphql")
      })

      it("should use custom path when specified", () => {
        const config = normalizeConfig({ path: "/api/graphql" })
        expect(config.path).toBe("/api/graphql")
      })
    })

    describe("graphiql disabled", () => {
      it("should disable graphiql by default", () => {
        const config = normalizeConfig({})
        expect(config.graphiql).toBe(false)
      })

      it("should disable graphiql when explicitly set to false", () => {
        const config = normalizeConfig({ graphiql: false })
        expect(config.graphiql).toBe(false)
      })
    })

    describe("graphiql enabled with boolean", () => {
      it("should enable graphiql with default paths when set to true", () => {
        const config = normalizeConfig({ graphiql: true })
        expect(config.graphiql).toEqual({
          path: "/graphiql",
          endpoint: "/graphql",
        })
      })

      it("should use custom graphql path as graphiql endpoint when graphiql is true", () => {
        const config = normalizeConfig({
          path: "/api/graphql",
          graphiql: true,
        })
        expect(config.graphiql).toEqual({
          path: "/graphiql",
          endpoint: "/api/graphql",
        })
      })
    })

    describe("graphiql enabled with object", () => {
      it("should use custom graphiql path", () => {
        const config = normalizeConfig({
          graphiql: { path: "/playground" },
        })
        expect(config.graphiql).toEqual({
          path: "/playground",
          endpoint: "/graphql",
        })
      })

      it("should use custom graphiql endpoint", () => {
        const config = normalizeConfig({
          graphiql: { endpoint: "/api/gql" },
        })
        expect(config.graphiql).toEqual({
          path: "/graphiql",
          endpoint: "/api/gql",
        })
      })

      it("should use both custom path and endpoint", () => {
        const config = normalizeConfig({
          graphiql: { path: "/playground", endpoint: "/api/gql" },
        })
        expect(config.graphiql).toEqual({
          path: "/playground",
          endpoint: "/api/gql",
        })
      })

      it("should use graphql path as default endpoint when only graphiql path is specified", () => {
        const config = normalizeConfig({
          path: "/v1/graphql",
          graphiql: { path: "/v1/playground" },
        })
        expect(config.graphiql).toEqual({
          path: "/v1/playground",
          endpoint: "/v1/graphql",
        })
      })
    })

    describe("empty config", () => {
      it("should handle undefined input", () => {
        const config = normalizeConfig(undefined)
        expect(config).toEqual({
          path: "/graphql",
          graphiql: false,
          complexity: undefined,
          introspection: true,
        })
      })

      it("should handle empty object input", () => {
        const config = normalizeConfig({})
        expect(config).toEqual({
          path: "/graphql",
          graphiql: false,
          complexity: undefined,
          introspection: true,
        })
      })
    })
  })
})

const numericSettings = [
  ["GRAPHQL_MAX_DEPTH", "maxDepth"],
  ["GRAPHQL_MAX_COMPLEXITY", "maxComplexity"],
  ["GRAPHQL_MAX_ALIASES", "maxAliases"],
  ["GRAPHQL_MAX_FIELDS", "maxFields"],
  ["GRAPHQL_DEFAULT_FIELD_COMPLEXITY", "defaultFieldComplexity"],
] as const

const configSchema = buildSchema(`
  type Query { hello: String, user: User }
  type User { id: ID }
`)

describe.each([
  ["standalone", ComplexityConfigFromEnv],
  ["router", GraphQLRouterConfigFromEnv.pipe(Config.map((config) => config.complexity))],
] as const)("%s complexity environment configuration", (entrypoint, config) => {
  const load = (env: Record<string, string>) => config.parse(ConfigProvider.fromEnv({ env }))

  it.each(numericSettings)("rejects NaN for %s", async (variable) => {
    const result = await Effect.runPromise(Effect.result(load({ [variable]: "NaN" })))

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("ConfigError")
      expect(result.failure.message).toContain(variable)
    }
  })

  it.each([0, -1, 1.5, Infinity, -Infinity])("preserves numeric value %s", async (value) => {
    const env = Object.fromEntries(numericSettings.map(([variable]) => [variable, String(value)]))
    const loaded = await Effect.runPromise(load(env))

    expect(loaded).toEqual(
      Object.fromEntries(numericSettings.map(([, property]) => [property, value]))
    )
  })

  it("preserves absent limits and the default field cost", async () => {
    const loaded = await Effect.runPromise(load({}))

    expect(loaded).toEqual(
      entrypoint === "router"
        ? undefined
        : {
            maxDepth: undefined,
            maxComplexity: undefined,
            maxAliases: undefined,
            maxFields: undefined,
            defaultFieldComplexity: 1,
          }
    )
    expect(await Effect.runPromise(load({ GRAPHQL_MAX_DEPTH: "2" }))).toMatchObject({
      maxDepth: 2,
      defaultFieldComplexity: 1,
    })
  })

  it.each([
    ["GRAPHQL_MAX_DEPTH", "{ hello }", "{ user { id } }", "depth"],
    ["GRAPHQL_MAX_COMPLEXITY", "{ hello }", "{ a: hello b: hello }", "complexity"],
    ["GRAPHQL_MAX_ALIASES", "{ a: hello }", "{ a: hello b: hello }", "aliases"],
    ["GRAPHQL_MAX_FIELDS", "{ hello }", "{ hello user { id } }", "fields"],
  ] as const)("enforces the loaded %s limit", async (variable, allowed, rejected, limitType) => {
    const loaded = await Effect.runPromise(load({ [variable]: "1" }))
    if (!loaded) throw new Error("Expected configured complexity limits")

    const accepted = await Effect.runPromise(
      Effect.result(
        validateComplexity(allowed, undefined, undefined, configSchema, new Map(), loaded)
      )
    )
    expect(accepted._tag).toBe("Success")

    const result = await Effect.runPromise(
      Effect.result(
        validateComplexity(rejected, undefined, undefined, configSchema, new Map(), loaded)
      )
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({
        _tag: "ComplexityLimitExceededError",
        limitType,
        limit: 1,
      })
    }
  })

  it("uses the configured field cost when enforcing complexity", async () => {
    const loaded = await Effect.runPromise(
      load({ GRAPHQL_MAX_COMPLEXITY: "2", GRAPHQL_DEFAULT_FIELD_COMPLEXITY: "3" })
    )
    if (!loaded) throw new Error("Expected configured complexity limits")

    const result = await Effect.runPromise(
      Effect.result(
        validateComplexity("{ hello }", undefined, undefined, configSchema, new Map(), loaded)
      )
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({
        _tag: "ComplexityLimitExceededError",
        limitType: "complexity",
        limit: 2,
        actual: 3,
      })
    }
  })
})

describe.each([
  ["standalone", CacheControlConfigFromEnv],
  ["router", GraphQLRouterConfigFromEnv.pipe(Config.map((config) => config.cacheControl))],
] as const)("%s cache control environment configuration", (entrypoint, config) => {
  const load = (env: Record<string, string>) => config.parse(ConfigProvider.fromEnv({ env }))

  it.each([undefined, "false", "true"])("rejects NaN with enabled=%s", async (enabled) => {
    const env: Record<string, string> = { GRAPHQL_CACHE_CONTROL_DEFAULT_MAX_AGE: "NaN" }
    if (enabled !== undefined) env.GRAPHQL_CACHE_CONTROL_ENABLED = enabled
    const result = await Effect.runPromise(Effect.result(load(env)))

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("ConfigError")
      expect(result.failure.message).toContain("GRAPHQL_CACHE_CONTROL_DEFAULT_MAX_AGE")
    }
  })

  it.each([0, -1, 1.5, 60, Infinity, -Infinity])(
    "preserves max age %s in the computed policy and header",
    async (value) => {
      for (const scope of ["PUBLIC", "PRIVATE"] as const) {
        const loaded = await Effect.runPromise(
          load({
            GRAPHQL_CACHE_CONTROL_ENABLED: "true",
            GRAPHQL_CACHE_CONTROL_DEFAULT_MAX_AGE: String(value),
            GRAPHQL_CACHE_CONTROL_DEFAULT_SCOPE: scope,
          })
        )
        if (!loaded) throw new Error("Expected enabled cache control")
        expect(loaded.defaultMaxAge).toBe(value)

        const policy = await Effect.runPromise(
          computeCachePolicyFromQuery("{ hello }", undefined, configSchema, new Map(), loaded)
        )
        expect(policy).toEqual({ maxAge: value, scope })
        expect(toCacheControlHeader(policy)).toBe(
          value === 0 ? "no-store" : `${scope.toLowerCase()}, max-age=${value}`
        )
      }
    }
  )

  it("does not load environment settings belonging only to the other entrypoint", async () => {
    const unrelatedVariable =
      entrypoint === "standalone" ? "GRAPHQL_MAX_DEPTH" : "GRAPHQL_CACHE_CONTROL_HTTP_HEADERS"
    const loaded = await Effect.runPromise(
      load({
        GRAPHQL_CACHE_CONTROL_ENABLED: "true",
        GRAPHQL_CACHE_CONTROL_DEFAULT_MAX_AGE: "60",
        [unrelatedVariable]: "not-a-valid-value",
      })
    )
    expect(loaded).toMatchObject({ enabled: true, defaultMaxAge: 60 })
  })
})
