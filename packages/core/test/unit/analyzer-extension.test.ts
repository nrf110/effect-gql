import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder } from "../../src/builder/schema-builder"
import { execute } from "../../src/builder/execute"
import { createAnalyzerExtension } from "../../src/analyzer-extension"
import { extension } from "../../src/builder/pipe-api"

describe("analyzer-extension.ts", () => {
  // ==========================================================================
  // Basic functionality
  // ==========================================================================
  describe("createAnalyzerExtension", () => {
    it("should include complexity and depth by default", async () => {
      const analyzer = createAnalyzerExtension()

      const builder = GraphQLSchemaBuilder.empty.pipe(extension(analyzer)).query("test", {
        type: S.String,
        resolve: () => Effect.succeed("result"),
      })

      const schema = builder.buildSchema()
      const extensions = builder.getExtensions()

      const result = await Effect.runPromise(execute(schema, Layer.empty, extensions)("{ test }"))

      expect(result.data).toEqual({ test: "result" })
      expect(result.extensions).toBeDefined()
      expect(result.extensions?.analyzer).toBeDefined()
      expect(result.extensions?.analyzer).toHaveProperty("complexity")
      expect(result.extensions?.analyzer).toHaveProperty("depth")
      expect(result.extensions?.analyzer).not.toHaveProperty("fieldCount")
      expect(result.extensions?.analyzer).not.toHaveProperty("aliasCount")
    })

    it("should calculate correct depth", async () => {
      const User = S.Struct({
        id: S.String,
        name: S.String,
      })

      const Post = S.Struct({
        id: S.String,
        title: S.String,
      })

      const analyzer = createAnalyzerExtension()

      const builder = GraphQLSchemaBuilder.empty
        .pipe(extension(analyzer))
        .objectType({ name: "User", schema: User })
        .objectType({ name: "Post", schema: Post })
        .field("User", "posts", {
          type: S.Array(Post),
          resolve: () => Effect.succeed([]),
        })
        .query("user", {
          type: User,
          resolve: () => Effect.succeed({ id: "1", name: "Test" }),
        })

      const schema = builder.buildSchema()
      const extensions = builder.getExtensions()

      // Depth 1: { user }
      const result1 = await Effect.runPromise(
        execute(schema, Layer.empty, extensions)("{ user { id } }")
      )
      expect(result1.extensions?.analyzer?.depth).toBe(2)

      // Depth 3: { user { posts { title } } }
      const result2 = await Effect.runPromise(
        execute(schema, Layer.empty, extensions)("{ user { posts { title } } }")
      )
      expect(result2.extensions?.analyzer?.depth).toBe(3)
    })

    it("should include fieldCount when configured", async () => {
      const analyzer = createAnalyzerExtension({
        includeFieldCount: true,
      })

      const builder = GraphQLSchemaBuilder.empty
        .pipe(extension(analyzer))
        .query("a", { type: S.String, resolve: () => Effect.succeed("a") })
        .query("b", { type: S.String, resolve: () => Effect.succeed("b") })
        .query("c", { type: S.String, resolve: () => Effect.succeed("c") })

      const schema = builder.buildSchema()
      const extensions = builder.getExtensions()

      const result = await Effect.runPromise(execute(schema, Layer.empty, extensions)("{ a b c }"))

      expect(result.extensions?.analyzer?.fieldCount).toBe(3)
    })

    it("should include aliasCount when configured", async () => {
      const analyzer = createAnalyzerExtension({
        includeAliasCount: true,
      })

      const builder = GraphQLSchemaBuilder.empty
        .pipe(extension(analyzer))
        .query("test", { type: S.String, resolve: () => Effect.succeed("value") })

      const schema = builder.buildSchema()
      const extensions = builder.getExtensions()

      const result = await Effect.runPromise(
        execute(schema, Layer.empty, extensions)("{ a: test b: test c: test }")
      )

      expect(result.extensions?.analyzer?.aliasCount).toBe(3)
    })

    it("should use custom key", async () => {
      const analyzer = createAnalyzerExtension({
        key: "queryStats",
      })

      const builder = GraphQLSchemaBuilder.empty
        .pipe(extension(analyzer))
        .query("test", { type: S.String, resolve: () => Effect.succeed("value") })

      const schema = builder.buildSchema()
      const extensions = builder.getExtensions()

      const result = await Effect.runPromise(execute(schema, Layer.empty, extensions)("{ test }"))

      expect(result.extensions?.queryStats).toBeDefined()
      expect(result.extensions?.analyzer).toBeUndefined()
    })

    it("should only include configured metrics", async () => {
      const analyzer = createAnalyzerExtension({
        includeComplexity: false,
        includeDepth: true,
        includeFieldCount: true,
        includeAliasCount: false,
      })

      const builder = GraphQLSchemaBuilder.empty
        .pipe(extension(analyzer))
        .query("test", { type: S.String, resolve: () => Effect.succeed("value") })

      const schema = builder.buildSchema()
      const extensions = builder.getExtensions()

      const result = await Effect.runPromise(execute(schema, Layer.empty, extensions)("{ test }"))

      const analyzerOutput = result.extensions?.analyzer
      expect(analyzerOutput).not.toHaveProperty("complexity")
      expect(analyzerOutput).toHaveProperty("depth")
      expect(analyzerOutput).toHaveProperty("fieldCount")
      expect(analyzerOutput).not.toHaveProperty("aliasCount")
    })
  })

  // ==========================================================================
  // Complexity calculation
  // ==========================================================================
  describe("complexity calculation", () => {
    it("should use default complexity of 1 per field", async () => {
      const analyzer = createAnalyzerExtension()

      const builder = GraphQLSchemaBuilder.empty
        .pipe(extension(analyzer))
        .query("a", { type: S.String, resolve: () => Effect.succeed("a") })
        .query("b", { type: S.String, resolve: () => Effect.succeed("b") })

      const schema = builder.buildSchema()
      const extensions = builder.getExtensions()

      const result = await Effect.runPromise(execute(schema, Layer.empty, extensions)("{ a b }"))

      expect(result.extensions?.analyzer?.complexity).toBe(2)
    })

    it("should use custom default field complexity", async () => {
      const analyzer = createAnalyzerExtension({
        defaultFieldComplexity: 5,
      })

      const builder = GraphQLSchemaBuilder.empty
        .pipe(extension(analyzer))
        .query("a", { type: S.String, resolve: () => Effect.succeed("a") })
        .query("b", { type: S.String, resolve: () => Effect.succeed("b") })

      const schema = builder.buildSchema()
      const extensions = builder.getExtensions()

      const result = await Effect.runPromise(execute(schema, Layer.empty, extensions)("{ a b }"))

      expect(result.extensions?.analyzer?.complexity).toBe(10)
    })

    it("should respect field complexity annotations from builder", async () => {
      const analyzer = createAnalyzerExtension()

      const builder = GraphQLSchemaBuilder.empty
        .pipe(extension(analyzer))
        .query("simple", {
          type: S.String,
          resolve: () => Effect.succeed("simple"),
          complexity: 1,
        })
        .query("expensive", {
          type: S.String,
          resolve: () => Effect.succeed("expensive"),
          complexity: 10,
        })

      const schema = builder.buildSchema()
      const extensions = builder.getExtensions()
      const fieldComplexities = builder.getFieldComplexities()

      // Execute with custom fieldComplexities from builder
      const result = await Effect.runPromise(
        execute(schema, Layer.empty, extensions, fieldComplexities)("{ simple expensive }")
      )

      expect(result.extensions?.analyzer?.complexity).toBe(11)
    })
  })

  // ==========================================================================
  // Thresholds
  // ==========================================================================
  describe("thresholds", () => {
    it("should not throw when thresholds are not exceeded", async () => {
      const analyzer = createAnalyzerExtension({
        thresholds: {
          depth: 10,
          complexity: 100,
        },
      })

      const builder = GraphQLSchemaBuilder.empty
        .pipe(extension(analyzer))
        .query("test", { type: S.String, resolve: () => Effect.succeed("value") })

      const schema = builder.buildSchema()
      const extensions = builder.getExtensions()

      const result = await Effect.runPromise(execute(schema, Layer.empty, extensions)("{ test }"))

      expect(result.data).toEqual({ test: "value" })
      expect(result.extensions?.analyzer).toBeDefined()
    })

    it("should log warning when threshold is exceeded but still return result", async () => {
      // Use a very low threshold to trigger warning
      const analyzer = createAnalyzerExtension({
        thresholds: {
          depth: 1,
        },
      })

      const User = S.Struct({ id: S.String, name: S.String })

      const builder = GraphQLSchemaBuilder.empty
        .pipe(extension(analyzer))
        .objectType({ name: "User", schema: User })
        .query("user", {
          type: User,
          resolve: () => Effect.succeed({ id: "1", name: "Test" }),
        })

      const schema = builder.buildSchema()
      const extensions = builder.getExtensions()

      // This query has depth 2 which exceeds threshold of 1
      const result = await Effect.runPromise(
        execute(schema, Layer.empty, extensions)("{ user { name } }")
      )

      // Should still succeed - thresholds only log warnings
      expect(result.data).toEqual({ user: { name: "Test" } })
      expect(result.extensions?.analyzer?.depth).toBe(2)
    })
  })

  // ==========================================================================
  // Edge cases
  // ==========================================================================
  describe("edge cases", () => {
    it("should handle queries with fragments", async () => {
      const analyzer = createAnalyzerExtension({
        includeFieldCount: true,
      })

      const User = S.Struct({ id: S.String, name: S.String })

      const builder = GraphQLSchemaBuilder.empty
        .pipe(extension(analyzer))
        .objectType({ name: "User", schema: User })
        .query("user", {
          type: User,
          resolve: () => Effect.succeed({ id: "1", name: "Test" }),
        })

      const schema = builder.buildSchema()
      const extensions = builder.getExtensions()

      const query = `
        query {
          user {
            ...UserFields
          }
        }
        fragment UserFields on User {
          id
          name
        }
      `

      const result = await Effect.runPromise(execute(schema, Layer.empty, extensions)(query))

      expect(result.data).toEqual({ user: { id: "1", name: "Test" } })
      expect(result.extensions?.analyzer).toBeDefined()
      expect(result.extensions?.analyzer?.fieldCount).toBeGreaterThan(0)
    })

    it("should handle queries with variables", async () => {
      const analyzer = createAnalyzerExtension()

      const builder = GraphQLSchemaBuilder.empty.pipe(extension(analyzer)).query("greeting", {
        type: S.String,
        args: S.Struct({ name: S.String }),
        resolve: ({ name }) => Effect.succeed(`Hello, ${name}!`),
      })

      const schema = builder.buildSchema()
      const extensions = builder.getExtensions()

      const result = await Effect.runPromise(
        execute(
          schema,
          Layer.empty,
          extensions
        )("query Greet($name: String!) { greeting(name: $name) }", { name: "World" })
      )

      expect(result.data).toEqual({ greeting: "Hello, World!" })
      expect(result.extensions?.analyzer).toBeDefined()
    })

    it("should handle mutations", async () => {
      const analyzer = createAnalyzerExtension()

      const builder = GraphQLSchemaBuilder.empty
        .pipe(extension(analyzer))
        .query("placeholder", { type: S.String, resolve: () => Effect.succeed("") })
        .mutation("doSomething", {
          type: S.String,
          resolve: () => Effect.succeed("done"),
        })

      const schema = builder.buildSchema()
      const extensions = builder.getExtensions()

      const result = await Effect.runPromise(
        execute(schema, Layer.empty, extensions)("mutation { doSomething }")
      )

      expect(result.data).toEqual({ doSomething: "done" })
      expect(result.extensions?.analyzer).toBeDefined()
    })

    it("should handle named operations", async () => {
      const analyzer = createAnalyzerExtension()

      const builder = GraphQLSchemaBuilder.empty
        .pipe(extension(analyzer))
        .query("test", { type: S.String, resolve: () => Effect.succeed("value") })

      const schema = builder.buildSchema()
      const extensions = builder.getExtensions()

      const result = await Effect.runPromise(
        execute(schema, Layer.empty, extensions)("query MyQuery { test }", undefined, "MyQuery")
      )

      expect(result.data).toEqual({ test: "value" })
      expect(result.extensions?.analyzer).toBeDefined()
    })
  })
})
