import { describe, it, expect } from "vitest"
import {
  defaultConfig,
  normalizeConfig,
} from "../../../src/server/config"

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
