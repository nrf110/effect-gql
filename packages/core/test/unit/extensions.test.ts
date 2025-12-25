import { describe, it, expect, vi } from "vitest"
import { Effect, Layer, Ref } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder } from "../../src/builder/schema-builder"
import { execute } from "../../src/builder/execute"
import {
  ExtensionsService,
  makeExtensionsService,
  runParseHooks,
  runValidateHooks,
  runExecuteStartHooks,
  runExecuteEndHooks,
  type GraphQLExtension,
} from "../../src/extensions"
import { parse, validate, buildSchema } from "graphql"

describe("extensions.ts", () => {
  // ==========================================================================
  // ExtensionsService
  // ==========================================================================
  describe("ExtensionsService", () => {
    it("should set a value", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* makeExtensionsService()
          yield* service.set("key", "value")
          return yield* service.get()
        })
      )

      expect(result).toEqual({ key: "value" })
    })

    it("should overwrite existing value with set", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* makeExtensionsService()
          yield* service.set("key", "first")
          yield* service.set("key", "second")
          return yield* service.get()
        })
      )

      expect(result).toEqual({ key: "second" })
    })

    it("should merge values into existing key", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* makeExtensionsService()
          yield* service.set("tracing", { startTime: 100 })
          yield* service.merge("tracing", { endTime: 200 })
          return yield* service.get()
        })
      )

      expect(result).toEqual({
        tracing: { startTime: 100, endTime: 200 },
      })
    })

    it("should deep merge nested objects", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* makeExtensionsService()
          yield* service.set("nested", { a: { b: 1 } })
          yield* service.merge("nested", { a: { c: 2 } })
          return yield* service.get()
        })
      )

      expect(result).toEqual({
        nested: { a: { b: 1, c: 2 } },
      })
    })

    it("should set value if key does not exist during merge", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* makeExtensionsService()
          yield* service.merge("newKey", { value: 42 })
          return yield* service.get()
        })
      )

      expect(result).toEqual({ newKey: { value: 42 } })
    })

    it("should support multiple keys", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* makeExtensionsService()
          yield* service.set("a", 1)
          yield* service.set("b", 2)
          yield* service.set("c", 3)
          return yield* service.get()
        })
      )

      expect(result).toEqual({ a: 1, b: 2, c: 3 })
    })
  })

  // ==========================================================================
  // Lifecycle hook runners
  // ==========================================================================
  describe("Lifecycle hook runners", () => {
    it("should run onParse hooks in order", async () => {
      const order: string[] = []
      const extensions: GraphQLExtension[] = [
        { name: "first", onParse: () => Effect.sync(() => order.push("first")) },
        { name: "second", onParse: () => Effect.sync(() => order.push("second")) },
        { name: "third", onParse: () => Effect.sync(() => order.push("third")) },
      ]

      const document = parse("{ test }")
      await Effect.runPromise(
        runParseHooks(extensions, "{ test }", document)
      )

      expect(order).toEqual(["first", "second", "third"])
    })

    it("should run onValidate hooks", async () => {
      const hookRan = { value: false }
      const extensions: GraphQLExtension[] = [
        {
          name: "validator",
          onValidate: (doc, errors) =>
            Effect.sync(() => {
              hookRan.value = true
              expect(errors).toHaveLength(0)
            }),
        },
      ]

      const document = parse("{ test }")
      const schema = buildSchema("type Query { test: String }")
      const errors = validate(schema, document)

      await Effect.runPromise(
        runValidateHooks(extensions, document, errors)
      )

      expect(hookRan.value).toBe(true)
    })

    it("should run onExecuteStart hooks", async () => {
      const capturedArgs = { value: null as any }
      const extensions: GraphQLExtension[] = [
        {
          name: "tracer",
          onExecuteStart: (args) =>
            Effect.sync(() => {
              capturedArgs.value = args
            }),
        },
      ]

      const document = parse("{ test }")
      const args = {
        source: "{ test }",
        document,
        variableValues: { foo: "bar" },
        operationName: "Test",
      }

      await Effect.runPromise(runExecuteStartHooks(extensions, args))

      expect(capturedArgs.value).toEqual(args)
    })

    it("should run onExecuteEnd hooks", async () => {
      const capturedResult = { value: null as any }
      const extensions: GraphQLExtension[] = [
        {
          name: "logger",
          onExecuteEnd: (result) =>
            Effect.sync(() => {
              capturedResult.value = result
            }),
        },
      ]

      const result = { data: { test: "value" } }

      await Effect.runPromise(runExecuteEndHooks(extensions, result))

      expect(capturedResult.value).toEqual(result)
    })

    it("should skip extensions without the hook defined", async () => {
      const order: string[] = []
      const extensions: GraphQLExtension[] = [
        { name: "first", onParse: () => Effect.sync(() => order.push("first")) },
        { name: "noHook" }, // No onParse hook
        { name: "third", onParse: () => Effect.sync(() => order.push("third")) },
      ]

      const document = parse("{ test }")
      await Effect.runPromise(runParseHooks(extensions, "{ test }", document))

      expect(order).toEqual(["first", "third"])
    })

    it("should continue if a hook fails", async () => {
      const order: string[] = []
      const extensions: GraphQLExtension[] = [
        { name: "first", onParse: () => Effect.sync(() => order.push("first")) },
        { name: "failing", onParse: () => Effect.die(new Error("Hook failed")) },
        { name: "third", onParse: () => Effect.sync(() => order.push("third")) },
      ]

      const document = parse("{ test }")
      await Effect.runPromise(runParseHooks(extensions, "{ test }", document))

      // Should continue despite the failure
      expect(order).toEqual(["first", "third"])
    })
  })

  // ==========================================================================
  // GraphQLSchemaBuilder extension() method
  // ==========================================================================
  describe("GraphQLSchemaBuilder.extension()", () => {
    it("should add extension to builder", () => {
      const builder = GraphQLSchemaBuilder.empty.extension({
        name: "test",
      })

      const extensions = builder.getExtensions()
      expect(extensions).toHaveLength(1)
      expect(extensions[0].name).toBe("test")
    })

    it("should accumulate multiple extensions", () => {
      const builder = GraphQLSchemaBuilder.empty
        .extension({ name: "first" })
        .extension({ name: "second" })
        .extension({ name: "third" })

      const extensions = builder.getExtensions()
      expect(extensions).toHaveLength(3)
      expect(extensions.map((e) => e.name)).toEqual(["first", "second", "third"])
    })

    it("should preserve extension hooks", () => {
      const onParse = () => Effect.void
      const onValidate = () => Effect.void
      const onExecuteStart = () => Effect.void
      const onExecuteEnd = () => Effect.void

      const builder = GraphQLSchemaBuilder.empty.extension({
        name: "withHooks",
        description: "Test extension",
        onParse,
        onValidate,
        onExecuteStart,
        onExecuteEnd,
      })

      const ext = builder.getExtensions()[0]
      expect(ext.description).toBe("Test extension")
      expect(ext.onParse).toBe(onParse)
      expect(ext.onValidate).toBe(onValidate)
      expect(ext.onExecuteStart).toBe(onExecuteStart)
      expect(ext.onExecuteEnd).toBe(onExecuteEnd)
    })
  })

  // ==========================================================================
  // Execute with extensions
  // ==========================================================================
  describe("execute() with extensions", () => {
    it("should run extension hooks during execution", async () => {
      const phases: string[] = []

      const schema = GraphQLSchemaBuilder.empty
        .query("test", {
          type: S.String,
          resolve: () => Effect.succeed("result"),
        })
        .buildSchema()

      const extensions: GraphQLExtension[] = [
        {
          name: "phase-tracker",
          onParse: () => Effect.sync(() => phases.push("parse")),
          onValidate: () => Effect.sync(() => phases.push("validate")),
          onExecuteStart: () => Effect.sync(() => phases.push("executeStart")),
          onExecuteEnd: () => Effect.sync(() => phases.push("executeEnd")),
        },
      ]

      const result = await Effect.runPromise(
        execute(schema, Layer.empty, extensions)("{ test }")
      )

      expect(result.data).toEqual({ test: "result" })
      expect(phases).toEqual(["parse", "validate", "executeStart", "executeEnd"])
    })

    it("should include extension data in response", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("test", {
          type: S.String,
          resolve: () => Effect.succeed("result"),
        })
        .buildSchema()

      const extensions: GraphQLExtension[] = [
        {
          name: "tracing",
          onExecuteStart: () =>
            Effect.gen(function* () {
              const ext = yield* ExtensionsService
              yield* ext.set("tracing", { startTime: 1000 })
            }),
          onExecuteEnd: () =>
            Effect.gen(function* () {
              const ext = yield* ExtensionsService
              yield* ext.merge("tracing", { endTime: 2000 })
            }),
        },
      ]

      const result = await Effect.runPromise(
        execute(schema, Layer.empty, extensions)("{ test }")
      )

      expect(result.data).toEqual({ test: "result" })
      expect(result.extensions).toEqual({
        tracing: { startTime: 1000, endTime: 2000 },
      })
    })

    it("should include multiple extension data sources", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("test", {
          type: S.String,
          resolve: () => Effect.succeed("result"),
        })
        .buildSchema()

      const extensions: GraphQLExtension[] = [
        {
          name: "timing",
          onExecuteEnd: () =>
            Effect.gen(function* () {
              const ext = yield* ExtensionsService
              yield* ext.set("timing", { duration: 100 })
            }),
        },
        {
          name: "complexity",
          onValidate: () =>
            Effect.gen(function* () {
              const ext = yield* ExtensionsService
              yield* ext.set("complexity", { score: 5 })
            }),
        },
      ]

      const result = await Effect.runPromise(
        execute(schema, Layer.empty, extensions)("{ test }")
      )

      expect(result.extensions).toEqual({
        timing: { duration: 100 },
        complexity: { score: 5 },
      })
    })

    it("should not include extensions field if no data was set", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("test", {
          type: S.String,
          resolve: () => Effect.succeed("result"),
        })
        .buildSchema()

      const extensions: GraphQLExtension[] = [
        {
          name: "empty",
          onParse: () => Effect.void,
        },
      ]

      const result = await Effect.runPromise(
        execute(schema, Layer.empty, extensions)("{ test }")
      )

      expect(result.data).toEqual({ test: "result" })
      expect(result.extensions).toBeUndefined()
    })

    it("should handle parse errors without executing", async () => {
      const phases: string[] = []

      const schema = GraphQLSchemaBuilder.empty
        .query("test", {
          type: S.String,
          resolve: () => Effect.succeed("result"),
        })
        .buildSchema()

      const extensions: GraphQLExtension[] = [
        {
          name: "tracker",
          onParse: () => Effect.sync(() => phases.push("parse")),
          onValidate: () => Effect.sync(() => phases.push("validate")),
          onExecuteStart: () => Effect.sync(() => phases.push("executeStart")),
          onExecuteEnd: () => Effect.sync(() => phases.push("executeEnd")),
        },
      ]

      const result = await Effect.runPromise(
        execute(schema, Layer.empty, extensions)("{ invalid syntax")
      )

      expect(result.errors).toBeDefined()
      // Parse hook should not run on parse error (happens before hooks)
      // No other hooks should run after parse error
      expect(phases).toEqual([])
    })

    it("should handle validation errors without executing", async () => {
      const phases: string[] = []

      const schema = GraphQLSchemaBuilder.empty
        .query("test", {
          type: S.String,
          resolve: () => Effect.succeed("result"),
        })
        .buildSchema()

      const extensions: GraphQLExtension[] = [
        {
          name: "tracker",
          onParse: () => Effect.sync(() => phases.push("parse")),
          onValidate: () => Effect.sync(() => phases.push("validate")),
          onExecuteStart: () => Effect.sync(() => phases.push("executeStart")),
          onExecuteEnd: () => Effect.sync(() => phases.push("executeEnd")),
        },
      ]

      const result = await Effect.runPromise(
        execute(schema, Layer.empty, extensions)("{ nonExistent }")
      )

      expect(result.errors).toBeDefined()
      // Parse and validate should run
      expect(phases).toEqual(["parse", "validate"])
    })
  })
})
