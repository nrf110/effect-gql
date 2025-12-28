import { describe, it, expect } from "vitest"
import { Effect, Layer, Context } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder } from "../../../src/builder/schema-builder"
import { execute } from "../../../src/builder/execute"

// Test service
interface TestService {
  getValue: () => string
}

const TestService = Context.GenericTag<TestService>("TestService")

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

    it("should use fresh layer per request", async () => {
      let callCount = 0
      const countingLayer = Layer.succeed(TestService, {
        getValue: () => {
          callCount++
          return `call-${callCount}`
        },
      })

      const schema = GraphQLSchemaBuilder.empty
        .query("value", {
          type: S.String,
          resolve: () =>
            Effect.gen(function* () {
              const service = yield* TestService
              return service.getValue()
            }),
        })
        .buildSchema()

      // Reset counter
      callCount = 0

      const result1 = await Effect.runPromise(execute(schema, countingLayer)(`query { value }`))
      const result2 = await Effect.runPromise(execute(schema, countingLayer)(`query { value }`))

      expect(result1.data).toEqual({ value: "call-1" })
      expect(result2.data).toEqual({ value: "call-2" })
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
