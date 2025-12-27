import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import * as S from "effect/Schema"
import {
  GraphQLObjectType,
  GraphQLEnumType,
  GraphQLUnionType,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
} from "graphql"
import { GraphQLSchemaBuilder } from "../../../src/builder/schema-builder"

describe("type-level directives", () => {
  // ==========================================================================
  // Object Type Directives
  // ==========================================================================
  describe("objectType directives", () => {
    it("should store directives in object type extensions", () => {
      const builder = GraphQLSchemaBuilder.empty
        .objectType({
          name: "User",
          schema: S.Struct({ id: S.String, name: S.String }),
          directives: [
            { name: "key", args: { fields: "id" } },
            { name: "shareable" },
          ],
        })
        .query("user", {
          type: S.Struct({ id: S.String, name: S.String }),
          resolve: () => Effect.succeed({ id: "1", name: "Alice" }),
        })

      const schema = builder.buildSchema()
      const userType = schema.getType("User") as GraphQLObjectType

      expect(userType).toBeDefined()
      expect(userType.extensions).toBeDefined()
      expect(userType.extensions?.directives).toEqual([
        { name: "key", args: { fields: "id" } },
        { name: "shareable" },
      ])
    })

    it("should not add extensions when no directives specified", () => {
      const builder = GraphQLSchemaBuilder.empty
        .objectType({
          name: "User",
          schema: S.Struct({ id: S.String }),
        })
        .query("user", {
          type: S.Struct({ id: S.String }),
          resolve: () => Effect.succeed({ id: "1" }),
        })

      const schema = builder.buildSchema()
      const userType = schema.getType("User") as GraphQLObjectType

      expect(userType).toBeDefined()
      expect(userType.extensions?.directives).toBeUndefined()
    })
  })

  // ==========================================================================
  // Interface Type Directives
  // ==========================================================================
  describe("interfaceType directives", () => {
    it("should store directives in interface type extensions", () => {
      const builder = GraphQLSchemaBuilder.empty
        .interfaceType({
          name: "Node",
          schema: S.Struct({ id: S.String }),
          directives: [{ name: "key", args: { fields: "id" } }],
        })
        .objectType({
          name: "User",
          schema: S.Struct({ id: S.String }),
          implements: ["Node"],
        })
        .query("node", {
          type: S.Struct({ id: S.String }),
          resolve: () => Effect.succeed({ id: "1" }),
        })

      const schema = builder.buildSchema()
      const nodeType = schema.getType("Node") as GraphQLInterfaceType

      expect(nodeType).toBeDefined()
      expect(nodeType.extensions).toBeDefined()
      expect(nodeType.extensions?.directives).toEqual([
        { name: "key", args: { fields: "id" } },
      ])
    })

    it("should not add extensions when no directives specified", () => {
      const builder = GraphQLSchemaBuilder.empty
        .interfaceType({
          name: "Node",
          schema: S.Struct({ id: S.String }),
        })
        .query("dummy", {
          type: S.String,
          resolve: () => Effect.succeed(""),
        })

      const schema = builder.buildSchema()
      const nodeType = schema.getType("Node") as GraphQLInterfaceType

      expect(nodeType).toBeDefined()
      expect(nodeType.extensions?.directives).toBeUndefined()
    })
  })

  // ==========================================================================
  // Enum Type Directives
  // ==========================================================================
  describe("enumType directives", () => {
    it("should store directives in enum type extensions", () => {
      const builder = GraphQLSchemaBuilder.empty
        .enumType({
          name: "Status",
          values: ["ACTIVE", "INACTIVE"],
          directives: [{ name: "inaccessible" }],
        })
        .query("status", {
          type: S.String,
          resolve: () => Effect.succeed("ACTIVE"),
        })

      const schema = builder.buildSchema()
      const statusType = schema.getType("Status") as GraphQLEnumType

      expect(statusType).toBeDefined()
      expect(statusType.extensions).toBeDefined()
      expect(statusType.extensions?.directives).toEqual([
        { name: "inaccessible" },
      ])
    })

    it("should not add extensions when no directives specified", () => {
      const builder = GraphQLSchemaBuilder.empty
        .enumType({
          name: "Status",
          values: ["ACTIVE", "INACTIVE"],
        })
        .query("dummy", {
          type: S.String,
          resolve: () => Effect.succeed(""),
        })

      const schema = builder.buildSchema()
      const statusType = schema.getType("Status") as GraphQLEnumType

      expect(statusType).toBeDefined()
      expect(statusType.extensions?.directives).toBeUndefined()
    })
  })

  // ==========================================================================
  // Union Type Directives
  // ==========================================================================
  describe("unionType directives", () => {
    it("should store directives in union type extensions", () => {
      const builder = GraphQLSchemaBuilder.empty
        .objectType({
          name: "Dog",
          schema: S.Struct({ name: S.String, breed: S.String }),
        })
        .objectType({
          name: "Cat",
          schema: S.Struct({ name: S.String, color: S.String }),
        })
        .unionType({
          name: "Pet",
          types: ["Dog", "Cat"],
          directives: [{ name: "tag", args: { name: "public" } }],
        })
        .query("pet", {
          type: S.Struct({ name: S.String }),
          resolve: () => Effect.succeed({ name: "Buddy" }),
        })

      const schema = builder.buildSchema()
      const petType = schema.getType("Pet") as GraphQLUnionType

      expect(petType).toBeDefined()
      expect(petType.extensions).toBeDefined()
      expect(petType.extensions?.directives).toEqual([
        { name: "tag", args: { name: "public" } },
      ])
    })

    it("should not add extensions when no directives specified", () => {
      const builder = GraphQLSchemaBuilder.empty
        .objectType({
          name: "Dog",
          schema: S.Struct({ name: S.String }),
        })
        .objectType({
          name: "Cat",
          schema: S.Struct({ name: S.String }),
        })
        .unionType({
          name: "Pet",
          types: ["Dog", "Cat"],
        })
        .query("dummy", {
          type: S.String,
          resolve: () => Effect.succeed(""),
        })

      const schema = builder.buildSchema()
      const petType = schema.getType("Pet") as GraphQLUnionType

      expect(petType).toBeDefined()
      expect(petType.extensions?.directives).toBeUndefined()
    })
  })

  // ==========================================================================
  // Input Type Directives
  // ==========================================================================
  describe("inputType directives", () => {
    it("should store directives in input type extensions", () => {
      const builder = GraphQLSchemaBuilder.empty
        .inputType({
          name: "CreateUserInput",
          schema: S.Struct({ name: S.String, email: S.String }),
          directives: [{ name: "inaccessible" }],
        })
        .query("dummy", {
          type: S.String,
          resolve: () => Effect.succeed(""),
        })

      const schema = builder.buildSchema()
      const inputType = schema.getType("CreateUserInput") as GraphQLInputObjectType

      expect(inputType).toBeDefined()
      expect(inputType.extensions).toBeDefined()
      expect(inputType.extensions?.directives).toEqual([
        { name: "inaccessible" },
      ])
    })

    it("should not add extensions when no directives specified", () => {
      const builder = GraphQLSchemaBuilder.empty
        .inputType({
          name: "CreateUserInput",
          schema: S.Struct({ name: S.String }),
        })
        .query("dummy", {
          type: S.String,
          resolve: () => Effect.succeed(""),
        })

      const schema = builder.buildSchema()
      const inputType = schema.getType("CreateUserInput") as GraphQLInputObjectType

      expect(inputType).toBeDefined()
      expect(inputType.extensions?.directives).toBeUndefined()
    })
  })

  // ==========================================================================
  // Multiple Directives
  // ==========================================================================
  describe("multiple directives", () => {
    it("should support multiple directives on the same type", () => {
      const builder = GraphQLSchemaBuilder.empty
        .objectType({
          name: "Product",
          schema: S.Struct({ id: S.String, sku: S.String }),
          directives: [
            { name: "key", args: { fields: "id" } },
            { name: "key", args: { fields: "sku" } },
            { name: "shareable" },
            { name: "tag", args: { name: "catalog" } },
          ],
        })
        .query("product", {
          type: S.Struct({ id: S.String, sku: S.String }),
          resolve: () => Effect.succeed({ id: "1", sku: "ABC" }),
        })

      const schema = builder.buildSchema()
      const productType = schema.getType("Product") as GraphQLObjectType

      expect(productType.extensions?.directives).toEqual([
        { name: "key", args: { fields: "id" } },
        { name: "key", args: { fields: "sku" } },
        { name: "shareable" },
        { name: "tag", args: { name: "catalog" } },
      ])
    })
  })

  // ==========================================================================
  // Pipe API
  // ==========================================================================
  describe("pipe API with directives", () => {
    it("should support directives via pipe API", async () => {
      const { objectType, enumType, query } = await import("../../../src/builder/pipe-api")

      const builder = GraphQLSchemaBuilder.empty.pipe(
        objectType({
          name: "User",
          schema: S.Struct({ id: S.String }),
          directives: [{ name: "key", args: { fields: "id" } }],
        }),
        enumType({
          name: "Role",
          values: ["ADMIN", "USER"],
          directives: [{ name: "shareable" }],
        }),
        query("user", {
          type: S.Struct({ id: S.String }),
          resolve: () => Effect.succeed({ id: "1" }),
        }),
      )

      const schema = builder.buildSchema()

      const userType = schema.getType("User") as GraphQLObjectType
      expect(userType.extensions?.directives).toEqual([
        { name: "key", args: { fields: "id" } },
      ])

      const roleType = schema.getType("Role") as GraphQLEnumType
      expect(roleType.extensions?.directives).toEqual([
        { name: "shareable" },
      ])
    })
  })
})
