import { describe, it, expect } from "vitest"
import { Effect, Layer, Context } from "effect"
import * as S from "effect/Schema"
import { HttpApp } from "@effect/platform"
import { GraphQLSchemaBuilder } from "../../../src/builder/schema-builder"
import { makeGraphQLRouter } from "../../../src/server/router"

// Test service
interface TestService {
  getValue: () => string
}

const TestService = Context.GenericTag<TestService>("TestService")

const testLayer = Layer.succeed(TestService, {
  getValue: () => "from-service",
})

// Helper to convert router to a web handler and execute a request
const executeQuery = async <R>(
  schema: ReturnType<GraphQLSchemaBuilder<never>["buildSchema"]>,
  layer: Layer.Layer<R>,
  config: Parameters<typeof makeGraphQLRouter>[2],
  query: string,
  variables?: Record<string, unknown>,
  operationName?: string
) => {
  const router = makeGraphQLRouter(schema, layer, config)
  const { handler, dispose } = HttpApp.toWebHandlerLayer(router, Layer.empty)

  try {
    const response = await handler(
      new Request(`http://localhost${config?.path ?? "/graphql"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables, operationName }),
      })
    )
    return await response.json()
  } finally {
    await dispose()
  }
}

// Helper to get GraphiQL page
const getGraphiQL = async <R>(
  schema: ReturnType<GraphQLSchemaBuilder<never>["buildSchema"]>,
  layer: Layer.Layer<R>,
  config: Parameters<typeof makeGraphQLRouter>[2],
  path: string
) => {
  const router = makeGraphQLRouter(schema, layer, config)
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

describe("router.ts", () => {
  // ==========================================================================
  // makeGraphQLRouter - Basic functionality
  // ==========================================================================
  describe("makeGraphQLRouter - Basic functionality", () => {
    it("should create a router from a GraphQL schema", () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        })
        .buildSchema()

      const router = makeGraphQLRouter(schema, Layer.empty)

      expect(router).toBeDefined()
    })

    it("should create routes for the configured path", () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        })
        .buildSchema()

      const router = makeGraphQLRouter(schema, Layer.empty, {
        path: "/custom-graphql",
      })

      expect(router).toBeDefined()
    })
  })

  // ==========================================================================
  // makeGraphQLRouter - GraphQL execution
  // ==========================================================================
  describe("makeGraphQLRouter - GraphQL execution", () => {
    it("should execute a simple query", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        })
        .buildSchema()

      const result = await executeQuery(schema, Layer.empty, {}, "{ hello }")

      expect(result).toEqual({ data: { hello: "world" } })
    })

    it("should execute a query with variables", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("greet", {
          type: S.String,
          args: S.Struct({ name: S.String }),
          resolve: (args) => Effect.succeed(`Hello, ${args.name}!`),
        })
        .buildSchema()

      const result = await executeQuery(
        schema,
        Layer.empty,
        {},
        "query Greet($name: String!) { greet(name: $name) }",
        { name: "World" }
      )

      expect(result).toEqual({ data: { greet: "Hello, World!" } })
    })

    it("should execute a query with operationName", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("a", { type: S.String, resolve: () => Effect.succeed("value-a") })
        .query("b", { type: S.String, resolve: () => Effect.succeed("value-b") })
        .buildSchema()

      const result = await executeQuery(
        schema,
        Layer.empty,
        {},
        "query GetA { a } query GetB { b }",
        undefined,
        "GetA"
      )

      expect(result).toEqual({ data: { a: "value-a" } })
    })

    it("should execute mutations", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("dummy", { type: S.String, resolve: () => Effect.succeed("") })
        .mutation("create", {
          type: S.String,
          args: S.Struct({ input: S.String }),
          resolve: (args) => Effect.succeed(`created: ${args.input}`),
        })
        .buildSchema()

      const result = await executeQuery(
        schema,
        Layer.empty,
        {},
        'mutation { create(input: "test") }'
      )

      expect(result).toEqual({ data: { create: "created: test" } })
    })
  })

  // ==========================================================================
  // makeGraphQLRouter - Service layer integration
  // ==========================================================================
  describe("makeGraphQLRouter - Service layer integration", () => {
    it("should provide services to resolvers", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("serviceValue", {
          type: S.String,
          resolve: () =>
            TestService.pipe(
              Effect.map((service) => service.getValue())
            ),
        })
        .buildSchema()

      const result = await executeQuery(
        schema,
        testLayer,
        {},
        "{ serviceValue }"
      )

      expect(result).toEqual({ data: { serviceValue: "from-service" } })
    })
  })

  // ==========================================================================
  // makeGraphQLRouter - Error handling
  // ==========================================================================
  describe("makeGraphQLRouter - Error handling", () => {
    it("should return GraphQL errors in response", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("fail", {
          type: S.String,
          resolve: () => Effect.fail(new Error("Resolver failed")),
        })
        .buildSchema()

      const result = await executeQuery(schema, Layer.empty, {}, "{ fail }")

      expect(result.errors).toBeDefined()
      expect(result.errors[0].message).toContain("Resolver failed")
    })

    it("should handle GraphQL syntax errors", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("test", {
          type: S.String,
          resolve: () => Effect.succeed("test"),
        })
        .buildSchema()

      const result = await executeQuery(
        schema,
        Layer.empty,
        {},
        "{ invalid syntax"
      )

      expect(result.errors).toBeDefined()
    })

    it("should handle unknown field errors", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("known", {
          type: S.String,
          resolve: () => Effect.succeed("known"),
        })
        .buildSchema()

      const result = await executeQuery(
        schema,
        Layer.empty,
        {},
        "{ unknownField }"
      )

      expect(result.errors).toBeDefined()
    })
  })

  // ==========================================================================
  // makeGraphQLRouter - GraphiQL configuration
  // ==========================================================================
  describe("makeGraphQLRouter - GraphiQL configuration", () => {
    it("should not serve GraphiQL by default", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("test", {
          type: S.String,
          resolve: () => Effect.succeed("test"),
        })
        .buildSchema()

      const result = await getGraphiQL(schema, Layer.empty, {}, "/graphiql")

      // Should return 404 or error since graphiql is disabled
      expect(result.status).not.toBe(200)
    })

    it("should serve GraphiQL when enabled with boolean", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("test", {
          type: S.String,
          resolve: () => Effect.succeed("test"),
        })
        .buildSchema()

      const result = await getGraphiQL(
        schema,
        Layer.empty,
        { graphiql: true },
        "/graphiql"
      )

      expect(result.status).toBe(200)
      expect(result.body).toContain("GraphiQL")
      expect(result.body).toContain("/graphql")
    })

    it("should serve GraphiQL at custom path", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("test", {
          type: S.String,
          resolve: () => Effect.succeed("test"),
        })
        .buildSchema()

      const result = await getGraphiQL(
        schema,
        Layer.empty,
        { graphiql: { path: "/playground" } },
        "/playground"
      )

      expect(result.status).toBe(200)
      expect(result.body).toContain("GraphiQL")
    })

    it("should configure GraphiQL with custom endpoint", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("test", {
          type: S.String,
          resolve: () => Effect.succeed("test"),
        })
        .buildSchema()

      const result = await getGraphiQL(
        schema,
        Layer.empty,
        {
          path: "/api/graphql",
          graphiql: { endpoint: "/api/graphql" },
        },
        "/graphiql"
      )

      expect(result.body).toContain("/api/graphql")
    })
  })

  // ==========================================================================
  // makeGraphQLRouter - Custom paths
  // ==========================================================================
  describe("makeGraphQLRouter - Custom paths", () => {
    it("should handle custom GraphQL path", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        })
        .buildSchema()

      const result = await executeQuery(
        schema,
        Layer.empty,
        { path: "/api/v1/graphql" },
        "{ hello }"
      )

      expect(result).toEqual({ data: { hello: "world" } })
    })
  })
})
