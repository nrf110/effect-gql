import { describe, it, expect } from "vitest"
import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/http"
import type { CacheHintMap } from "@effect-gql/core/server"
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
      headers: response.headers,
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
      headers: response.headers,
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

  it("isolates authenticated APQ requests from an already-built resolver layer", async () => {
    const Resource = Context.Service<{
      readonly id: number
      readonly cache: Map<string, string>
      readonly isOpen: () => boolean
    }>("persisted-query-test/IsolatedResource")
    const acquired: number[] = []
    const released: number[] = []
    const resources: Array<Context.Service.Shape<typeof Resource>> = []
    const layer = Layer.effect(
      Resource,
      Effect.acquireRelease(
        Effect.sync(() => {
          const id = acquired.length + 1
          acquired.push(id)
          let open = true
          const resource = {
            id,
            cache: new Map<string, string>(),
            isOpen: () => open,
            close: () => {
              open = false
            },
          }
          resources.push(resource)
          return resource
        }),
        (resource) =>
          Effect.sync(() => {
            resource.close()
            released.push(resource.id)
          })
      )
    )
    const hookViewers: string[] = []
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          viewer: {
            type: GraphQLString,
            resolve: (
              _parent: unknown,
              _args: unknown,
              context: GraphQLEffectContext<
                Context.Service.Identifier<typeof Resource> | HttpServerRequest.HttpServerRequest
              >
            ) =>
              Effect.runPromiseWith(context.services)(
                Effect.gen(function* () {
                  const resource = yield* Resource
                  const request = yield* HttpServerRequest.HttpServerRequest
                  const name = request.headers.authorization
                  if (!resource.cache.has("viewer")) resource.cache.set("viewer", name)
                  return `${resource.id}:${resource.cache.get("viewer")}:${name}:${resource.isOpen()}`
                })
              ),
          },
          fail: {
            type: GraphQLString,
            resolve: () => {
              throw new Error("denied")
            },
          },
        },
      }),
    })
    const router = makePersistedQueriesRouter(schema, layer, {
      extensions: [
        {
          name: "request-layer",
          onExecuteEnd: () =>
            Effect.gen(function* () {
              const resource = yield* Resource
              const request = yield* HttpServerRequest.HttpServerRequest
              hookViewers.push(
                `${resource.id}:${request.headers.authorization}:${resource.isOpen()}`
              )
            }),
        },
      ],
    }).pipe(Layer.provideMerge(layer))
    const { handler, dispose } = HttpRouter.toWebHandler(router)
    const query = "{ viewer }"
    const hash = await Effect.runPromise(computeHash(query))
    const extensions = { persistedQuery: { version: 1, sha256Hash: hash } }
    try {
      const alice = await handler(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Alice" },
          body: JSON.stringify({ query, extensions }),
        })
      )
      expect(alice.status).toBe(200)
      expect(await alice.json()).toEqual({ data: { viewer: "2:Alice:Alice:true" } })
      expect(released).toEqual([2])
      expect(resources[0].isOpen()).toBe(true)
      const url = new URL("http://localhost/graphql")
      url.searchParams.set("extensions", JSON.stringify(extensions))
      const bob = await handler(new Request(url, { headers: { authorization: "Bob" } }))
      expect(bob.status).toBe(200)
      expect(await bob.json()).toEqual({ data: { viewer: "3:Bob:Bob:true" } })
      expect(released).toEqual([2, 3])
      expect(hookViewers).toEqual(["2:Alice:true", "3:Bob:true"])
      for (const [source, message] of [
        ["{ fail }", "denied"],
        ["{ missing }", "Cannot query field"],
      ]) {
        const response = await handler(
          new Request("http://localhost/graphql", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bob" },
            body: JSON.stringify({ query: source }),
          })
        )
        expect((await response.json()).errors[0].message).toContain(message)
      }
      expect(acquired).toEqual([1, 2, 3, 4, 5])
      expect(released).toEqual([2, 3, 4, 5])
      expect(resources[0].isOpen()).toBe(true)
      expect(resources[0].cache.size).toBe(0)
    } finally {
      await dispose()
    }
    expect(released).toEqual([2, 3, 4, 5, 1])
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

    it.each(["POST", "GET"] as const)(
      "denies unregistered text and hashes over %s before invoking resolvers",
      async (method) => {
        let resolverCalls = 0
        const schema = new GraphQLSchema({
          query: new GraphQLObjectType({
            name: "Query",
            fields: {
              secret: {
                type: GraphQLString,
                resolve: () => {
                  resolverCalls++
                  return "restricted"
                },
              },
            },
          }),
        })
        const router = makePersistedQueriesRouter(schema, Layer.empty, {
          mode: "safelist",
          store: makeSafelistStore({}),
          validateHash: false,
        })
        const extensionCases = [
          undefined,
          null,
          "invalid",
          { persistedQuery: null },
          { persistedQuery: {} },
          { persistedQuery: { version: "1", sha256Hash: "unknown" } },
          { persistedQuery: { version: 1, sha256Hash: 123 } },
          { persistedQuery: { version: 1, sha256Hash: "unknown" } },
        ]

        for (const extensions of extensionCases) {
          const body = { query: "{ secret }", extensions }
          const result =
            method === "POST"
              ? await executePost(router, body)
              : await executeGet(router, {
                  query: body.query,
                  ...(extensions === undefined ? {} : { extensions: JSON.stringify(extensions) }),
                })
          expect(result.body.errors[0].extensions.code).toBe("PERSISTED_QUERY_NOT_ALLOWED")
          expect(result.body.data).toBeUndefined()
          expect(resolverCalls).toBe(0)
        }

        const extensions = { persistedQuery: { version: 1, sha256Hash: "unknown" } }
        const hashOnly =
          method === "POST"
            ? await executePost(router, { extensions })
            : await executeGet(router, { extensions: JSON.stringify(extensions) })
        expect(hashOnly.body.errors[0].extensions.code).toBe("PERSISTED_QUERY_NOT_ALLOWED")
        expect(resolverCalls).toBe(0)

        const invalidVersion = {
          query: "{ secret }",
          extensions: { persistedQuery: { version: 2, sha256Hash: "unknown" } },
        }
        const versionResult =
          method === "POST"
            ? await executePost(router, invalidVersion)
            : await executeGet(router, {
                query: invalidVersion.query,
                extensions: JSON.stringify(invalidVersion.extensions),
              })
        expect(versionResult.body.errors[0].extensions.code).toBe(
          "PERSISTED_QUERY_VERSION_NOT_SUPPORTED"
        )
        expect(resolverCalls).toBe(0)
      }
    )

    it.each(["POST", "GET"] as const)(
      "checks plain text with the configured algorithm and executes only stored text over %s",
      async (method) => {
        let allowedCalls = 0
        let secretCalls = 0
        const query = "{ allowed }"
        const hash = await Effect.runPromise(computeHash(query, "sha512"))
        const schema = new GraphQLSchema({
          query: new GraphQLObjectType({
            name: "Query",
            fields: {
              allowed: {
                type: GraphQLString,
                resolve: () => {
                  allowedCalls++
                  return "approved"
                },
              },
              secret: {
                type: GraphQLString,
                resolve: () => {
                  secretCalls++
                  return "restricted"
                },
              },
            },
          }),
        })
        const router = makePersistedQueriesRouter(schema, Layer.empty, {
          mode: "safelist",
          hashAlgorithm: "sha512",
          store: makeSafelistStore({ [hash]: query }),
        })
        const bodies = [
          { query },
          { query, extensions: { persistedQuery: null } },
          {
            query: "{ secret }",
            extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
          },
          { extensions: { persistedQuery: { version: 1, sha256Hash: hash } } },
        ]
        for (const body of bodies) {
          const result =
            method === "POST"
              ? await executePost(router, body)
              : await executeGet(router, {
                  ...(body.query ? { query: body.query } : {}),
                  ...(body.extensions ? { extensions: JSON.stringify(body.extensions) } : {}),
                })
          expect(result.body.data).toEqual({ allowed: "approved" })
          expect(result.body.errors).toBeUndefined()
        }
        expect(allowedCalls).toBe(4)
        expect(secretCalls).toBe(0)
      }
    )
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

  describe("HTTP cache control", () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          publicData: { type: GraphQLString, resolve: () => "public" },
          privateData: { type: GraphQLString, resolve: () => "private" },
          uncached: { type: GraphQLString, resolve: () => "uncached" },
          broken: {
            type: GraphQLString,
            resolve: () => {
              throw new Error("resolver failed")
            },
          },
        },
      }),
      mutation: new GraphQLObjectType({
        name: "Mutation",
        fields: { update: { type: GraphQLString, resolve: () => "updated" } },
      }),
    })
    const cacheHints: CacheHintMap = new Map([
      ["Query.publicData", { maxAge: 120 }],
      ["Query.privateData", { maxAge: 30, scope: "PRIVATE" }],
      ["Query.broken", { maxAge: 120 }],
      ["Mutation.update", { maxAge: 120 }],
    ])

    describe.each(["POST", "GET"] as const)("%s responses", (method) => {
      it.each([
        {
          query: "{ publicData }",
          header: "public, max-age=120",
          data: { publicData: "public" },
        },
        {
          query: "{ publicData privateData }",
          header: "private, max-age=30",
          data: { publicData: "public", privateData: "private" },
        },
        {
          query: "{ publicData uncached }",
          header: "no-store",
          data: { publicData: "public", uncached: "uncached" },
        },
      ])("sets the effective policy for $query", async ({ query, header, data }) => {
        const hash = await Effect.runPromise(computeHash(query))
        const router = makePersistedQueriesRouter(schema, Layer.empty, {
          mode: "safelist",
          store: makeSafelistStore({ [hash]: query }),
          cacheHints,
        })
        const extensions = { persistedQuery: { version: 1, sha256Hash: hash } }
        const result =
          method === "POST"
            ? await executePost(router, { extensions })
            : await executeGet(router, { extensions: JSON.stringify(extensions) })
        expect(result.body.data).toEqual(data)
        expect(result.headers.get("cache-control")).toBe(header)
      })

      it.each([{ enabled: false }, { calculateHttpHeaders: false }])(
        "omits headers when cache control is disabled: %j",
        async (cacheControl) => {
          const router = makePersistedQueriesRouter(schema, Layer.empty, {
            cacheHints,
            cacheControl,
          })
          const query = "{ publicData }"
          const result =
            method === "POST"
              ? await executePost(router, { query })
              : await executeGet(router, { query })
          expect(result.body.data).toEqual({ publicData: "public" })
          expect(result.headers.get("cache-control")).toBeNull()
        }
      )

      it("honors the selected operation rather than other definitions", async () => {
        const router = makePersistedQueriesRouter(schema, Layer.empty, { cacheHints })
        const query =
          "query Public { publicData } query Private { privateData } mutation Update { update }"
        for (const [operationName, header, data] of [
          ["Private", "private, max-age=30", { privateData: "private" }],
          ["Update", null, { update: "updated" }],
          ["Public", "public, max-age=120", { publicData: "public" }],
        ] as const) {
          const result =
            method === "POST"
              ? await executePost(router, { query, operationName })
              : await executeGet(router, { query, operationName })
          expect(result.body.data).toEqual(data)
          expect(result.headers.get("cache-control")).toBe(header)
        }
      })

      it("does not cache resolver failures or ambiguous operation selection", async () => {
        const router = makePersistedQueriesRouter(schema, Layer.empty, { cacheHints })
        for (const [query, data] of [
          ["{ publicData broken }", { publicData: "public", broken: null }],
          ["query One { publicData } query Two { privateData }", undefined],
        ] as const) {
          const result =
            method === "POST"
              ? await executePost(router, { query })
              : await executeGet(router, { query })
          expect(result.body.errors).toHaveLength(1)
          expect(result.body.data).toEqual(data)
          expect(result.headers.get("cache-control")).toBe("no-store")
        }
      })

      it("uses configured default age and scope for fields without hints", async () => {
        const router = makePersistedQueriesRouter(schema, Layer.empty, {
          cacheControl: { defaultMaxAge: 45, defaultScope: "PRIVATE" },
        })
        const query = "{ uncached }"
        const result =
          method === "POST"
            ? await executePost(router, { query })
            : await executeGet(router, { query })
        expect(result.body.data).toEqual({ uncached: "uncached" })
        expect(result.headers.get("cache-control")).toBe("private, max-age=45")
      })
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
