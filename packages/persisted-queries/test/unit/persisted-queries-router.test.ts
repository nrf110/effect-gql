import { describe, it, expect } from "vitest"
import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/http"
import {
  ExtensionsService,
  type GraphQLEffectContext,
  type GraphQLExtension,
} from "@effect-gql/core"
import { GraphQLSchema, GraphQLObjectType, GraphQLString, GraphQLNonNull } from "graphql"
import { makePersistedQueriesRouter, makeSafelistStore, computeHash } from "../../src"

// Create a simple schema for testing using graphql-js directly
const createTestSchema = () => {
  const queryType = new GraphQLObjectType({
    name: "Query",
    fields: {
      hello: {
        type: GraphQLString,
        resolve: () => "world",
      },
      echo: {
        type: GraphQLString,
        args: {
          message: { type: new GraphQLNonNull(GraphQLString) },
        },
        resolve: (_: unknown, args: { message: string }) => args.message,
      },
    },
  })

  return new GraphQLSchema({ query: queryType })
}

// Helper to execute a POST request
const executePost = async (
  router: ReturnType<typeof makePersistedQueriesRouter>,
  body: Record<string, unknown>,
  path = "/graphql"
) => {
  const { handler, dispose } = HttpRouter.toWebHandler(router)
  try {
    const response = await handler(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
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

// Helper to execute a GET request
const executeGet = async (
  router: ReturnType<typeof makePersistedQueriesRouter>,
  params: Record<string, string>,
  path = "/graphql"
) => {
  const { handler, dispose } = HttpRouter.toWebHandler(router)
  try {
    const url = new URL(`http://localhost${path}`)
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
    const response = await handler(
      new Request(url.toString(), {
        method: "GET",
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

describe("makePersistedQueriesRouter", () => {
  describe("standard GraphQL operations", () => {
    it("should execute regular queries without persisted query extension", async () => {
      const schema = createTestSchema()
      const router = makePersistedQueriesRouter(schema, Layer.empty)

      const result = await executePost(router, {
        query: "{ hello }",
      })

      expect(result.body.data).toEqual({ hello: "world" })
    })

    it("should execute queries with variables", async () => {
      const schema = createTestSchema()
      const router = makePersistedQueriesRouter(schema, Layer.empty)

      const result = await executePost(router, {
        query: "query Echo($msg: String!) { echo(message: $msg) }",
        variables: { msg: "test message" },
      })

      expect(result.body.data).toEqual({ echo: "test message" })
    })
  })

  it("preserves request and middleware services in hooks and resolvers across APQ requests", async () => {
    class RequestIdentity extends Context.Service<RequestIdentity, { readonly id: string }>()(
      "persisted-query-test/RequestIdentity"
    ) {}
    class ResolverService extends Context.Service<ResolverService, { readonly prefix: string }>()(
      "persisted-query-test/ResolverService"
    ) {}

    const recordPhase = (phase: string) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const identity = yield* RequestIdentity
        const service = yield* ResolverService
        const extensions = yield* ExtensionsService
        yield* extensions.set(phase, [request.headers["x-request-id"], identity.id, service.prefix])
      })
    const extension: GraphQLExtension<
      HttpServerRequest.HttpServerRequest | RequestIdentity | ResolverService | ExtensionsService
    > = {
      name: "request-services",
      onParse: () => recordPhase("parse"),
      onValidate: () => recordPhase("validate"),
      onExecuteStart: () => recordPhase("start"),
      onExecuteEnd: () => recordPhase("end"),
    }
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          requestId: {
            type: GraphQLString,
            resolve: (
              _parent: unknown,
              _args: unknown,
              context: GraphQLEffectContext<
                HttpServerRequest.HttpServerRequest | RequestIdentity | ResolverService
              >
            ) =>
              Effect.runPromiseWith(context.services)(
                Effect.gen(function* () {
                  const request = yield* HttpServerRequest.HttpServerRequest
                  const identity = yield* RequestIdentity
                  const service = yield* ResolverService
                  return `${service.prefix}:${request.headers["x-request-id"]}:${identity.id}`
                })
              ),
          },
        },
      }),
    })
    const router = makePersistedQueriesRouter(
      schema,
      Layer.succeed(ResolverService, { prefix: "resolver" }),
      { extensions: [extension] }
    )
    const middleware = HttpRouter.middleware(
      (effect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          return yield* Effect.provideService(effect, RequestIdentity, {
            id: `middleware-${request.headers["x-request-id"]}`,
          })
        }),
      { global: true }
    )
    const { handler, dispose } = HttpRouter.toWebHandler(Layer.merge(router, middleware))
    const query = "{ requestId }"
    const hash = await Effect.runPromise(computeHash(query))
    const extensions = { persistedQuery: { version: 1, sha256Hash: hash } }

    try {
      for (const [method, id] of [
        ["POST", "first"],
        ["GET", "second"],
      ] as const) {
        const url = new URL("http://localhost/graphql")
        if (method === "GET") {
          url.searchParams.set("extensions", JSON.stringify(extensions))
        }
        const response = await handler(
          new Request(url, {
            method,
            headers: { "content-type": "application/json", "x-request-id": id },
            body: method === "POST" ? JSON.stringify({ query, extensions }) : undefined,
          })
        )
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
          data: { requestId: `resolver:${id}:middleware-${id}` },
          extensions: Object.fromEntries(
            ["parse", "validate", "start", "end"].map((phase) => [
              phase,
              [id, `middleware-${id}`, "resolver"],
            ])
          ),
        })
      }
    } finally {
      await dispose()
    }
  })

  describe("APQ mode", () => {
    it("should return PERSISTED_QUERY_NOT_FOUND for unknown hash without query", async () => {
      const schema = createTestSchema()
      const router = makePersistedQueriesRouter(schema, Layer.empty, {
        mode: "apq",
      })

      const result = await executePost(router, {
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: "abc123",
          },
        },
      })

      expect(result.body.errors).toHaveLength(1)
      expect(result.body.errors[0].extensions.code).toBe("PERSISTED_QUERY_NOT_FOUND")
    })

    it("should store and retrieve queries in APQ mode", async () => {
      const schema = createTestSchema()
      const router = makePersistedQueriesRouter(schema, Layer.empty, {
        mode: "apq",
      })

      const query = "{ hello }"
      const hash = await Effect.runPromise(computeHash(query))

      // First request: send hash + query (registers the query)
      const registerResult = await executePost(router, {
        query,
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: hash,
          },
        },
      })

      expect(registerResult.body.data).toEqual({ hello: "world" })

      // Second request: send only hash (should use stored query)
      const cachedResult = await executePost(router, {
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: hash,
          },
        },
      })

      expect(cachedResult.body.data).toEqual({ hello: "world" })
    })

    it("should reject hash mismatch when validateHash is enabled", async () => {
      const schema = createTestSchema()
      const router = makePersistedQueriesRouter(schema, Layer.empty, {
        mode: "apq",
        validateHash: true,
      })

      const result = await executePost(router, {
        query: "{ hello }",
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: "wrong-hash",
          },
        },
      })

      expect(result.body.errors).toHaveLength(1)
      expect(result.body.errors[0].extensions.code).toBe("PERSISTED_QUERY_HASH_MISMATCH")
    })

    it("should allow any hash when validateHash is disabled", async () => {
      const schema = createTestSchema()
      const router = makePersistedQueriesRouter(schema, Layer.empty, {
        mode: "apq",
        validateHash: false,
      })

      // First request with fake hash
      const result = await executePost(router, {
        query: "{ hello }",
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: "fake-hash-123",
          },
        },
      })

      expect(result.body.data).toEqual({ hello: "world" })

      // Second request should work with the fake hash
      const cachedResult = await executePost(router, {
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: "fake-hash-123",
          },
        },
      })

      expect(cachedResult.body.data).toEqual({ hello: "world" })
    })
  })

  describe("safelist mode", () => {
    it("should execute safelisted queries", async () => {
      const query = "{ hello }"
      const hash = await Effect.runPromise(computeHash(query))

      const schema = createTestSchema()
      const router = makePersistedQueriesRouter(schema, Layer.empty, {
        mode: "safelist",
        store: makeSafelistStore({ [hash]: query }),
      })

      const result = await executePost(router, {
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: hash,
          },
        },
      })

      expect(result.body.data).toEqual({ hello: "world" })
    })

    it("should reject unknown queries in safelist mode", async () => {
      const schema = createTestSchema()
      const router = makePersistedQueriesRouter(schema, Layer.empty, {
        mode: "safelist",
        store: makeSafelistStore({}),
      })

      const result = await executePost(router, {
        query: "{ hello }",
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: "some-hash",
          },
        },
      })

      expect(result.body.errors).toHaveLength(1)
      expect(result.body.errors[0].extensions.code).toBe("PERSISTED_QUERY_NOT_ALLOWED")
    })
  })

  describe("GET requests", () => {
    it("should handle GET requests with persisted queries", async () => {
      const query = "{ hello }"
      const hash = await Effect.runPromise(computeHash(query))

      const schema = createTestSchema()
      const router = makePersistedQueriesRouter(schema, Layer.empty, {
        mode: "apq",
        enableGet: true,
      })

      // First, register the query via POST
      await executePost(router, {
        query,
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: hash,
          },
        },
      })

      // Then execute via GET
      const result = await executeGet(router, {
        extensions: JSON.stringify({
          persistedQuery: {
            version: 1,
            sha256Hash: hash,
          },
        }),
      })

      expect(result.body.data).toEqual({ hello: "world" })
    })

    it("should handle GET requests with variables", async () => {
      const query = "query Echo($msg: String!) { echo(message: $msg) }"
      const hash = await Effect.runPromise(computeHash(query))

      const schema = createTestSchema()
      const router = makePersistedQueriesRouter(schema, Layer.empty, {
        mode: "safelist",
        store: makeSafelistStore({ [hash]: query }),
        enableGet: true,
      })

      const result = await executeGet(router, {
        extensions: JSON.stringify({
          persistedQuery: {
            version: 1,
            sha256Hash: hash,
          },
        }),
        variables: JSON.stringify({ msg: "hello from GET" }),
      })

      expect(result.body.data).toEqual({ echo: "hello from GET" })
    })
  })

  describe("version validation", () => {
    it("should reject unsupported persisted query version", async () => {
      const schema = createTestSchema()
      const router = makePersistedQueriesRouter(schema, Layer.empty)

      const result = await executePost(router, {
        query: "{ hello }",
        extensions: {
          persistedQuery: {
            version: 2,
            sha256Hash: "abc123",
          },
        },
      })

      expect(result.body.errors).toHaveLength(1)
      expect(result.body.errors[0].extensions.code).toBe("PERSISTED_QUERY_VERSION_NOT_SUPPORTED")
    })
  })

  describe("error handling", () => {
    it("should return GraphQL errors for invalid queries", async () => {
      const schema = createTestSchema()
      const router = makePersistedQueriesRouter(schema, Layer.empty)

      const result = await executePost(router, {
        query: "{ unknownField }",
      })

      expect(result.status).toBe(400)
      expect(result.body.errors).toBeDefined()
      expect(result.body.errors.length).toBeGreaterThan(0)
    })

    it("should return parse errors for malformed queries", async () => {
      const schema = createTestSchema()
      const router = makePersistedQueriesRouter(schema, Layer.empty)

      const result = await executePost(router, {
        query: "{ invalid query syntax",
      })

      expect(result.body.errors).toBeDefined()
      expect(result.body.errors[0].message).toContain("Syntax Error")
    })
  })

  describe("GraphiQL", () => {
    it("should serve GraphiQL when enabled", async () => {
      const schema = createTestSchema()
      const router = makePersistedQueriesRouter(schema, Layer.empty, {
        graphiql: { path: "/graphiql" },
      })

      const { handler, dispose } = HttpRouter.toWebHandler(router)
      try {
        const response = await handler(new Request("http://localhost/graphiql", { method: "GET" }))
        const html = await response.text()

        expect(response.status).toBe(200)
        expect(html).toContain("graphiql")
      } finally {
        await dispose()
      }
    })
  })
})
