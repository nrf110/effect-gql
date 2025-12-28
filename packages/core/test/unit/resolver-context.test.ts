import { describe, it, expect } from "vitest"
import { Effect, Layer, Option } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder } from "../../src/builder/schema-builder"
import { execute } from "../../src/builder/execute"
import {
  ResolverContext,
  MissingResolverContextError,
  storeLayer,
} from "../../src/resolver-context"
import { DirectiveLocation } from "graphql"

// =============================================================================
// Test fixtures - Define context slots
// =============================================================================

interface User {
  id: string
  name: string
  role: "admin" | "user"
}

const AuthPrincipal = ResolverContext.make<User>("AuthPrincipal")
const TenantId = ResolverContext.make<string>("TenantId")
const RequestId = ResolverContext.make<string>("RequestId")

// Simulated JWT validation
const validateJwt = (token: string): Effect.Effect<User, Error> => {
  if (token === "valid-admin-token") {
    return Effect.succeed({ id: "1", name: "Admin User", role: "admin" })
  }
  if (token === "valid-user-token") {
    return Effect.succeed({ id: "2", name: "Regular User", role: "user" })
  }
  return Effect.fail(new Error("Invalid token"))
}

describe("ResolverContext", () => {
  // ==========================================================================
  // Basic API tests
  // ==========================================================================
  describe("Basic API", () => {
    it("should create a context slot", () => {
      const slot = ResolverContext.make<string>("TestSlot")
      expect(slot._tag).toBe("ResolverContextSlot")
      expect(slot.name).toBe("TestSlot")
    })

    it("should set and get a value", async () => {
      const slot = ResolverContext.make<number>("Counter")

      const effect = Effect.gen(function* () {
        yield* ResolverContext.set(slot, 42)
        return yield* ResolverContext.get(slot)
      })

      const result = await Effect.runPromise(Effect.provide(effect, storeLayer))
      expect(result).toBe(42)
    })

    it("should fail when getting unset context", async () => {
      const slot = ResolverContext.make<string>("Missing")

      const effect = ResolverContext.get(slot)

      const result = await Effect.runPromise(Effect.provide(effect, storeLayer).pipe(Effect.either))

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(MissingResolverContextError)
        expect(result.left.contextName).toBe("Missing")
      }
    })

    it("should return None for unset optional context", async () => {
      const slot = ResolverContext.make<string>("Optional")

      const result = await Effect.runPromise(
        Effect.provide(ResolverContext.getOption(slot), storeLayer)
      )
      expect(Option.isNone(result)).toBe(true)
    })

    it("should return Some for set optional context", async () => {
      const slot = ResolverContext.make<string>("Optional")

      const effect = Effect.gen(function* () {
        yield* ResolverContext.set(slot, "value")
        return yield* ResolverContext.getOption(slot)
      })

      const result = await Effect.runPromise(Effect.provide(effect, storeLayer))
      expect(Option.isSome(result)).toBe(true)
      expect(Option.getOrThrow(result)).toBe("value")
    })

    it("should check if context has value", async () => {
      const slot = ResolverContext.make<string>("Check")

      const effect = Effect.gen(function* () {
        const before = yield* ResolverContext.has(slot)
        yield* ResolverContext.set(slot, "test")
        const after = yield* ResolverContext.has(slot)
        return { before, after }
      })

      const result = await Effect.runPromise(Effect.provide(effect, storeLayer))
      expect(result.before).toBe(false)
      expect(result.after).toBe(true)
    })

    it("should get value or return default", async () => {
      const slot = ResolverContext.make<string>("WithDefault")

      const effect = Effect.gen(function* () {
        const before = yield* ResolverContext.getOrElse(slot, () => "default")
        yield* ResolverContext.set(slot, "actual")
        const after = yield* ResolverContext.getOrElse(slot, () => "default")
        return { before, after }
      })

      const result = await Effect.runPromise(Effect.provide(effect, storeLayer))
      expect(result.before).toBe("default")
      expect(result.after).toBe("actual")
    })

    it("should set multiple values at once", async () => {
      const slot1 = ResolverContext.make<string>("Slot1")
      const slot2 = ResolverContext.make<number>("Slot2")

      const effect = Effect.gen(function* () {
        yield* ResolverContext.setMany([
          [slot1, "hello"],
          [slot2, 123],
        ])
        const v1 = yield* ResolverContext.get(slot1)
        const v2 = yield* ResolverContext.get(slot2)
        return [v1, v2] as const
      })

      const [v1, v2] = await Effect.runPromise(Effect.provide(effect, storeLayer))
      expect(v1).toBe("hello")
      expect(v2).toBe(123)
    })
  })

  // ==========================================================================
  // Context persistence across effects
  // ==========================================================================
  describe("Context persistence", () => {
    it("should persist context across sequential effects", async () => {
      const slot = ResolverContext.make<string>("Persistent")

      const effect = Effect.gen(function* () {
        yield* ResolverContext.set(slot, "set-early")
        // Simulate some work
        yield* Effect.succeed("intermediate")
        // Value should still be there
        return yield* ResolverContext.get(slot)
      })

      const result = await Effect.runPromise(Effect.provide(effect, storeLayer))
      expect(result).toBe("set-early")
    })

    it("should allow overwriting context values", async () => {
      const slot = ResolverContext.make<string>("Overwrite")

      const effect = Effect.gen(function* () {
        yield* ResolverContext.set(slot, "first")
        const first = yield* ResolverContext.get(slot)
        yield* ResolverContext.set(slot, "second")
        const second = yield* ResolverContext.get(slot)
        return { first, second }
      })

      const result = await Effect.runPromise(Effect.provide(effect, storeLayer))
      expect(result).toEqual({ first: "first", second: "second" })
    })
  })

  // ==========================================================================
  // Scoped context
  // ==========================================================================
  describe("Scoped context", () => {
    it("should restore previous value after scoped context", async () => {
      const slot = ResolverContext.make<string>("Scoped")

      const effect = Effect.gen(function* () {
        yield* ResolverContext.set(slot, "outer")
        const outer = yield* ResolverContext.get(slot)

        const inner = yield* ResolverContext.scoped(slot, "inner")(ResolverContext.get(slot))

        const afterInner = yield* ResolverContext.get(slot)

        return { outer, inner, afterInner }
      })

      const result = await Effect.runPromise(Effect.provide(effect, storeLayer))
      expect(result).toEqual({
        outer: "outer",
        inner: "inner",
        afterInner: "outer",
      })
    })
  })

  // ==========================================================================
  // Integration with GraphQL directives
  // ==========================================================================
  describe("Directive integration", () => {
    it("should provide context from auth directive to resolvers", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .directive({
          name: "auth",
          description: "Requires authentication",
          locations: [DirectiveLocation.FIELD_DEFINITION],
          apply: () => (effect) =>
            Effect.gen(function* () {
              // In real usage, you'd get the token from GraphQLRequestContext
              const user = yield* validateJwt("valid-admin-token")
              yield* ResolverContext.set(AuthPrincipal, user)
              return yield* effect
            }),
        })
        .query("me", {
          type: S.Struct({ id: S.String, name: S.String, role: S.String }),
          directives: [{ name: "auth" }],
          resolve: () =>
            Effect.gen(function* () {
              const user = yield* ResolverContext.get(AuthPrincipal)
              return user
            }),
        })
        .buildSchema()

      const result = await Effect.runPromise(
        execute(schema, storeLayer)(`query { me { id name role } }`)
      )

      expect(result.errors).toBeUndefined()
      expect(result.data).toEqual({
        me: { id: "1", name: "Admin User", role: "admin" },
      })
    })

    it("should make context available to nested field resolvers", async () => {
      const UserSchema = S.Struct({
        id: S.String,
        name: S.String,
      })

      const PostSchema = S.Struct({
        id: S.String,
        title: S.String,
        authorId: S.String,
      })

      const schema = GraphQLSchemaBuilder.empty
        .directive({
          name: "auth",
          locations: [DirectiveLocation.FIELD_DEFINITION],
          apply: () => (effect) =>
            Effect.gen(function* () {
              const user = yield* validateJwt("valid-user-token")
              yield* ResolverContext.set(AuthPrincipal, user)
              return yield* effect
            }),
        })
        .objectType({ name: "User", schema: UserSchema })
        .objectType({ name: "Post", schema: PostSchema })
        // User.posts field accesses auth context set by parent query
        .field("User", "posts", {
          type: S.Array(PostSchema),
          resolve: (parent) =>
            Effect.gen(function* () {
              // This should have access to AuthPrincipal from the @auth directive
              const principal = yield* ResolverContext.get(AuthPrincipal)
              // Only return posts if the principal matches the user
              if (principal.id === parent.id) {
                return [{ id: "1", title: "My Post", authorId: parent.id }]
              }
              return []
            }),
        })
        .query("me", {
          type: UserSchema,
          directives: [{ name: "auth" }],
          resolve: () =>
            Effect.gen(function* () {
              const user = yield* ResolverContext.get(AuthPrincipal)
              return { id: user.id, name: user.name }
            }),
        })
        .buildSchema()

      const result = await Effect.runPromise(
        execute(
          schema,
          storeLayer
        )(`
          query {
            me {
              id
              name
              posts {
                id
                title
              }
            }
          }
        `)
      )

      expect(result.errors).toBeUndefined()
      expect(result.data).toEqual({
        me: {
          id: "2",
          name: "Regular User",
          posts: [{ id: "1", title: "My Post" }],
        },
      })
    })

    it("should fail resolver when required context is not provided", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .query("protected", {
          type: S.String,
          // No @auth directive, so AuthPrincipal won't be set
          resolve: () =>
            Effect.gen(function* () {
              const user = yield* ResolverContext.get(AuthPrincipal)
              return user.name
            }),
        })
        .buildSchema()

      const result = await Effect.runPromise(execute(schema, storeLayer)(`query { protected }`))

      expect(result.errors).toBeDefined()
      expect(result.errors![0].message).toContain("AuthPrincipal")
      expect(result.errors![0].message).toContain("not provided")
    })

    it("should allow optional context access with getOption", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .directive({
          name: "auth",
          locations: [DirectiveLocation.FIELD_DEFINITION],
          apply: () => (effect) =>
            Effect.gen(function* () {
              const user = yield* validateJwt("valid-admin-token")
              yield* ResolverContext.set(AuthPrincipal, user)
              return yield* effect
            }),
        })
        .query("greeting", {
          type: S.String,
          // No @auth directive - context is optional
          resolve: () =>
            Effect.gen(function* () {
              const maybeUser = yield* ResolverContext.getOption(AuthPrincipal)
              return Option.match(maybeUser, {
                onNone: () => "Hello, Guest!",
                onSome: (user) => `Hello, ${user.name}!`,
              })
            }),
        })
        .query("authenticatedGreeting", {
          type: S.String,
          directives: [{ name: "auth" }],
          resolve: () =>
            Effect.gen(function* () {
              const maybeUser = yield* ResolverContext.getOption(AuthPrincipal)
              return Option.match(maybeUser, {
                onNone: () => "Hello, Guest!",
                onSome: (user) => `Hello, ${user.name}!`,
              })
            }),
        })
        .buildSchema()

      const guestResult = await Effect.runPromise(execute(schema, storeLayer)(`query { greeting }`))
      expect(guestResult.data).toEqual({ greeting: "Hello, Guest!" })

      const authResult = await Effect.runPromise(
        execute(schema, storeLayer)(`query { authenticatedGreeting }`)
      )
      expect(authResult.data).toEqual({
        authenticatedGreeting: "Hello, Admin User!",
      })
    })
  })

  // ==========================================================================
  // Multiple context values
  // ==========================================================================
  describe("Multiple context values", () => {
    it("should support multiple context slots", async () => {
      const schema = GraphQLSchemaBuilder.empty
        .directive({
          name: "withContext",
          locations: [DirectiveLocation.FIELD_DEFINITION],
          apply: () => (effect) =>
            Effect.gen(function* () {
              yield* ResolverContext.setMany([
                [AuthPrincipal, { id: "1", name: "User", role: "user" as const }],
                [TenantId, "tenant-123"],
                [RequestId, "req-456"],
              ])
              return yield* effect
            }),
        })
        .query("contextInfo", {
          type: S.Struct({
            userId: S.String,
            tenantId: S.String,
            requestId: S.String,
          }),
          directives: [{ name: "withContext" }],
          resolve: () =>
            Effect.gen(function* () {
              const user = yield* ResolverContext.get(AuthPrincipal)
              const tenantId = yield* ResolverContext.get(TenantId)
              const requestId = yield* ResolverContext.get(RequestId)
              return {
                userId: user.id,
                tenantId,
                requestId,
              }
            }),
        })
        .buildSchema()

      const result = await Effect.runPromise(
        execute(
          schema,
          storeLayer
        )(`
          query { contextInfo { userId tenantId requestId } }
        `)
      )

      expect(result.errors).toBeUndefined()
      expect(result.data).toEqual({
        contextInfo: {
          userId: "1",
          tenantId: "tenant-123",
          requestId: "req-456",
        },
      })
    })
  })

  // ==========================================================================
  // Request isolation
  // ==========================================================================
  describe("Request isolation", () => {
    it("should isolate context between requests", async () => {
      const Counter = ResolverContext.make<number>("Counter")

      const schema = GraphQLSchemaBuilder.empty
        .query("increment", {
          type: S.Number,
          resolve: () =>
            Effect.gen(function* () {
              const current = yield* ResolverContext.getOrElse(Counter, () => 0)
              const next = current + 1
              yield* ResolverContext.set(Counter, next)
              return next
            }),
        })
        .buildSchema()

      // Each request should start fresh
      const result1 = await Effect.runPromise(execute(schema, storeLayer)(`query { increment }`))
      const result2 = await Effect.runPromise(execute(schema, storeLayer)(`query { increment }`))
      const result3 = await Effect.runPromise(execute(schema, storeLayer)(`query { increment }`))

      // Each should be 1 because storeLayer creates a fresh store per request
      expect(result1.data).toEqual({ increment: 1 })
      expect(result2.data).toEqual({ increment: 1 })
      expect(result3.data).toEqual({ increment: 1 })
    })
  })
})
