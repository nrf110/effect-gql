import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder } from "@effect-gql/core"
import { tracingExtension, resolverTracingMiddleware, withTracing } from "../../src"

describe("tracing", () => {
  describe("tracingExtension", () => {
    it("should create a valid extension with default config", () => {
      const ext = tracingExtension()

      expect(ext.name).toBe("opentelemetry-tracing")
      expect(ext.onParse).toBeDefined()
      expect(ext.onValidate).toBeDefined()
      expect(ext.onExecuteStart).toBeDefined()
      expect(ext.onExecuteEnd).toBeDefined()
    })

    it("should create a valid extension with custom config", () => {
      const ext = tracingExtension({
        includeQuery: true,
        includeVariables: true,
        exposeTraceIdInResponse: true,
        customAttributes: { "service.name": "test" },
      })

      expect(ext.name).toBe("opentelemetry-tracing")
    })

    it("should be registerable on a schema builder", () => {
      const builder = GraphQLSchemaBuilder.empty.pipe((b) => b.extension(tracingExtension()))

      // Should not throw
      expect(builder).toBeDefined()
    })
  })

  describe("resolverTracingMiddleware", () => {
    it("should create a valid middleware with default config", () => {
      const mw = resolverTracingMiddleware()

      expect(mw.name).toBe("opentelemetry-resolver-tracing")
      expect(mw.match).toBeDefined()
      expect(mw.apply).toBeDefined()
    })

    it("should create a valid middleware with custom config", () => {
      const mw = resolverTracingMiddleware({
        minDepth: 1,
        maxDepth: 5,
        excludePatterns: [/^Query\.__/],
        includeArgs: true,
        includeParentType: false,
        traceIntrospection: true,
      })

      expect(mw.name).toBe("opentelemetry-resolver-tracing")
    })

    it("should be registerable on a schema builder", () => {
      const builder = GraphQLSchemaBuilder.empty.pipe((b) =>
        b.middleware(resolverTracingMiddleware())
      )

      // Should not throw
      expect(builder).toBeDefined()
    })

    it("should filter introspection fields by default", () => {
      const mw = resolverTracingMiddleware()
      const info = {
        fieldName: "__schema",
        parentType: { name: "Query" },
        path: { key: "__schema", prev: undefined },
      } as any

      expect(mw.match!(info)).toBe(false)
    })

    it("should trace introspection fields when enabled", () => {
      const mw = resolverTracingMiddleware({ traceIntrospection: true })
      const info = {
        fieldName: "__schema",
        parentType: { name: "Query" },
        path: { key: "__schema", prev: undefined },
      } as any

      expect(mw.match!(info)).toBe(true)
    })

    it("should filter by depth when configured", () => {
      const mw = resolverTracingMiddleware({ minDepth: 1 })
      const rootInfo = {
        fieldName: "users",
        parentType: { name: "Query" },
        path: { key: "users", prev: undefined },
      } as any

      expect(mw.match!(rootInfo)).toBe(false)

      const nestedInfo = {
        fieldName: "name",
        parentType: { name: "User" },
        path: {
          key: "name",
          prev: { key: "users", prev: undefined },
        },
      } as any

      expect(mw.match!(nestedInfo)).toBe(true)
    })

    it("should filter by exclude patterns", () => {
      const mw = resolverTracingMiddleware({
        excludePatterns: [/\.id$/, /^Query\.health/],
      })

      const idField = {
        fieldName: "id",
        parentType: { name: "User" },
        path: { key: "id", prev: undefined },
      } as any

      expect(mw.match!(idField)).toBe(false)

      const healthField = {
        fieldName: "health",
        parentType: { name: "Query" },
        path: { key: "health", prev: undefined },
      } as any

      expect(mw.match!(healthField)).toBe(false)

      const nameField = {
        fieldName: "name",
        parentType: { name: "User" },
        path: { key: "name", prev: undefined },
      } as any

      expect(mw.match!(nameField)).toBe(true)
    })
  })

  describe("withTracing", () => {
    it("should add both extension and middleware to builder", () => {
      const builder = GraphQLSchemaBuilder.empty
        .query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        })
        .pipe(withTracing())

      // Should not throw and should be able to build schema
      const schema = builder.buildSchema()
      expect(schema).toBeDefined()
      expect(schema.getQueryType()).toBeDefined()
    })

    it("should accept configuration", () => {
      const builder = GraphQLSchemaBuilder.empty
        .query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        })
        .pipe(
          withTracing({
            extension: {
              exposeTraceIdInResponse: true,
              includeQuery: false,
            },
            resolver: {
              minDepth: 0,
              excludePatterns: [/^Query\.__/],
            },
          })
        )

      // Should not throw and should be able to build schema
      const schema = builder.buildSchema()
      expect(schema).toBeDefined()
    })

    it("should work with empty config", () => {
      const builder = GraphQLSchemaBuilder.empty
        .query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        })
        .pipe(withTracing({}))

      const schema = builder.buildSchema()
      expect(schema).toBeDefined()
    })
  })
})
