import { describe, it, expect } from "vitest"
import { Effect, Layer, Context } from "effect"
import {
  GraphQLRequestContext,
  makeRequestContextLayer,
} from "../../src/context"
import { runSyncWithLayer } from "../helpers/effect-test-utils"

describe("context.ts", () => {
  // ==========================================================================
  // GraphQLRequestContext Tag
  // ==========================================================================
  describe("GraphQLRequestContext Tag", () => {
    it("should be a valid Context.Tag", () => {
      expect(GraphQLRequestContext).toBeDefined()
      expect(Context.isTag(GraphQLRequestContext)).toBe(true)
    })

    it("should have the correct key", () => {
      expect(GraphQLRequestContext.key).toBe("GraphQLRequestContext")
    })
  })

  // ==========================================================================
  // makeRequestContextLayer
  // ==========================================================================
  describe("makeRequestContextLayer", () => {
    it("should create a layer with full context", () => {
      const context: GraphQLRequestContext = {
        request: {
          headers: { authorization: "Bearer token123" },
          query: "query { users { id } }",
          variables: { limit: 10 },
          operationName: "GetUsers",
        },
      }

      const layer = makeRequestContextLayer(context)
      expect(Layer.isLayer(layer)).toBe(true)

      const program = Effect.gen(function* () {
        const ctx = yield* GraphQLRequestContext
        return ctx
      })

      const result = runSyncWithLayer(program, layer)

      expect(result.request.headers).toEqual({ authorization: "Bearer token123" })
      expect(result.request.query).toBe("query { users { id } }")
      expect(result.request.variables).toEqual({ limit: 10 })
      expect(result.request.operationName).toBe("GetUsers")
    })

    it("should create a layer with minimal context (no variables/operationName)", () => {
      const context: GraphQLRequestContext = {
        request: {
          headers: {},
          query: "{ hello }",
        },
      }

      const layer = makeRequestContextLayer(context)

      const program = Effect.gen(function* () {
        const ctx = yield* GraphQLRequestContext
        return ctx
      })

      const result = runSyncWithLayer(program, layer)

      expect(result.request.headers).toEqual({})
      expect(result.request.query).toBe("{ hello }")
      expect(result.request.variables).toBeUndefined()
      expect(result.request.operationName).toBeUndefined()
    })

    it("should provide correct values to dependent effects", () => {
      const context: GraphQLRequestContext = {
        request: {
          headers: { "x-custom": "value" },
          query: "mutation { create }",
          variables: { input: { name: "test" } },
        },
      }

      const layer = makeRequestContextLayer(context)

      const program = Effect.gen(function* () {
        const ctx = yield* GraphQLRequestContext
        return {
          hasCustomHeader: "x-custom" in ctx.request.headers,
          isMutation: ctx.request.query.includes("mutation"),
          inputName: (ctx.request.variables?.input as { name: string })?.name,
        }
      })

      const result = runSyncWithLayer(program, layer)

      expect(result.hasCustomHeader).toBe(true)
      expect(result.isMutation).toBe(true)
      expect(result.inputName).toBe("test")
    })

    it("should be composable with other layers", () => {
      interface TestService {
        getValue: () => string
      }
      const TestService = Context.GenericTag<TestService>("TestService")

      const requestContext: GraphQLRequestContext = {
        request: {
          headers: {},
          query: "{ test }",
        },
      }

      const testLayer = Layer.succeed(TestService, {
        getValue: () => "test-value",
      })

      const combinedLayer = Layer.merge(
        makeRequestContextLayer(requestContext),
        testLayer
      )

      const program = Effect.gen(function* () {
        const ctx = yield* GraphQLRequestContext
        const service = yield* TestService
        return {
          query: ctx.request.query,
          value: service.getValue(),
        }
      })

      const result = runSyncWithLayer(program, combinedLayer)

      expect(result.query).toBe("{ test }")
      expect(result.value).toBe("test-value")
    })

    it("should handle empty headers correctly", () => {
      const context: GraphQLRequestContext = {
        request: {
          headers: {},
          query: "{ empty }",
        },
      }

      const layer = makeRequestContextLayer(context)

      const program = Effect.gen(function* () {
        const ctx = yield* GraphQLRequestContext
        return Object.keys(ctx.request.headers).length
      })

      const result = runSyncWithLayer(program, layer)
      expect(result).toBe(0)
    })
  })
})
