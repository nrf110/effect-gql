import { describe, it, expect } from "vitest"
import { Effect, Stream } from "effect"
import * as S from "effect/Schema"
import { DirectiveLocation } from "graphql"
import { GraphQLSchemaBuilder } from "../../../src/builder/schema-builder"
import {
  objectType,
  interfaceType,
  enumType,
  unionType,
  inputType,
  directive,
  query,
  mutation,
  subscription,
  field,
  compose,
} from "../../../src/builder/pipe-api"

describe("pipe-api.ts", () => {
  // ==========================================================================
  // objectType
  // ==========================================================================
  describe("objectType", () => {
    it("should delegate to builder.objectType", () => {
      const UserSchema = S.TaggedStruct("User", { id: S.String })

      const builder = GraphQLSchemaBuilder.empty.pipe(
        objectType({ schema: UserSchema }),
        query("user", {
          type: UserSchema,
          resolve: () => Effect.succeed({ _tag: "User" as const, id: "1" }),
        })
      )

      const schema = builder.buildSchema()
      expect(schema.getType("User")).toBeDefined()
    })

    it("should support explicit name", () => {
      const schema = GraphQLSchemaBuilder.empty.pipe(
        objectType({ name: "Person", schema: S.Struct({ id: S.String }) }),
        query("person", {
          type: S.Struct({ id: S.String }),
          resolve: () => Effect.succeed({ id: "1" }),
        })
      ).buildSchema()

      expect(schema.getType("Person")).toBeDefined()
    })
  })

  // ==========================================================================
  // interfaceType
  // ==========================================================================
  describe("interfaceType", () => {
    it("should delegate to builder.interfaceType", () => {
      const NodeSchema = S.Struct({ id: S.String })

      const builder = GraphQLSchemaBuilder.empty.pipe(
        interfaceType({ name: "Node", schema: NodeSchema }),
        objectType({
          name: "User",
          schema: S.Struct({ id: S.String }),
          implements: ["Node"],
        }),
        query("test", { type: S.String, resolve: () => Effect.succeed("") })
      )

      const schema = builder.buildSchema()
      expect(schema.getType("Node")).toBeDefined()
    })
  })

  // ==========================================================================
  // enumType
  // ==========================================================================
  describe("enumType", () => {
    it("should delegate to builder.enumType", () => {
      const builder = GraphQLSchemaBuilder.empty.pipe(
        enumType({ name: "Status", values: ["ACTIVE", "INACTIVE"] }),
        query("test", { type: S.String, resolve: () => Effect.succeed("") })
      )

      const schema = builder.buildSchema()
      expect(schema.getType("Status")).toBeDefined()
    })
  })

  // ==========================================================================
  // unionType
  // ==========================================================================
  describe("unionType", () => {
    it("should delegate to builder.unionType", () => {
      const TextSchema = S.TaggedStruct("Text", { body: S.String })
      const ImageSchema = S.TaggedStruct("Image", { url: S.String })

      const builder = GraphQLSchemaBuilder.empty.pipe(
        objectType({ schema: TextSchema }),
        objectType({ schema: ImageSchema }),
        unionType({ name: "Content", types: ["Text", "Image"] }),
        query("test", { type: S.String, resolve: () => Effect.succeed("") })
      )

      const schema = builder.buildSchema()
      expect(schema.getType("Content")).toBeDefined()
    })
  })

  // ==========================================================================
  // inputType
  // ==========================================================================
  describe("inputType", () => {
    it("should delegate to builder.inputType", () => {
      const InputSchema = S.Struct({ name: S.String })

      const builder = GraphQLSchemaBuilder.empty.pipe(
        inputType({ name: "CreateInput", schema: InputSchema }),
        mutation("create", {
          type: S.String,
          args: S.Struct({ input: InputSchema }),
          resolve: () => Effect.succeed("created"),
        })
      )

      const schema = builder.buildSchema()
      expect(schema.getType("CreateInput")).toBeDefined()
    })
  })

  // ==========================================================================
  // directive
  // ==========================================================================
  describe("directive", () => {
    it("should delegate to builder.directive", () => {
      const builder = GraphQLSchemaBuilder.empty.pipe(
        directive({
          name: "auth",
          locations: [DirectiveLocation.FIELD_DEFINITION],
        }),
        query("test", { type: S.String, resolve: () => Effect.succeed("") })
      )

      const schema = builder.buildSchema()
      expect(schema.getDirectives().some((d) => d.name === "auth")).toBe(true)
    })
  })

  // ==========================================================================
  // query
  // ==========================================================================
  describe("query", () => {
    it("should delegate to builder.query", () => {
      const builder = GraphQLSchemaBuilder.empty.pipe(
        query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        })
      )

      const schema = builder.buildSchema()
      expect(schema.getQueryType()?.getFields().hello).toBeDefined()
    })

    it("should support args", () => {
      const builder = GraphQLSchemaBuilder.empty.pipe(
        query("greet", {
          type: S.String,
          args: S.Struct({ name: S.String }),
          resolve: (args) => Effect.succeed(`Hello ${args.name}`),
        })
      )

      const schema = builder.buildSchema()
      const field = schema.getQueryType()?.getFields().greet
      expect(field?.args.some((a) => a.name === "name")).toBe(true)
    })
  })

  // ==========================================================================
  // mutation
  // ==========================================================================
  describe("mutation", () => {
    it("should delegate to builder.mutation", () => {
      const builder = GraphQLSchemaBuilder.empty.pipe(
        mutation("create", {
          type: S.String,
          resolve: () => Effect.succeed("created"),
        })
      )

      const schema = builder.buildSchema()
      expect(schema.getMutationType()?.getFields().create).toBeDefined()
    })
  })

  // ==========================================================================
  // subscription
  // ==========================================================================
  describe("subscription", () => {
    it("should delegate to builder.subscription", () => {
      const builder = GraphQLSchemaBuilder.empty.pipe(
        subscription("events", {
          type: S.String,
          subscribe: () => Effect.succeed(Stream.empty),
        })
      )

      const schema = builder.buildSchema()
      expect(schema.getSubscriptionType()?.getFields().events).toBeDefined()
    })
  })

  // ==========================================================================
  // field
  // ==========================================================================
  describe("field", () => {
    it("should delegate to builder.field", () => {
      const UserSchema = S.Struct({ id: S.String, name: S.String })

      const builder = GraphQLSchemaBuilder.empty.pipe(
        objectType({ name: "User", schema: UserSchema }),
        field("User", "greeting", {
          type: S.String,
          resolve: (parent: { name: string }) =>
            Effect.succeed(`Hello, ${parent.name}`),
        }),
        query("user", {
          type: UserSchema,
          resolve: () => Effect.succeed({ id: "1", name: "Test" }),
        })
      )

      const schema = builder.buildSchema()
      const userType = schema.getType("User") as any
      expect(userType.getFields().greeting).toBeDefined()
    })
  })

  // ==========================================================================
  // compose
  // ==========================================================================
  describe("compose", () => {
    it("should compose multiple operations", () => {
      const builder = GraphQLSchemaBuilder.empty.pipe(
        compose(
          query("a", { type: S.String, resolve: () => Effect.succeed("a") }),
          query("b", { type: S.String, resolve: () => Effect.succeed("b") }),
          query("c", { type: S.String, resolve: () => Effect.succeed("c") })
        )
      )

      const schema = builder.buildSchema()
      const queryType = schema.getQueryType()!
      expect(queryType.getFields().a).toBeDefined()
      expect(queryType.getFields().b).toBeDefined()
      expect(queryType.getFields().c).toBeDefined()
    })

    it("should handle empty array", () => {
      const builder = GraphQLSchemaBuilder.empty.pipe(
        compose(),
        query("test", { type: S.String, resolve: () => Effect.succeed("") })
      )

      const schema = builder.buildSchema()
      expect(schema.getQueryType()).toBeDefined()
    })

    it("should preserve builder chain", () => {
      const builder = GraphQLSchemaBuilder.empty.pipe(
        query("first", { type: S.String, resolve: () => Effect.succeed("1") }),
        compose(
          mutation("create", { type: S.String, resolve: () => Effect.succeed("c") })
        ),
        query("last", { type: S.String, resolve: () => Effect.succeed("2") })
      )

      const schema = builder.buildSchema()
      expect(schema.getQueryType()?.getFields().first).toBeDefined()
      expect(schema.getQueryType()?.getFields().last).toBeDefined()
      expect(schema.getMutationType()?.getFields().create).toBeDefined()
    })
  })

  // ==========================================================================
  // Chaining multiple operations
  // ==========================================================================
  describe("Chaining", () => {
    it("should support chaining all operations", () => {
      const UserSchema = S.TaggedStruct("User", { id: S.String })
      const CreateUserInput = S.Struct({ name: S.String })

      const builder = GraphQLSchemaBuilder.empty.pipe(
        enumType({ name: "Status", values: ["ACTIVE"] }),
        inputType({ name: "CreateUserInput", schema: CreateUserInput }),
        objectType({ schema: UserSchema }),
        directive({
          name: "log",
          locations: [DirectiveLocation.FIELD_DEFINITION],
        }),
        query("users", {
          type: S.Array(UserSchema),
          resolve: () => Effect.succeed([]),
        }),
        mutation("createUser", {
          type: UserSchema,
          args: S.Struct({ input: CreateUserInput }),
          resolve: () => Effect.succeed({ _tag: "User" as const, id: "new" }),
        }),
        field("User", "status", {
          type: S.Literal("ACTIVE"),
          resolve: () => Effect.succeed("ACTIVE" as const),
        })
      )

      const schema = builder.buildSchema()

      expect(schema.getType("Status")).toBeDefined()
      expect(schema.getType("CreateUserInput")).toBeDefined()
      expect(schema.getType("User")).toBeDefined()
      expect(schema.getDirectives().some((d) => d.name === "log")).toBe(true)
      expect(schema.getQueryType()?.getFields().users).toBeDefined()
      expect(schema.getMutationType()?.getFields().createUser).toBeDefined()
    })
  })
})
