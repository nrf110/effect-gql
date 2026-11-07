import { describe, it, expect } from "vitest"
import { Effect, Layer, Context } from "effect"
import * as S from "effect/Schema"
import * as Getter from "effect/SchemaGetter"
import { HttpRouter, HttpServerRequest } from "effect/http"
import type { ExecutionResult } from "graphql"
import { GraphQLSchemaBuilder } from "../../../src/builder/schema-builder"
import { toRouter } from "../../../src/server/schema-builder-extensions"
import { GraphQLRequestContext } from "../../../src/context"
import { extension } from "../../../src/builder/pipe-api"
import { ExtensionsService } from "../../../src/extensions"

// Test service
interface TestService {
  getMessage: () => string
}

const TestService = Context.Service<TestService>("TestService")

const testLayer = Layer.succeed(TestService, {
  getMessage: () => "Hello from service",
})

// Helper to convert router to a web handler and execute a request
const executeQuery = async <R>(
  builder: GraphQLSchemaBuilder<R>,
  layer: Layer.Layer<NoInfer<R>>,
  config: Parameters<typeof toRouter>[2],
  query: string,
  variables?: Record<string, unknown>
) => {
  const router = toRouter(builder, layer, config)
  const { handler, dispose } = HttpRouter.toWebHandler(router)

  try {
    const response = await handler(
      new Request(`http://localhost${config?.path ?? "/graphql"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      })
    )
    return (await response.json()) as ExecutionResult
  } finally {
    await dispose()
  }
}

// Helper to get GraphiQL page
const getGraphiQL = async <R>(
  builder: GraphQLSchemaBuilder<R>,
  layer: Layer.Layer<NoInfer<R>>,
  config: Parameters<typeof toRouter>[2],
  path: string
) => {
  const router = toRouter(builder, layer, config)
  const { handler, dispose } = HttpRouter.toWebHandler(router)

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
    it("provides hook extensions without erasing application or resolver requirements", async () => {
      const base = GraphQLSchemaBuilder.empty.query("hello", {
        type: S.String,
        resolve: () => Effect.succeed("world"),
      })
      const builtinHook = {
        name: "builtin",
        onExecuteStart: () =>
          Effect.gen(function* () {
            const extensions = yield* ExtensionsService
            yield* extensions.set("mark", "ready")
          }),
      }
      const applicationHook = {
        name: "application",
        onExecuteEnd: () =>
          Effect.gen(function* () {
            const extensions = yield* ExtensionsService
            const service = yield* TestService
            yield* extensions.set("message", service.getMessage())
          }),
      }
      const builders = [base.extension(builtinHook), base.pipe(extension(builtinHook))]
      for (const builder of builders) {
        const result = await executeQuery(
          builder,
          Layer.empty,
          { extensions: builder.getExtensions() },
          "{ hello }"
        )
        expect(result).toEqual({
          data: { hello: "world" },
          extensions: { mark: "ready" },
        })
      }
      for (const builder of [
        base.extension(builtinHook).extension(applicationHook),
        base.pipe(extension(builtinHook), extension(applicationHook)),
      ]) {
        // @ts-expect-error application hook services still come from the user layer
        toRouter(builder, Layer.empty)
        const result = await executeQuery(
          builder,
          testLayer,
          { extensions: builder.getExtensions() },
          "{ hello }"
        )
        expect(result).toEqual({
          data: { hello: "world" },
          extensions: { mark: "ready", message: "Hello from service" },
        })
      }

      const resolverBuilder = base.query("resolverExtension", {
        type: S.String,
        resolve: () => Effect.map(ExtensionsService, () => "provided by application"),
      })
      const _requiresResolverService = () => {
        // @ts-expect-error the built-in service is only injected into hooks, not resolvers
        toRouter(resolverBuilder.extension(builtinHook), Layer.empty)
        // @ts-expect-error pipe registration must not erase an existing resolver requirement
        toRouter(resolverBuilder.pipe(extension(builtinHook)), Layer.empty)
        const late = builders[0].query("late", {
          type: S.String,
          resolve: () => Effect.map(ExtensionsService, () => "late"),
        })
        // @ts-expect-error resolver requirements added after hooks are still required
        toRouter(late, Layer.empty)
      }
    })

    it("requires codec services while accepting layers that provide extra services", async () => {
      const Offset = Context.Service<number>("toRouter/DecodeOffset")
      const args = S.Struct({
        amount: S.String.pipe(
          S.decodeTo(S.Number, {
            decode: Getter.transformEffect((value) =>
              Effect.map(Offset, (offset) => Number(value) + offset)
            ),
            encode: Getter.transform(String),
          })
        ),
      })
      const builder = GraphQLSchemaBuilder.empty.query("amount", {
        type: S.Number,
        args,
        resolve: ({ amount }) => Effect.succeed(amount * 2),
      })
      // @ts-expect-error argument decoding needs Offset even though the resolver is pure
      toRouter(builder, Layer.empty)
      const requiredLayer = Layer.succeed(Offset, 10)
      toRouter(builder, requiredLayer)
      const result = await executeQuery(
        builder,
        Layer.merge(requiredLayer, testLayer),
        {},
        '{ amount(amount: "2") }'
      )
      expect(result).toEqual({ data: { amount: 24 } })
    })

    it("provides fresh request context without requiring it from the user layer", async () => {
      const requestBuilder = GraphQLSchemaBuilder.empty.query("authorization", {
        type: S.String,
        resolve: () =>
          Effect.map(GraphQLRequestContext, ({ request }) => request.headers.authorization ?? ""),
      })
      const builder = requestBuilder.query("message", {
        type: S.String,
        resolve: () => Effect.map(TestService, (service) => service.getMessage()),
      })
      const _requiresServices = () => {
        // @ts-expect-error only request context is supplied by the router
        toRouter(builder, Layer.empty)
      }
      const app = HttpRouter.toWebHandler(toRouter(builder, testLayer))
      const contextOnly = HttpRouter.toWebHandler(toRouter(requestBuilder, Layer.empty))
      try {
        for (const token of ["first", "second"]) {
          const response = await app.handler(
            new Request("http://localhost/graphql", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({ query: "{ authorization message }" }),
            })
          )
          expect(response.status).toBe(200)
          expect(await response.json()).toEqual({
            data: { authorization: `Bearer ${token}`, message: "Hello from service" },
          })
        }
        const response = await contextOnly.handler(
          new Request("http://localhost/graphql", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer context-only" },
            body: JSON.stringify({ query: "{ authorization }" }),
          })
        )
        expect(await response.json()).toEqual({ data: { authorization: "Bearer context-only" } })
      } finally {
        await Promise.all([app.dispose(), contextOnly.dispose()])
      }
    })

    it("uses HTTP-provided services in decoders and resolvers with fresh request scopes", async () => {
      const finalized: string[] = []
      const args = S.Struct({
        value: S.String.pipe(
          S.decodeTo(S.String, {
            decode: Getter.transformEffect((value) =>
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest
                const search = yield* HttpServerRequest.ParsedSearchParams
                const { route } = yield* HttpRouter.RouteContext
                return `${request.headers.authorization}:${search.token}:${route.path}:${value}`
              })
            ),
            encode: Getter.transform((value) => value),
          })
        ),
      })
      const requestBuilder = GraphQLSchemaBuilder.empty.query("request", {
        type: S.String,
        args,
        resolve: ({ value }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                finalized.push(request.headers.authorization ?? "")
              })
            )
            return value
          }),
      })
      const builder = requestBuilder.query("message", {
        type: S.String,
        resolve: () => Effect.map(TestService, (service) => service.getMessage()),
      })
      const _requiresApplicationServices = () => {
        // @ts-expect-error HTTP services do not satisfy application dependencies
        toRouter(builder, Layer.empty)
      }
      const contextOnly = HttpRouter.toWebHandler(toRouter(requestBuilder, Layer.empty))
      const app = HttpRouter.toWebHandler(toRouter(builder, testLayer))
      try {
        for (const [handler, token, withMessage] of [
          [contextOnly.handler, "first", false],
          [app.handler, "second", true],
        ] as const) {
          const response = await handler(
            new Request(`http://localhost/graphql?token=${token}`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: token },
              body: JSON.stringify({
                query: `{ request(value: "decoded") ${withMessage ? "message" : ""} }`,
              }),
            })
          )
          expect(response.status).toBe(200)
          expect(await response.json()).toEqual({
            data: {
              request: `${token}:${token}:/graphql:decoded`,
              ...(withMessage ? { message: "Hello from service" } : {}),
            },
          })
          expect(finalized).toContain(token)
        }
        expect(finalized).toEqual(["first", "second"])
      } finally {
        await Promise.all([app.dispose(), contextOnly.dispose()])
      }
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
      expect(result.errors?.[0].message).toContain("Query failed")
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
