import { describe, it, expect } from "vitest"
import { Cause, Effect, Layer, Context } from "effect"
import * as S from "effect/Schema"
import { HttpApp, HttpServerResponse } from "@effect/platform"
import { GraphQLSchemaBuilder } from "../../../src/builder/schema-builder"
import { makeGraphQLRouter, defaultErrorHandler, type ErrorHandler } from "../../../src/server/router"
import type { ComplexityConfig } from "../../../src/server/complexity"

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

// Helper to execute a query and return the full response including status
const executeQueryWithResponse = async <R>(
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
    return {
      status: response.status,
      body: await response.json(),
    }
  } finally {
    await dispose()
  }
}

// Helper to send a raw body and get response (for testing malformed requests)
const executeRawRequest = async <R>(
  schema: ReturnType<GraphQLSchemaBuilder<never>["buildSchema"]>,
  layer: Layer.Layer<R>,
  config: Parameters<typeof makeGraphQLRouter>[2],
  body: string,
  contentType = "application/json"
) => {
  const router = makeGraphQLRouter(schema, layer, config)
  const { handler, dispose } = HttpApp.toWebHandlerLayer(router, Layer.empty)

  try {
    const response = await handler(
      new Request(`http://localhost${config?.path ?? "/graphql"}`, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      })
    )
    return {
      status: response.status,
      body: await response.json(),
    }
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

  // ==========================================================================
  // makeGraphQLRouter - Complexity limiting
  // ==========================================================================
  describe("makeGraphQLRouter - Complexity limiting", () => {
    // Schema with nested types for complexity testing
    const Post = S.Struct({
      id: S.String,
      title: S.String,
      content: S.String,
    })

    const User = S.Struct({
      id: S.String,
      name: S.String,
      email: S.String,
    })

    it("should allow queries within complexity limits", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("user", {
          type: User,
          args: S.Struct({ id: S.String }),
          resolve: (args) =>
            Effect.succeed({ id: args.id, name: "John", email: "john@example.com" }),
        })
        .buildSchema()

      const result = await executeQuery(
        schema,
        Layer.empty,
        {
          complexity: {
            maxDepth: 10,
            maxComplexity: 100,
          },
        },
        '{ user(id: "1") { id name } }'
      )

      expect(result).toEqual({
        data: { user: { id: "1", name: "John" } },
      })
    })

    it("should reject queries exceeding maxDepth", async () => {
      // Create a schema with nested object types
      const Comment = S.Struct({ id: S.String, text: S.String })
      const CommentName = "Comment"

      const PostWithComments = S.Struct({
        id: S.String,
        title: S.String,
        comments: S.Array(Comment),
      })
      const PostName = "Post"

      const UserWithPosts = S.Struct({
        id: S.String,
        name: S.String,
        posts: S.Array(PostWithComments),
      })
      const UserName = "UserWithPosts"

      const schema = GraphQLSchemaBuilder.empty
        .objectType({ name: CommentName, schema: Comment })
        .objectType({ name: PostName, schema: PostWithComments })
        .objectType({ name: UserName, schema: UserWithPosts })
        .query("user", {
          type: UserWithPosts,
          args: S.Struct({ id: S.String }),
          resolve: (args) =>
            Effect.succeed({
              id: args.id,
              name: "John",
              posts: [{ id: "1", title: "Post", comments: [{ id: "c1", text: "Comment" }] }],
            }),
        })
        .buildSchema()

      const result = await executeQuery(
        schema,
        Layer.empty,
        {
          complexity: {
            maxDepth: 2,
          },
        },
        '{ user(id: "1") { posts { comments { text } } } }'
      )

      expect(result.errors).toBeDefined()
      expect(result.errors[0].message).toContain("depth")
      expect(result.errors[0].extensions?.code).toBe("COMPLEXITY_LIMIT_EXCEEDED")
    })

    it("should reject queries exceeding maxComplexity", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("users", {
          type: S.Array(User),
          resolve: () =>
            Effect.succeed([
              { id: "1", name: "John", email: "john@example.com" },
              { id: "2", name: "Jane", email: "jane@example.com" },
            ]),
        })
        .buildSchema()

      const result = await executeQuery(
        schema,
        Layer.empty,
        {
          complexity: {
            maxComplexity: 3,
          },
        },
        "{ users { id name email } }"
      )

      expect(result.errors).toBeDefined()
      expect(result.errors[0].message).toContain("complexity")
      expect(result.errors[0].extensions?.code).toBe("COMPLEXITY_LIMIT_EXCEEDED")
    })

    it("should reject queries exceeding maxAliases", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        })
        .buildSchema()

      const result = await executeQuery(
        schema,
        Layer.empty,
        {
          complexity: {
            maxAliases: 2,
          },
        },
        "{ a1: hello a2: hello a3: hello a4: hello }"
      )

      expect(result.errors).toBeDefined()
      expect(result.errors[0].message).toContain("aliases")
      expect(result.errors[0].extensions?.code).toBe("COMPLEXITY_LIMIT_EXCEEDED")
    })

    it("should reject queries exceeding maxFields", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("user", {
          type: User,
          args: S.Struct({ id: S.String }),
          resolve: (args) =>
            Effect.succeed({ id: args.id, name: "John", email: "john@example.com" }),
        })
        .buildSchema()

      const result = await executeQuery(
        schema,
        Layer.empty,
        {
          complexity: {
            maxFields: 2,
          },
        },
        '{ user(id: "1") { id name email } }'
      )

      expect(result.errors).toBeDefined()
      expect(result.errors[0].message).toContain("fields")
      expect(result.errors[0].extensions?.code).toBe("COMPLEXITY_LIMIT_EXCEEDED")
    })

    it("should use field complexity from builder", async () => {
      const builder = GraphQLSchemaBuilder.empty
        .query("expensiveQuery", {
          type: S.String,
          complexity: 50, // High complexity cost
          resolve: () => Effect.succeed("result"),
        })

      const schema = builder.buildSchema()
      const fieldComplexities = builder.getFieldComplexities()

      const router = makeGraphQLRouter(schema, Layer.empty, {
        complexity: {
          maxComplexity: 30,
        },
        fieldComplexities,
      })
      const { handler, dispose } = HttpApp.toWebHandlerLayer(router, Layer.empty)

      try {
        const response = await handler(
          new Request("http://localhost/graphql", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: "{ expensiveQuery }" }),
          })
        )
        const result = await response.json()

        expect(result.errors).toBeDefined()
        expect(result.errors[0].message).toContain("complexity")
      } finally {
        await dispose()
      }
    })

    it("should use dynamic field complexity based on arguments", async () => {
      const builder = GraphQLSchemaBuilder.empty
        .query("users", {
          type: S.Array(User),
          args: S.Struct({ limit: S.optional(S.Number) }),
          // Complexity = limit * 2
          complexity: (args: Record<string, unknown>) => ((args.limit as number) ?? 10) * 2,
          resolve: (args) =>
            Effect.succeed(
              Array.from({ length: args.limit ?? 10 }, (_, i) => ({
                id: String(i),
                name: `User ${i}`,
                email: `user${i}@example.com`,
              }))
            ),
        })

      const schema = builder.buildSchema()
      const fieldComplexities = builder.getFieldComplexities()

      const router = makeGraphQLRouter(schema, Layer.empty, {
        complexity: {
          maxComplexity: 50,
        },
        fieldComplexities,
      })
      const { handler, dispose } = HttpApp.toWebHandlerLayer(router, Layer.empty)

      try {
        // limit: 100 would give complexity 200, exceeding limit of 50
        const response = await handler(
          new Request("http://localhost/graphql", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: "{ users(limit: 100) { id } }" }),
          })
        )
        const result = await response.json()

        expect(result.errors).toBeDefined()
        expect(result.errors[0].message).toContain("complexity")
      } finally {
        await dispose()
      }
    })

    it("should call onExceeded hook when limits are exceeded", async () => {
      let hookCalled = false
      let exceededInfo: any = null

      const schema = GraphQLSchemaBuilder.empty
        .query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        })
        .buildSchema()

      const result = await executeQuery(
        schema,
        Layer.empty,
        {
          complexity: {
            maxDepth: 0,
            onExceeded: (info) =>
              Effect.sync(() => {
                hookCalled = true
                exceededInfo = info
              }),
          },
        },
        "{ hello }"
      )

      expect(hookCalled).toBe(true)
      expect(exceededInfo?.exceededLimit).toBe("depth")
      expect(result.errors).toBeDefined()
    })

    it("should include complexity info in error extensions", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        })
        .buildSchema()

      const result = await executeQuery(
        schema,
        Layer.empty,
        {
          complexity: {
            maxDepth: 0,
          },
        },
        "{ hello }"
      )

      expect(result.errors).toBeDefined()
      expect(result.errors[0].extensions).toMatchObject({
        code: "COMPLEXITY_LIMIT_EXCEEDED",
        limitType: "depth",
        limit: 0,
      })
      expect(result.errors[0].extensions.actual).toBeGreaterThan(0)
    })

    it("should allow queries when no complexity config is provided", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        })
        .buildSchema()

      // No complexity config
      const result = await executeQuery(schema, Layer.empty, {}, "{ hello }")

      expect(result).toEqual({ data: { hello: "world" } })
    })
  })

  // ==========================================================================
  // makeGraphQLRouter - Error handler configuration
  // ==========================================================================
  describe("makeGraphQLRouter - Error handler configuration", () => {
    it("should use default error handler returning 500 for malformed JSON", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        })
        .buildSchema()

      // Send malformed JSON to trigger an error during body parsing
      const result = await executeRawRequest(schema, Layer.empty, {}, "{ invalid json")

      expect(result.status).toBe(500)
      expect(result.body.errors).toBeDefined()
      expect(result.body.errors[0].message).toBe("An error occurred processing your request")
    })

    it("should use custom error handler when provided", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        })
        .buildSchema()

      const customErrorHandler: ErrorHandler = () =>
        HttpServerResponse.json(
          {
            errors: [{ message: "Custom error response" }],
          },
          { status: 503 }
        ).pipe(Effect.orDie)

      // Send malformed JSON to trigger the custom error handler
      const result = await executeRawRequest(
        schema,
        Layer.empty,
        { errorHandler: customErrorHandler },
        "{ invalid json"
      )

      expect(result.status).toBe(503)
      expect(result.body.errors[0].message).toBe("Custom error response")
    })

    it("should pass error cause to custom error handler", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        })
        .buildSchema()

      let capturedCause: Cause.Cause<unknown> | null = null

      const customErrorHandler: ErrorHandler = (cause) => {
        capturedCause = cause
        return HttpServerResponse.json(
          {
            errors: [{ message: "Error captured" }],
          },
          { status: 500 }
        ).pipe(Effect.orDie)
      }

      // Send malformed JSON to trigger the custom error handler
      await executeRawRequest(
        schema,
        Layer.empty,
        { errorHandler: customErrorHandler },
        "{ invalid json"
      )

      expect(capturedCause).not.toBeNull()
      // The cause should contain an error about decoding/parsing
      const causeString = Cause.pretty(capturedCause!)
      expect(causeString.toLowerCase()).toContain("decode")
    })

    it("should return 500 for empty request body", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        })
        .buildSchema()

      // Send empty body to trigger an error
      const result = await executeRawRequest(schema, Layer.empty, {}, "")

      expect(result.status).toBe(500)
      expect(result.body.errors).toBeDefined()
    })
  })
})
