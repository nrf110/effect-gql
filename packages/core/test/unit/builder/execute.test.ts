import { describe, it, expect } from "vitest"
import { Effect, Layer, Context } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder } from "../../../src/builder/schema-builder"
import { execute } from "../../../src/builder/execute"

// Test service
interface TestService {
  getValue: () => string
}

const TestService = Context.Service<TestService>("TestService")

const testLayer = Layer.succeed(TestService, {
  getValue: () => "from-service",
})

describe("execute.ts", () => {
  // ==========================================================================
  // Basic execution
  // ==========================================================================
  describe("Basic execution", () => {
    it("should execute simple query", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        })
        .buildSchema()

      const result = await Effect.runPromise(execute(schema, Layer.empty)(`query { hello }`))

      expect(result.data).toEqual({ hello: "world" })
      expect(result.errors).toBeUndefined()
    })

    it("should execute query with variables", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("greet", {
          type: S.String,
          args: S.Struct({ name: S.String }),
          resolve: (args) => Effect.succeed(`Hello, ${args.name}!`),
        })
        .buildSchema()

      const result = await Effect.runPromise(
        execute(schema, Layer.empty)(`query Greet($name: String!) { greet(name: $name) }`, {
          name: "World",
        })
      )

      expect(result.data).toEqual({ greet: "Hello, World!" })
    })

    it("should execute query with operation name", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("a", { type: S.String, resolve: () => Effect.succeed("a") })
        .query("b", { type: S.String, resolve: () => Effect.succeed("b") })
        .buildSchema()

      const result = await Effect.runPromise(
        execute(schema, Layer.empty)(`query GetA { a } query GetB { b }`, undefined, "GetA")
      )

      expect(result.data).toEqual({ a: "a" })
    })
  })

  // ==========================================================================
  // Layer/Service integration
  // ==========================================================================
  describe("Layer/Service integration", () => {
    it("should provide services to resolvers via layer", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("serviceValue", {
          type: S.String,
          resolve: () =>
            Effect.gen(function* () {
              const service = yield* TestService
              return service.getValue()
            }),
        })
        .buildSchema()

      const result = await Effect.runPromise(execute(schema, testLayer)(`query { serviceValue }`))

      expect(result.data).toEqual({ serviceValue: "from-service" })
    })

    it("isolates request caches from the same ambient layer and releases only request resources", async () => {
      const Identity = Context.Service<{ readonly name: string }>("execute/Identity")
      const Resource = Context.Service<{
        readonly id: number
        readonly cache: Map<string, string>
        readonly isOpen: () => boolean
      }>("execute/IsolatedResource")
      const acquired: number[] = []
      const released: number[] = []
      const layer = Layer.effect(
        Resource,
        Effect.acquireRelease(
          Effect.sync(() => {
            const id = acquired.length + 1
            acquired.push(id)
            let open = true
            return {
              id,
              cache: new Map<string, string>(),
              isOpen: () => open,
              close: () => {
                open = false
              },
            }
          }),
          (resource) =>
            Effect.sync(() => {
              resource.close()
              released.push(resource.id)
            })
        )
      )
      const schema = GraphQLSchemaBuilder.empty
        .query("viewer", {
          type: S.String,
          resolve: () =>
            Effect.gen(function* () {
              const resource = yield* Resource
              const identity = yield* Identity
              if (!resource.cache.has("viewer")) resource.cache.set("viewer", identity.name)
              return `${resource.id}:${resource.cache.get("viewer")}:${identity.name}:${resource.isOpen()}`
            }),
        })
        .query("fail", { type: S.String, resolve: () => Effect.fail(new Error("denied")) })
        .buildSchema()

      await Effect.runPromise(
        Effect.gen(function* () {
          const outer = yield* Resource
          expect(outer.id).toBe(1)
          for (const [name, id] of [
            ["Alice", 2],
            ["Bob", 3],
          ] as const) {
            const result = yield* execute(
              schema,
              layer
            )("{ viewer }").pipe(Effect.provideService(Identity, { name }))
            expect(result.errors).toBeUndefined()
            expect(result.data).toEqual({ viewer: `${id}:${name}:${name}:true` })
            expect(released).toEqual(id === 2 ? [2] : [2, 3])
            expect(outer.isOpen()).toBe(true)
          }
          const failed = yield* execute(schema, layer)("{ fail }")
          expect(failed.errors?.[0].message).toContain("denied")
          const invalid = yield* execute(schema, layer)("{ missing }")
          expect(invalid.errors?.[0].message).toContain("Cannot query field")
          expect(acquired).toEqual([1, 2, 3, 4, 5])
          expect(released).toEqual([2, 3, 4, 5])
          expect(outer.isOpen()).toBe(true)
          expect(outer.cache.size).toBe(0)
        }).pipe(Effect.provide(layer))
      )
      expect(released).toEqual([2, 3, 4, 5, 1])
    })

    it("keeps scoped services alive until asynchronous resolvers finish", async () => {
      let open = false
      let releases = 0
      const Resource = Context.Service<{ readonly isOpen: () => boolean }>("execute/Resource")
      const layer = Layer.effect(
        Resource,
        Effect.acquireRelease(
          Effect.sync(() => {
            open = true
            return { isOpen: () => open }
          }),
          () =>
            Effect.sync(() => {
              open = false
              releases++
            })
        )
      )
      const schema = GraphQLSchemaBuilder.empty
        .query("open", {
          type: S.Boolean,
          resolve: () =>
            Effect.gen(function* () {
              const resource = yield* Resource
              yield* Effect.sleep("1 millis")
              return resource.isOpen()
            }),
        })
        .buildSchema()

      const result = await Effect.runPromise(execute(schema, layer)("{ open }"))

      expect(result.errors).toBeUndefined()
      expect(result.data).toEqual({ open: true })
      expect(open).toBe(false)
      expect(releases).toBe(1)
    })
  })

  // ==========================================================================
  // Error handling
  // ==========================================================================
  describe("Error handling", () => {
    it("should return GraphQL errors in result", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("fail", {
          type: S.String,
          resolve: () => Effect.fail(new Error("Resolver error")),
        })
        .buildSchema()

      const result = await Effect.runPromise(execute(schema, Layer.empty)(`query { fail }`))

      expect(result.errors).toBeDefined()
      expect(result.errors![0].message).toContain("Resolver error")
    })

    it("should handle GraphQL syntax errors", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("test", {
          type: S.String,
          resolve: () => Effect.succeed("test"),
        })
        .buildSchema()

      const result = await Effect.runPromise(execute(schema, Layer.empty)(`query { invalid syntax`))

      expect(result.errors).toBeDefined()
    })

    it("should handle field validation errors", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("test", {
          type: S.String,
          resolve: () => Effect.succeed("test"),
        })
        .buildSchema()

      const result = await Effect.runPromise(
        execute(schema, Layer.empty)(`query { nonExistentField }`)
      )

      expect(result.errors).toBeDefined()
    })
  })

  // ==========================================================================
  // Mutations
  // ==========================================================================
  describe("Mutations", () => {
    it("should execute mutation", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("dummy", { type: S.String, resolve: () => Effect.succeed("") })
        .mutation("createItem", {
          type: S.String,
          args: S.Struct({ name: S.String }),
          resolve: (args) => Effect.succeed(`Created: ${args.name}`),
        })
        .buildSchema()

      const result = await Effect.runPromise(
        execute(schema, Layer.empty)(`mutation { createItem(name: "test") }`)
      )

      expect(result.data).toEqual({ createItem: "Created: test" })
    })
  })
})
