import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import * as S from "effect/Schema"
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLUnionType,
  GraphQLNonNull,
  GraphQLList,
  printSchema,
  graphql,
} from "@effect-gql/core"
import {
  FederatedSchemaBuilder,
  key,
  shareable,
  external,
  requires,
  provides,
  override,
  entity,
  query,
  field,
} from "../../src"

// Test schemas
const UserSchema = S.Struct({
  id: S.String,
  name: S.String,
  email: S.String,
})

const PostSchema = S.Struct({
  id: S.String,
  title: S.String,
  authorId: S.String,
})

const ProductSchema = S.Struct({
  id: S.String,
  sku: S.String,
  name: S.String,
  price: S.Number,
})

describe("FederatedSchemaBuilder", () => {
  // ============================================================================
  // Basic Builder Operations
  // ============================================================================
  describe("builder basics", () => {
    it("should create an empty builder", () => {
      const builder = FederatedSchemaBuilder.empty
      expect(builder).toBeDefined()
    })

    it("should be pipeable", () => {
      const builder = FederatedSchemaBuilder.empty.pipe(
        query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        })
      )
      expect(builder).toBeInstanceOf(FederatedSchemaBuilder)
    })

    it("should create a builder with custom version", () => {
      const builder = FederatedSchemaBuilder.create({ version: "2.5" })
      expect(builder).toBeDefined()
    })
  })

  // ============================================================================
  // Entity Registration
  // ============================================================================
  describe("entity registration", () => {
    it("should register an entity with a single @key", () => {
      const builder = FederatedSchemaBuilder.empty.pipe(
        entity({
          name: "User",
          schema: UserSchema,
          keys: [{ fields: "id" }],
          resolveReference: (ref) =>
            Effect.succeed({
              id: ref.id!,
              name: "Test User",
              email: "test@example.com",
            }),
        })
      )

      const { schema } = builder.buildFederatedSchema()
      const userType = schema.getType("User") as GraphQLObjectType
      expect(userType).toBeDefined()
      expect(userType.name).toBe("User")

      // Check for @key directive in extensions
      const directives = (userType.extensions as any)?.directives
      expect(directives).toBeDefined()
      expect(directives.some((d: any) => d.name === "key")).toBe(true)
    })

    it("should register an entity with multiple @keys", () => {
      const builder = FederatedSchemaBuilder.empty.pipe(
        entity({
          name: "Product",
          schema: ProductSchema,
          keys: [{ fields: "id" }, { fields: "sku" }],
          resolveReference: (ref) =>
            Effect.succeed({
              id: ref.id ?? "1",
              sku: ref.sku ?? "SKU-001",
              name: "Test Product",
              price: 99.99,
            }),
        })
      )

      const { schema } = builder.buildFederatedSchema()
      const productType = schema.getType("Product") as GraphQLObjectType
      const directives = (productType.extensions as any)?.directives

      expect(directives.filter((d: any) => d.name === "key")).toHaveLength(2)
    })

    it("should support non-resolvable keys", () => {
      const builder = FederatedSchemaBuilder.empty.pipe(
        entity({
          name: "User",
          schema: UserSchema,
          keys: [{ fields: "id", resolvable: false }],
          resolveReference: () => Effect.succeed(null),
        })
      )

      const { schema } = builder.buildFederatedSchema()
      const userType = schema.getType("User") as GraphQLObjectType
      const directives = (userType.extensions as any)?.directives
      const keyDirective = directives.find((d: any) => d.name === "key")

      expect(keyDirective.args.resolvable).toBe(false)
    })
  })

  // ============================================================================
  // Federation Query Types
  // ============================================================================
  describe("federation queries", () => {
    it("should add _entities query", () => {
      const builder = FederatedSchemaBuilder.empty.pipe(
        entity({
          name: "User",
          schema: UserSchema,
          keys: [{ fields: "id" }],
          resolveReference: (ref) =>
            Effect.succeed({
              id: ref.id!,
              name: "Test User",
              email: "test@example.com",
            }),
        })
      )

      const { schema } = builder.buildFederatedSchema()
      const queryType = schema.getQueryType()!
      const fields = queryType.getFields()

      expect(fields._entities).toBeDefined()
      expect(fields._entities.type).toBeInstanceOf(GraphQLNonNull)

      const listType = (fields._entities.type as GraphQLNonNull<any>).ofType as GraphQLList<any>
      expect(listType).toBeInstanceOf(GraphQLList)
    })

    it("should add _service query", () => {
      const builder = FederatedSchemaBuilder.empty.pipe(
        entity({
          name: "User",
          schema: UserSchema,
          keys: [{ fields: "id" }],
          resolveReference: () => Effect.succeed({ id: "1", name: "Test", email: "t@t.com" }),
        })
      )

      const { schema } = builder.buildFederatedSchema()
      const queryType = schema.getQueryType()!
      const fields = queryType.getFields()

      expect(fields._service).toBeDefined()
    })

    it("should create _Entity union type", () => {
      const builder = FederatedSchemaBuilder.empty.pipe(
        entity({
          name: "User",
          schema: UserSchema,
          keys: [{ fields: "id" }],
          resolveReference: () => Effect.succeed({ id: "1", name: "Test", email: "t@t.com" }),
        }),
        entity({
          name: "Product",
          schema: ProductSchema,
          keys: [{ fields: "id" }],
          resolveReference: () => Effect.succeed({ id: "1", sku: "SKU", name: "Prod", price: 10 }),
        })
      )

      const { schema } = builder.buildFederatedSchema()
      const entityUnion = schema.getType("_Entity") as GraphQLUnionType

      expect(entityUnion).toBeInstanceOf(GraphQLUnionType)
      expect(entityUnion.getTypes()).toHaveLength(2)
      expect(entityUnion.getTypes().map((t) => t.name)).toContain("User")
      expect(entityUnion.getTypes().map((t) => t.name)).toContain("Product")
    })
  })

  // ============================================================================
  // SDL Generation
  // ============================================================================
  describe("SDL generation", () => {
    it("should include federation schema extension", () => {
      const builder = FederatedSchemaBuilder.empty.pipe(
        entity({
          name: "User",
          schema: UserSchema,
          keys: [{ fields: "id" }],
          resolveReference: () => Effect.succeed({ id: "1", name: "Test", email: "t@t.com" }),
        })
      )

      const { sdl } = builder.buildFederatedSchema()

      expect(sdl).toContain("extend schema @link")
      expect(sdl).toContain("https://specs.apollo.dev/federation")
    })

    it("should include @key directive in SDL", () => {
      const builder = FederatedSchemaBuilder.empty.pipe(
        entity({
          name: "User",
          schema: UserSchema,
          keys: [{ fields: "id" }],
          resolveReference: () => Effect.succeed({ id: "1", name: "Test", email: "t@t.com" }),
        })
      )

      const { sdl } = builder.buildFederatedSchema()

      expect(sdl).toContain('@key(fields: "id")')
    })

    it("should return SDL from _service query", async () => {
      const builder = FederatedSchemaBuilder.empty.pipe(
        entity({
          name: "User",
          schema: UserSchema,
          keys: [{ fields: "id" }],
          resolveReference: () => Effect.succeed({ id: "1", name: "Test", email: "t@t.com" }),
        }),
        query("me", {
          type: UserSchema,
          resolve: () => Effect.succeed({ id: "1", name: "Current User", email: "me@example.com" }),
        })
      )

      const { schema } = builder.buildFederatedSchema()

      const result = await graphql({
        schema,
        source: `{ _service { sdl } }`,
      })

      expect(result.errors).toBeUndefined()
      expect(result.data?._service?.sdl).toContain("type User")
      expect(result.data?._service?.sdl).toContain('@key(fields: "id")')
    })
  })

  // ============================================================================
  // Directive Helpers
  // ============================================================================
  describe("directive helpers", () => {
    it("key() should create a key directive config", () => {
      const keyConfig = key({ fields: "id" })
      expect(keyConfig._tag).toBe("key")
      expect(keyConfig.fields).toBe("id")
    })

    it("key() should support resolvable option", () => {
      const keyConfig = key({ fields: "id", resolvable: false })
      expect(keyConfig.resolvable).toBe(false)
    })

    it("shareable() should create a shareable directive", () => {
      const directive = shareable()
      expect(directive._tag).toBe("shareable")
    })

    it("external() should create an external directive", () => {
      const directive = external()
      expect(directive._tag).toBe("external")
    })

    it("requires() should create a requires directive", () => {
      const directive = requires({ fields: "weight" })
      expect(directive._tag).toBe("requires")
      expect(directive.fields).toBe("weight")
    })

    it("provides() should create a provides directive", () => {
      const directive = provides({ fields: "name email" })
      expect(directive._tag).toBe("provides")
      expect(directive.fields).toBe("name email")
    })

    it("override() should create an override directive", () => {
      const directive = override({ from: "legacy-service" })
      expect(directive._tag).toBe("override")
      expect(directive.from).toBe("legacy-service")
    })

    it("override() should support label option", () => {
      const directive = override({ from: "legacy-service", label: "percent(5)" })
      expect(directive.label).toBe("percent(5)")
    })
  })

  // ============================================================================
  // Core Builder Delegation
  // ============================================================================
  describe("core builder delegation", () => {
    it("should delegate query to core builder", () => {
      const builder = FederatedSchemaBuilder.empty.pipe(
        query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        })
      )

      const schema = builder.buildSchema()
      const queryType = schema.getQueryType()!

      expect(queryType.getFields().hello).toBeDefined()
    })

    it("should delegate objectType to core builder", () => {
      const builder = FederatedSchemaBuilder.empty.pipe((b) =>
        b.objectType({
          name: "User",
          schema: UserSchema,
        })
      )

      const schema = builder.buildSchema()
      const userType = schema.getType("User")

      expect(userType).toBeDefined()
    })

    it("should delegate field to core builder", () => {
      const builder = FederatedSchemaBuilder.empty.pipe(
        entity({
          name: "User",
          schema: UserSchema,
          keys: [{ fields: "id" }],
          resolveReference: () => Effect.succeed({ id: "1", name: "Test", email: "t@t.com" }),
        }),
        field<typeof UserSchema.Type, (typeof PostSchema.Type)[], never, never>("User", "posts", {
          type: S.Array(PostSchema),
          resolve: () => Effect.succeed([]),
        })
      )

      const { schema } = builder.buildFederatedSchema()
      const userType = schema.getType("User") as GraphQLObjectType
      const fields = userType.getFields()

      expect(fields.posts).toBeDefined()
    })
  })

  // ============================================================================
  // Integration: Full Subgraph Schema
  // ============================================================================
  describe("full subgraph integration", () => {
    it("should build a complete users subgraph", () => {
      const builder = FederatedSchemaBuilder.empty.pipe(
        entity({
          name: "User",
          schema: UserSchema,
          keys: [{ fields: "id" }],
          resolveReference: (ref) =>
            Effect.succeed({
              id: ref.id!,
              name: "Resolved User",
              email: "resolved@example.com",
            }),
        }),
        query("me", {
          type: UserSchema,
          resolve: () =>
            Effect.succeed({
              id: "current-user",
              name: "Current User",
              email: "me@example.com",
            }),
        }),
        query("users", {
          type: S.Array(UserSchema),
          resolve: () => Effect.succeed([]),
        })
      )

      const { schema, sdl } = builder.buildFederatedSchema()

      // Verify schema structure
      const queryType = schema.getQueryType()!
      expect(queryType.getFields().me).toBeDefined()
      expect(queryType.getFields().users).toBeDefined()
      expect(queryType.getFields()._entities).toBeDefined()
      expect(queryType.getFields()._service).toBeDefined()

      // Verify SDL includes federation directives
      expect(sdl).toContain("extend schema @link")
      expect(sdl).toContain('@key(fields: "id")')
    })
  })
})
