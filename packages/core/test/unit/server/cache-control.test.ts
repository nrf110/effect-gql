import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import * as S from "effect/Schema"
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLNonNull,
  parse,
  Kind,
} from "graphql"
import type { OperationDefinitionNode } from "graphql"
import {
  computeCachePolicy,
  computeCachePolicyFromQuery,
  toCacheControlHeader,
  type CacheHintMap,
} from "../../../src/server/cache-control"
import { GraphQLSchemaBuilder, query, objectType, field } from "../../../src/builder"

describe("cache-control.ts", () => {
  describe("toCacheControlHeader", () => {
    it("should return no-store for maxAge 0", () => {
      expect(toCacheControlHeader({ maxAge: 0, scope: "PUBLIC" })).toBe("no-store")
    })

    it("should return public header for PUBLIC scope", () => {
      expect(toCacheControlHeader({ maxAge: 3600, scope: "PUBLIC" })).toBe("public, max-age=3600")
    })

    it("should return private header for PRIVATE scope", () => {
      expect(toCacheControlHeader({ maxAge: 60, scope: "PRIVATE" })).toBe("private, max-age=60")
    })
  })

  describe("computeCachePolicy", () => {
    // Helper to create a simple schema
    const createTestSchema = () =>
      new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            user: {
              type: new GraphQLObjectType({
                name: "User",
                fields: {
                  id: { type: new GraphQLNonNull(GraphQLString) },
                  name: { type: GraphQLString },
                  email: { type: GraphQLString },
                },
              }),
            },
            users: {
              type: new GraphQLObjectType({
                name: "UserList",
                fields: {
                  items: { type: GraphQLString },
                },
              }),
            },
            publicData: { type: GraphQLString },
          },
        }),
      })

    const parseOperation = (query: string): OperationDefinitionNode => {
      const doc = parse(query)
      return doc.definitions.find(
        (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION
      )!
    }

    it("should return default maxAge 0 when no hints are provided", async () => {
      const schema = createTestSchema()
      const document = parse("{ user { id name } }")
      const operation = parseOperation("{ user { id name } }")

      const result = await Effect.runPromise(
        computeCachePolicy({
          document,
          operation,
          schema,
          cacheHints: new Map(),
          config: {},
        })
      )

      expect(result.maxAge).toBe(0)
      expect(result.scope).toBe("PUBLIC")
    })

    it("should use field-level cache hint", async () => {
      const schema = createTestSchema()
      const document = parse("{ publicData }")
      const operation = parseOperation("{ publicData }")

      const cacheHints: CacheHintMap = new Map([["Query.publicData", { maxAge: 3600 }]])

      const result = await Effect.runPromise(
        computeCachePolicy({
          document,
          operation,
          schema,
          cacheHints,
          config: {},
        })
      )

      expect(result.maxAge).toBe(3600)
      expect(result.scope).toBe("PUBLIC")
    })

    it("should use type-level cache hint", async () => {
      const schema = createTestSchema()
      const document = parse("{ user { id name } }")
      const operation = parseOperation("{ user { id name } }")

      const cacheHints: CacheHintMap = new Map([["User", { maxAge: 1800 }]])

      const result = await Effect.runPromise(
        computeCachePolicy({
          document,
          operation,
          schema,
          cacheHints,
          config: {},
        })
      )

      // User type has maxAge 1800, scalar fields inherit it
      expect(result.maxAge).toBe(1800)
    })

    it("should take minimum maxAge from multiple fields", async () => {
      const schema = createTestSchema()
      const document = parse("{ publicData user { id } }")
      const operation = parseOperation("{ publicData user { id } }")

      const cacheHints: CacheHintMap = new Map([
        ["Query.publicData", { maxAge: 3600 }],
        ["Query.user", { maxAge: 60 }],
      ])

      const result = await Effect.runPromise(
        computeCachePolicy({
          document,
          operation,
          schema,
          cacheHints,
          config: {},
        })
      )

      expect(result.maxAge).toBe(60) // Minimum of 3600 and 60
    })

    it("should set PRIVATE scope if any field is PRIVATE", async () => {
      const schema = createTestSchema()
      const document = parse("{ user { id email } }")
      const operation = parseOperation("{ user { id email } }")

      const cacheHints: CacheHintMap = new Map([
        ["User", { maxAge: 3600 }],
        ["User.email", { maxAge: 60, scope: "PRIVATE" }],
      ])

      const result = await Effect.runPromise(
        computeCachePolicy({
          document,
          operation,
          schema,
          cacheHints,
          config: {},
        })
      )

      expect(result.maxAge).toBe(60)
      expect(result.scope).toBe("PRIVATE")
    })

    it("should use config.defaultMaxAge", async () => {
      const schema = createTestSchema()
      const document = parse("{ publicData }")
      const operation = parseOperation("{ publicData }")

      const result = await Effect.runPromise(
        computeCachePolicy({
          document,
          operation,
          schema,
          cacheHints: new Map(),
          config: { defaultMaxAge: 300 },
        })
      )

      expect(result.maxAge).toBe(300)
    })

    it("should use config.defaultScope", async () => {
      const schema = createTestSchema()
      const document = parse("{ publicData }")
      const operation = parseOperation("{ publicData }")

      const result = await Effect.runPromise(
        computeCachePolicy({
          document,
          operation,
          schema,
          cacheHints: new Map([["Query.publicData", { maxAge: 60 }]]),
          config: { defaultScope: "PRIVATE" },
        })
      )

      expect(result.scope).toBe("PRIVATE")
    })

    it("should ignore introspection fields", async () => {
      const schema = createTestSchema()
      const document = parse("{ __typename publicData }")
      const operation = parseOperation("{ __typename publicData }")

      const cacheHints: CacheHintMap = new Map([["Query.publicData", { maxAge: 3600 }]])

      const result = await Effect.runPromise(
        computeCachePolicy({
          document,
          operation,
          schema,
          cacheHints,
          config: {},
        })
      )

      expect(result.maxAge).toBe(3600)
    })
  })

  describe("computeCachePolicyFromQuery", () => {
    const createTestSchema = () =>
      new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            hello: { type: GraphQLString },
          },
        }),
      })

    it("should compute cache policy from query string", async () => {
      const schema = createTestSchema()
      const cacheHints: CacheHintMap = new Map([["Query.hello", { maxAge: 3600 }]])

      const result = await Effect.runPromise(
        computeCachePolicyFromQuery("{ hello }", undefined, schema, cacheHints, {})
      )

      expect(result.maxAge).toBe(3600)
      expect(result.scope).toBe("PUBLIC")
    })

    it("should handle named operations", async () => {
      const schema = createTestSchema()
      const cacheHints: CacheHintMap = new Map([["Query.hello", { maxAge: 3600 }]])

      const result = await Effect.runPromise(
        computeCachePolicyFromQuery("query GetHello { hello }", "GetHello", schema, cacheHints, {})
      )

      expect(result.maxAge).toBe(3600)
    })
  })

  describe("GraphQLSchemaBuilder.getCacheHints", () => {
    it("should collect cache hints from query fields", () => {
      const builder = GraphQLSchemaBuilder.empty.pipe(
        query("users", {
          type: S.Array(S.String),
          cacheControl: { maxAge: 3600 },
          resolve: () => Effect.succeed([]),
        }),
        query("me", {
          type: S.String,
          cacheControl: { maxAge: 0, scope: "PRIVATE" },
          resolve: () => Effect.succeed("user"),
        })
      )

      const hints = builder.getCacheHints()

      expect(hints.get("Query.users")).toEqual({ maxAge: 3600 })
      expect(hints.get("Query.me")).toEqual({ maxAge: 0, scope: "PRIVATE" })
    })

    it("should collect cache hints from object types", () => {
      const UserSchema = S.Struct({
        id: S.String,
        name: S.String,
      })

      const builder = GraphQLSchemaBuilder.empty.pipe(
        objectType({
          name: "User",
          schema: UserSchema,
          cacheControl: { maxAge: 1800 },
        }),
        query("user", {
          type: UserSchema,
          resolve: () => Effect.succeed({ id: "1", name: "Alice" }),
        })
      )

      const hints = builder.getCacheHints()

      expect(hints.get("User")).toEqual({ maxAge: 1800 })
    })

    it("should collect cache hints from computed fields", () => {
      const UserSchema = S.Struct({
        id: S.String,
        name: S.String,
      })

      const builder = GraphQLSchemaBuilder.empty.pipe(
        objectType({
          name: "User",
          schema: UserSchema,
        }),
        field("User", "email", {
          type: S.String,
          cacheControl: { maxAge: 0, scope: "PRIVATE" },
          resolve: () => Effect.succeed("email@example.com"),
        }),
        query("user", {
          type: UserSchema,
          resolve: () => Effect.succeed({ id: "1", name: "Alice" }),
        })
      )

      const hints = builder.getCacheHints()

      expect(hints.get("User.email")).toEqual({ maxAge: 0, scope: "PRIVATE" })
    })
  })
})
