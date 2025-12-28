import { describe, it, expect } from "vitest"
import { Effect, Layer, Context } from "effect"
import * as S from "effect/Schema"
import { HttpApp } from "@effect/platform"
import { GraphQLSchemaBuilder } from "../../../src/builder/schema-builder"
import { toRouter } from "../../../src/server/schema-builder-extensions"

// Test service
interface TestService {
  getMessage: () => string
}

const TestService = Context.GenericTag<TestService>("TestService")

const testLayer = Layer.succeed(TestService, {
  getMessage: () => "Hello from service",
})

// Helper to convert router to a web handler and execute a request
const executeQuery = async <R1, R2>(
  builder: GraphQLSchemaBuilder<R1>,
  layer: Layer.Layer<R2>,
  config: Parameters<typeof toRouter>[2],
  query: string,
  variables?: Record<string, unknown>
) => {
  const router = toRouter(builder, layer, config)
  const { handler, dispose } = HttpApp.toWebHandlerLayer(router, Layer.empty)

  try {
    const response = await handler(
      new Request(`http://localhost${config?.path ?? "/graphql"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      })
    )
    return await response.json()
  } finally {
    await dispose()
  }
}

// Helper to get GraphiQL page
const getGraphiQL = async <R1, R2>(
  builder: GraphQLSchemaBuilder<R1>,
  layer: Layer.Layer<R2>,
  config: Parameters<typeof toRouter>[2],
  path: string
) => {
  const router = toRouter(builder, layer, config)
  const { handler, dispose } = HttpApp.toWebHandlerLayer(router, Layer.empty)

  try {
    const response = await handler(
      new Request(`http://localhost${path}`, {
        method: "GET",
      })
    )
    return {
      status: response.status,
      body: await response.text(),
    }
  } finally {
    await dispose()
  }
}

describe("schema-builder-extensions.ts", () => {
  // ==========================================================================
  // toRouter - Basic functionality
  // ==========================================================================
  describe("toRouter - Basic functionality", () => {
    it("should create a router from a GraphQLSchemaBuilder", () => {
      const builder = GraphQLSchemaBuilder.empty.query("hello", {
        type: S.String,
        resolve: () => Effect.succeed("world"),
      })

      const router = toRouter(builder, Layer.empty)

      expect(router).toBeDefined()
    })

    it("should execute queries through the created router", async () => {
      const builder = GraphQLSchemaBuilder.empty.query("greeting", {
        type: S.String,
        resolve: () => Effect.succeed("Hello!"),
      })

      const result = await executeQuery(builder, Layer.empty, {}, "{ greeting }")

      expect(result).toEqual({ data: { greeting: "Hello!" } })
    })

    it("should pass layer to the router for service resolution", async () => {
      const builder = GraphQLSchemaBuilder.empty.query("message", {
        type: S.String,
        resolve: () => TestService.pipe(Effect.map((service) => service.getMessage())),
      })

      const result = await executeQuery(builder, testLayer, {}, "{ message }")

      expect(result).toEqual({ data: { message: "Hello from service" } })
    })
  })

  // ==========================================================================
  // toRouter - Configuration
  // ==========================================================================
  describe("toRouter - Configuration", () => {
    it("should accept custom path configuration", async () => {
      const builder = GraphQLSchemaBuilder.empty.query("test", {
        type: S.String,
        resolve: () => Effect.succeed("test"),
      })

      const result = await executeQuery(builder, Layer.empty, { path: "/api/gql" }, "{ test }")

      expect(result).toEqual({ data: { test: "test" } })
    })

    it("should enable GraphiQL with configuration", async () => {
      const builder = GraphQLSchemaBuilder.empty.query("test", {
        type: S.String,
        resolve: () => Effect.succeed("test"),
      })

      const result = await getGraphiQL(builder, Layer.empty, { graphiql: true }, "/graphiql")

      expect(result.status).toBe(200)
      expect(result.body).toContain("GraphiQL")
    })

    it("should use default configuration when not provided", async () => {
      const builder = GraphQLSchemaBuilder.empty.query("default", {
        type: S.String,
        resolve: () => Effect.succeed("value"),
      })

      const result = await executeQuery(builder, Layer.empty, undefined, "{ default }")

      expect(result).toEqual({ data: { default: "value" } })
    })
  })

  // ==========================================================================
  // toRouter - Complex schemas
  // ==========================================================================
  describe("toRouter - Complex schemas", () => {
    it("should handle schemas with multiple queries", async () => {
      const builder = GraphQLSchemaBuilder.empty
        .query("first", {
          type: S.String,
          resolve: () => Effect.succeed("first-value"),
        })
        .query("second", {
          type: S.String,
          resolve: () => Effect.succeed("second-value"),
        })

      const result = await executeQuery(builder, Layer.empty, {}, "{ first second }")

      expect(result).toEqual({
        data: {
          first: "first-value",
          second: "second-value",
        },
      })
    })

    it("should handle schemas with queries and mutations", async () => {
      const builder = GraphQLSchemaBuilder.empty
        .query("get", {
          type: S.String,
          resolve: () => Effect.succeed("get-value"),
        })
        .mutation("set", {
          type: S.String,
          args: S.Struct({ value: S.String }),
          resolve: (args) => Effect.succeed(`set: ${args.value}`),
        })

      // Test query
      const queryResult = await executeQuery(builder, Layer.empty, {}, "{ get }")
      expect(queryResult).toEqual({ data: { get: "get-value" } })

      // Test mutation
      const mutationResult = await executeQuery(
        builder,
        Layer.empty,
        {},
        'mutation { set(value: "test") }'
      )
      expect(mutationResult).toEqual({ data: { set: "set: test" } })
    })

    it("should handle schemas with object types", async () => {
      const UserSchema = S.Struct({
        id: S.String,
        name: S.String,
      })

      const builder = GraphQLSchemaBuilder.empty
        .objectType({
          name: "User",
          schema: UserSchema,
        })
        .query("user", {
          type: UserSchema,
          resolve: () =>
            Effect.succeed({
              id: "1",
              name: "Alice",
            }),
        })

      const result = await executeQuery(builder, Layer.empty, {}, "{ user { id name } }")

      expect(result).toEqual({
        data: {
          user: {
            id: "1",
            name: "Alice",
          },
        },
      })
    })
  })

  // ==========================================================================
  // toRouter - Error handling
  // ==========================================================================
  describe("toRouter - Error handling", () => {
    it("should return errors for failed resolvers", async () => {
      const builder = GraphQLSchemaBuilder.empty.query("failing", {
        type: S.String,
        resolve: () => Effect.fail(new Error("Query failed")),
      })

      const result = await executeQuery(builder, Layer.empty, {}, "{ failing }")

      expect(result.errors).toBeDefined()
      expect(result.errors[0].message).toContain("Query failed")
    })

    it("should handle validation errors gracefully", async () => {
      const builder = GraphQLSchemaBuilder.empty.query("test", {
        type: S.String,
        resolve: () => Effect.succeed("test"),
      })

      const result = await executeQuery(builder, Layer.empty, {}, "{ nonExistent }")

      expect(result.errors).toBeDefined()
    })
  })
})
