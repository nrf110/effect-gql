import { describe, it, expect } from "vitest"
import { Effect, Stream } from "effect"
import * as S from "effect/Schema"
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLEnumType,
  GraphQLUnionType,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLString,
  GraphQLInt,
  DirectiveLocation,
  isNonNullType,
  printSchema,
} from "graphql"
import { GraphQLSchemaBuilder } from "../../../src/builder/schema-builder"

describe("schema-builder.ts", () => {
  // ==========================================================================
  // GraphQLSchemaBuilder.empty
  // ==========================================================================
  describe("GraphQLSchemaBuilder.empty", () => {
    it("should create an empty builder", () => {
      const builder = GraphQLSchemaBuilder.empty
      expect(builder).toBeDefined()
    })

    it("should be reusable (static instance)", () => {
      const builder1 = GraphQLSchemaBuilder.empty
      const builder2 = GraphQLSchemaBuilder.empty
      expect(builder1).toBe(builder2)
    })
  })

  // ==========================================================================
  // Pipeable interface
  // ==========================================================================
  describe("Pipeable interface", () => {
    it("should support pipe() with single operation", () => {
      const builder = GraphQLSchemaBuilder.empty.pipe((b) =>
        b.query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        })
      )
      expect(builder).toBeDefined()
    })

    it("should support pipe() with multiple operations", () => {
      const builder = GraphQLSchemaBuilder.empty.pipe(
        (b) => b.query("a", { type: S.String, resolve: () => Effect.succeed("a") }),
        (b) => b.query("b", { type: S.String, resolve: () => Effect.succeed("b") })
      )
      const schema = builder.buildSchema()
      const queryType = schema.getQueryType()!
      const fields = queryType.getFields()
      expect(fields.a).toBeDefined()
      expect(fields.b).toBeDefined()
    })
  })

  // ==========================================================================
  // query()
  // ==========================================================================
  describe("query()", () => {
    it("should add query field to schema", () => {
      const builder = GraphQLSchemaBuilder.empty.query("hello", {
        type: S.String,
        resolve: () => Effect.succeed("world"),
      })
      const schema = builder.buildSchema()

      const queryType = schema.getQueryType()
      expect(queryType).toBeDefined()
      expect(queryType!.getFields().hello).toBeDefined()
    })

    it("should preserve query field type", () => {
      const builder = GraphQLSchemaBuilder.empty.query("count", {
        type: S.Int,
        resolve: () => Effect.succeed(42),
      })
      const schema = builder.buildSchema()

      const queryType = schema.getQueryType()!
      const field = queryType.getFields().count
      expect(field.type).toBe(GraphQLInt)
    })

    it("should include description", () => {
      const builder = GraphQLSchemaBuilder.empty.query("hello", {
        type: S.String,
        description: "Returns hello world",
        resolve: () => Effect.succeed("world"),
      })
      const schema = builder.buildSchema()

      const queryType = schema.getQueryType()!
      const field = queryType.getFields().hello
      expect(field.description).toBe("Returns hello world")
    })

    it("should support args", () => {
      const builder = GraphQLSchemaBuilder.empty.query("greet", {
        type: S.String,
        args: S.Struct({ name: S.String }),
        resolve: (args) => Effect.succeed(`Hello ${args.name}`),
      })
      const schema = builder.buildSchema()

      const queryType = schema.getQueryType()!
      const field = queryType.getFields().greet
      expect(field.args).toHaveLength(1)
      expect(field.args[0].name).toBe("name")
    })

    it("should return new builder (immutability)", () => {
      const builder1 = GraphQLSchemaBuilder.empty
      const builder2 = builder1.query("test", {
        type: S.String,
        resolve: () => Effect.succeed("test"),
      })
      expect(builder2).not.toBe(builder1)
    })
  })

  // ==========================================================================
  // mutation()
  // ==========================================================================
  describe("mutation()", () => {
    it("should add mutation field to schema", () => {
      const builder = GraphQLSchemaBuilder.empty.mutation("createUser", {
        type: S.String,
        args: S.Struct({ name: S.String }),
        resolve: (args) => Effect.succeed(`Created ${args.name}`),
      })
      const schema = builder.buildSchema()

      const mutationType = schema.getMutationType()
      expect(mutationType).toBeDefined()
      expect(mutationType!.getFields().createUser).toBeDefined()
    })

    it("should return new builder (immutability)", () => {
      const builder1 = GraphQLSchemaBuilder.empty
      const builder2 = builder1.mutation("test", {
        type: S.String,
        resolve: () => Effect.succeed("test"),
      })
      expect(builder2).not.toBe(builder1)
    })
  })

  // ==========================================================================
  // subscription()
  // ==========================================================================
  describe("subscription()", () => {
    it("should add subscription field to schema", () => {
      const builder = GraphQLSchemaBuilder.empty.subscription("events", {
        type: S.String,
        subscribe: () => Effect.succeed(Stream.make("event1", "event2")),
      })
      const schema = builder.buildSchema()

      const subscriptionType = schema.getSubscriptionType()
      expect(subscriptionType).toBeDefined()
      expect(subscriptionType!.getFields().events).toBeDefined()
    })

    it("should return new builder (immutability)", () => {
      const builder1 = GraphQLSchemaBuilder.empty
      const builder2 = builder1.subscription("test", {
        type: S.String,
        subscribe: () => Effect.succeed(Stream.empty),
      })
      expect(builder2).not.toBe(builder1)
    })
  })

  // ==========================================================================
  // objectType()
  // ==========================================================================
  describe("objectType()", () => {
    it("should register object type with explicit name", () => {
      const UserSchema = S.Struct({ id: S.String, name: S.String })
      const builder = GraphQLSchemaBuilder.empty
        .objectType({ name: "User", schema: UserSchema })
        .query("user", {
          type: UserSchema,
          resolve: () => Effect.succeed({ id: "1", name: "Test" }),
        })

      const schema = builder.buildSchema()
      const userType = schema.getType("User")
      expect(userType).toBeInstanceOf(GraphQLObjectType)
    })

    it("should infer name from TaggedStruct", () => {
      const UserSchema = S.TaggedStruct("User", { id: S.String })
      const builder = GraphQLSchemaBuilder.empty.objectType({ schema: UserSchema }).query("user", {
        type: UserSchema,
        resolve: () => Effect.succeed({ _tag: "User" as const, id: "1" }),
      })

      const schema = builder.buildSchema()
      const userType = schema.getType("User")
      expect(userType).toBeInstanceOf(GraphQLObjectType)
    })

    it("should throw without name for plain struct", () => {
      const PlainSchema = S.Struct({ id: S.String })
      expect(() => {
        GraphQLSchemaBuilder.empty.objectType({ schema: PlainSchema })
      }).toThrow("objectType requires a name")
    })

    it("should support implements for interfaces", () => {
      const NodeSchema = S.Struct({ id: S.String })
      const UserSchema = S.Struct({ id: S.String, name: S.String })

      const builder = GraphQLSchemaBuilder.empty
        .interfaceType({ name: "Node", schema: NodeSchema })
        .objectType({ name: "User", schema: UserSchema, implements: ["Node"] })
        .query("user", {
          type: UserSchema,
          resolve: () => Effect.succeed({ id: "1", name: "Test" }),
        })

      const schema = builder.buildSchema()
      const userType = schema.getType("User") as GraphQLObjectType
      const interfaces = userType.getInterfaces()
      expect(interfaces.some((i) => i.name === "Node")).toBe(true)
    })

    it("should return new builder (immutability)", () => {
      const builder1 = GraphQLSchemaBuilder.empty
      const builder2 = builder1.objectType({
        name: "Test",
        schema: S.Struct({ id: S.String }),
      })
      expect(builder2).not.toBe(builder1)
    })

    it("should support additional fields with resolvers", () => {
      const UserSchema = S.Struct({ id: S.String, firstName: S.String, lastName: S.String })

      const builder = GraphQLSchemaBuilder.empty
        .objectType({
          name: "User",
          schema: UserSchema,
          fields: {
            fullName: {
              type: S.String,
              resolve: (parent) => Effect.succeed(`${parent.firstName} ${parent.lastName}`),
            },
          },
        })
        .query("user", {
          type: UserSchema,
          resolve: () =>
            Effect.succeed({
              id: "1",
              firstName: "John",
              lastName: "Doe",
            }),
        })

      const schema = builder.buildSchema()
      const userType = schema.getType("User") as GraphQLObjectType
      const fields = userType.getFields()
      expect(fields.fullName).toBeDefined()
    })
  })

  // ==========================================================================
  // interfaceType()
  // ==========================================================================
  describe("interfaceType()", () => {
    it("should register interface type", () => {
      const NodeSchema = S.Struct({ id: S.String })
      const builder = GraphQLSchemaBuilder.empty
        .interfaceType({ name: "Node", schema: NodeSchema })
        .objectType({
          name: "User",
          schema: S.Struct({ id: S.String, name: S.String }),
          implements: ["Node"],
        })
        .query("node", {
          type: NodeSchema,
          resolve: () => Effect.succeed({ id: "1", _tag: "User" }),
        })

      const schema = builder.buildSchema()
      const nodeType = schema.getType("Node")
      expect(nodeType).toBeInstanceOf(GraphQLInterfaceType)
    })

    it("should throw without name for plain struct", () => {
      expect(() => {
        GraphQLSchemaBuilder.empty.interfaceType({
          schema: S.Struct({ id: S.String }),
        })
      }).toThrow("interfaceType requires a name")
    })

    it("should use default resolveType (uses _tag)", () => {
      const NodeSchema = S.Struct({ id: S.String })
      const builder = GraphQLSchemaBuilder.empty.interfaceType({ name: "Node", schema: NodeSchema })

      // This tests internal behavior - the interface should be created
      const schema = builder
        .objectType({
          name: "User",
          schema: S.Struct({ id: S.String }),
          implements: ["Node"],
        })
        .query("test", { type: S.String, resolve: () => Effect.succeed("") })
        .buildSchema()

      expect(schema.getType("Node")).toBeInstanceOf(GraphQLInterfaceType)
    })

    it("should return new builder (immutability)", () => {
      const builder1 = GraphQLSchemaBuilder.empty
      const builder2 = builder1.interfaceType({
        name: "Node",
        schema: S.Struct({ id: S.String }),
      })
      expect(builder2).not.toBe(builder1)
    })
  })

  // ==========================================================================
  // enumType()
  // ==========================================================================
  describe("enumType()", () => {
    it("should register enum type", () => {
      const builder = GraphQLSchemaBuilder.empty
        .enumType({
          name: "Status",
          values: ["ACTIVE", "INACTIVE"],
        })
        .query("status", {
          type: S.Literal("ACTIVE", "INACTIVE"),
          resolve: () => Effect.succeed("ACTIVE" as const),
        })

      const schema = builder.buildSchema()
      const enumType = schema.getType("Status")
      expect(enumType).toBeInstanceOf(GraphQLEnumType)
    })

    it("should include description", () => {
      const builder = GraphQLSchemaBuilder.empty
        .enumType({
          name: "Status",
          values: ["ACTIVE", "INACTIVE"],
          description: "User status enum",
        })
        .query("test", { type: S.String, resolve: () => Effect.succeed("") })

      const schema = builder.buildSchema()
      const enumType = schema.getType("Status") as GraphQLEnumType
      expect(enumType.description).toBe("User status enum")
    })

    it("should create enum values correctly", () => {
      const builder = GraphQLSchemaBuilder.empty
        .enumType({
          name: "Priority",
          values: ["LOW", "MEDIUM", "HIGH"],
        })
        .query("test", { type: S.String, resolve: () => Effect.succeed("") })

      const schema = builder.buildSchema()
      const enumType = schema.getType("Priority") as GraphQLEnumType
      const values = enumType.getValues()
      expect(values.map((v) => v.name).sort()).toEqual(["HIGH", "LOW", "MEDIUM"])
    })

    it("should return new builder (immutability)", () => {
      const builder1 = GraphQLSchemaBuilder.empty
      const builder2 = builder1.enumType({
        name: "Status",
        values: ["A"],
      })
      expect(builder2).not.toBe(builder1)
    })
  })

  // ==========================================================================
  // unionType()
  // ==========================================================================
  describe("unionType()", () => {
    it("should register union type", () => {
      const TextSchema = S.TaggedStruct("Text", { body: S.String })
      const ImageSchema = S.TaggedStruct("Image", { url: S.String })

      const builder = GraphQLSchemaBuilder.empty
        .objectType({ schema: TextSchema })
        .objectType({ schema: ImageSchema })
        .unionType({
          name: "Content",
          types: ["Text", "Image"],
        })
        .query("content", {
          type: S.Union(TextSchema, ImageSchema),
          resolve: () => Effect.succeed({ _tag: "Text" as const, body: "Hello" }),
        })

      const schema = builder.buildSchema()
      const unionType = schema.getType("Content")
      expect(unionType).toBeInstanceOf(GraphQLUnionType)
    })

    it("should include member types", () => {
      const TextSchema = S.TaggedStruct("Text", { body: S.String })
      const ImageSchema = S.TaggedStruct("Image", { url: S.String })

      const builder = GraphQLSchemaBuilder.empty
        .objectType({ schema: TextSchema })
        .objectType({ schema: ImageSchema })
        .unionType({
          name: "Content",
          types: ["Text", "Image"],
        })
        .query("test", { type: S.String, resolve: () => Effect.succeed("") })

      const schema = builder.buildSchema()
      const unionType = schema.getType("Content") as GraphQLUnionType
      const types = unionType.getTypes()
      expect(types.map((t) => t.name).sort()).toEqual(["Image", "Text"])
    })

    it("should return new builder (immutability)", () => {
      const builder1 = GraphQLSchemaBuilder.empty
      const builder2 = builder1.unionType({
        name: "Test",
        types: [],
      })
      expect(builder2).not.toBe(builder1)
    })
  })

  // ==========================================================================
  // inputType()
  // ==========================================================================
  describe("inputType()", () => {
    it("should register input type", () => {
      const CreateUserInput = S.Struct({
        name: S.String,
        email: S.optional(S.String),
      })

      const builder = GraphQLSchemaBuilder.empty
        .inputType({ name: "CreateUserInput", schema: CreateUserInput })
        .mutation("createUser", {
          type: S.String,
          args: S.Struct({ input: CreateUserInput }),
          resolve: () => Effect.succeed("created"),
        })

      const schema = builder.buildSchema()
      const inputType = schema.getType("CreateUserInput")
      expect(inputType).toBeInstanceOf(GraphQLInputObjectType)
    })

    it("should throw without name for plain struct", () => {
      expect(() => {
        GraphQLSchemaBuilder.empty.inputType({
          schema: S.Struct({ name: S.String }),
        })
      }).toThrow("inputType requires a name")
    })

    it("should include description", () => {
      const builder = GraphQLSchemaBuilder.empty
        .inputType({
          name: "TestInput",
          schema: S.Struct({ value: S.String }),
          description: "Test input type",
        })
        .query("test", { type: S.String, resolve: () => Effect.succeed("") })

      const schema = builder.buildSchema()
      const inputType = schema.getType("TestInput") as GraphQLInputObjectType
      expect(inputType.description).toBe("Test input type")
    })

    it("should return new builder (immutability)", () => {
      const builder1 = GraphQLSchemaBuilder.empty
      const builder2 = builder1.inputType({
        name: "Test",
        schema: S.Struct({ id: S.String }),
      })
      expect(builder2).not.toBe(builder1)
    })
  })

  // ==========================================================================
  // directive()
  // ==========================================================================
  describe("directive()", () => {
    it("should register directive", () => {
      const builder = GraphQLSchemaBuilder.empty
        .directive({
          name: "auth",
          locations: [DirectiveLocation.FIELD_DEFINITION],
        })
        .query("test", { type: S.String, resolve: () => Effect.succeed("") })

      const schema = builder.buildSchema()
      const directives = schema.getDirectives()
      expect(directives.some((d) => d.name === "auth")).toBe(true)
    })

    it("should include directive description", () => {
      const builder = GraphQLSchemaBuilder.empty
        .directive({
          name: "auth",
          description: "Authentication directive",
          locations: [DirectiveLocation.FIELD_DEFINITION],
        })
        .query("test", { type: S.String, resolve: () => Effect.succeed("") })

      const schema = builder.buildSchema()
      const directive = schema.getDirectives().find((d) => d.name === "auth")
      expect(directive?.description).toBe("Authentication directive")
    })

    it("should support directive args", () => {
      const builder = GraphQLSchemaBuilder.empty
        .directive({
          name: "auth",
          locations: [DirectiveLocation.FIELD_DEFINITION],
          args: S.Struct({ role: S.String }),
        })
        .query("test", { type: S.String, resolve: () => Effect.succeed("") })

      const schema = builder.buildSchema()
      const directive = schema.getDirectives().find((d) => d.name === "auth")
      expect(directive?.args).toHaveLength(1)
      expect(directive?.args[0].name).toBe("role")
    })

    it("should return new builder (immutability)", () => {
      const builder1 = GraphQLSchemaBuilder.empty
      const builder2 = builder1.directive({
        name: "test",
        locations: [DirectiveLocation.FIELD_DEFINITION],
      })
      expect(builder2).not.toBe(builder1)
    })
  })

  // ==========================================================================
  // field()
  // ==========================================================================
  describe("field()", () => {
    it("should add field to existing type", () => {
      const UserSchema = S.Struct({ id: S.String, name: S.String })

      const builder = GraphQLSchemaBuilder.empty
        .objectType({ name: "User", schema: UserSchema })
        .field("User", "greeting", {
          type: S.String,
          resolve: (parent: { name: string }) => Effect.succeed(`Hello, ${parent.name}!`),
        })
        .query("user", {
          type: UserSchema,
          resolve: () => Effect.succeed({ id: "1", name: "Test" }),
        })

      const schema = builder.buildSchema()
      const userType = schema.getType("User") as GraphQLObjectType
      const fields = userType.getFields()
      expect(fields.greeting).toBeDefined()
    })

    it("should support field args", () => {
      const UserSchema = S.Struct({ id: S.String })

      const builder = GraphQLSchemaBuilder.empty
        .objectType({ name: "User", schema: UserSchema })
        .field("User", "posts", {
          type: S.Array(S.String),
          args: S.Struct({ limit: S.optional(S.Int) }),
          resolve: () => Effect.succeed(["post1", "post2"]),
        })
        .query("user", {
          type: UserSchema,
          resolve: () => Effect.succeed({ id: "1" }),
        })

      const schema = builder.buildSchema()
      const userType = schema.getType("User") as GraphQLObjectType
      const postsField = userType.getFields().posts
      expect(postsField.args.some((a) => a.name === "limit")).toBe(true)
    })

    it("should return new builder (immutability)", () => {
      const builder1 = GraphQLSchemaBuilder.empty.objectType({
        name: "User",
        schema: S.Struct({ id: S.String }),
      })
      const builder2 = builder1.field("User", "test", {
        type: S.String,
        resolve: () => Effect.succeed("test"),
      })
      expect(builder2).not.toBe(builder1)
    })
  })

  // ==========================================================================
  // buildSchema()
  // ==========================================================================
  describe("buildSchema()", () => {
    it("should build valid GraphQL schema", () => {
      const builder = GraphQLSchemaBuilder.empty.query("hello", {
        type: S.String,
        resolve: () => Effect.succeed("world"),
      })
      const schema = builder.buildSchema()

      expect(schema).toBeInstanceOf(GraphQLSchema)
    })

    it("should include Query type when queries exist", () => {
      const builder = GraphQLSchemaBuilder.empty.query("test", {
        type: S.String,
        resolve: () => Effect.succeed("test"),
      })
      const schema = builder.buildSchema()

      expect(schema.getQueryType()).toBeDefined()
    })

    it("should include Mutation type when mutations exist", () => {
      const builder = GraphQLSchemaBuilder.empty.mutation("test", {
        type: S.String,
        resolve: () => Effect.succeed("test"),
      })
      const schema = builder.buildSchema()

      expect(schema.getMutationType()).toBeDefined()
    })

    it("should include Subscription type when subscriptions exist", () => {
      const builder = GraphQLSchemaBuilder.empty.subscription("test", {
        type: S.String,
        subscribe: () => Effect.succeed(Stream.empty),
      })
      const schema = builder.buildSchema()

      expect(schema.getSubscriptionType()).toBeDefined()
    })

    it("should not include Query type when no queries", () => {
      const builder = GraphQLSchemaBuilder.empty.enumType({ name: "Status", values: ["A"] })

      const schema = builder.buildSchema()
      // getQueryType returns undefined when there's no query type
      expect(schema.getQueryType()).toBeUndefined()
    })

    it("should include all registered types", () => {
      const UserSchema = S.Struct({ id: S.String })

      const builder = GraphQLSchemaBuilder.empty
        .enumType({ name: "Status", values: ["ACTIVE"] })
        .inputType({ name: "UserInput", schema: S.Struct({ name: S.String }) })
        .objectType({ name: "User", schema: UserSchema })
        .query("user", {
          type: UserSchema,
          resolve: () => Effect.succeed({ id: "1" }),
        })

      const schema = builder.buildSchema()

      expect(schema.getType("Status")).toBeInstanceOf(GraphQLEnumType)
      expect(schema.getType("UserInput")).toBeInstanceOf(GraphQLInputObjectType)
      expect(schema.getType("User")).toBeInstanceOf(GraphQLObjectType)
    })

    it("should include registered directives", () => {
      const builder = GraphQLSchemaBuilder.empty
        .directive({
          name: "custom",
          locations: [DirectiveLocation.FIELD_DEFINITION],
        })
        .query("test", { type: S.String, resolve: () => Effect.succeed("") })

      const schema = builder.buildSchema()
      const directives = schema.getDirectives()
      expect(directives.some((d) => d.name === "custom")).toBe(true)
    })
  })

  // ==========================================================================
  // Complex schema building
  // ==========================================================================
  describe("Complex schema building", () => {
    it("should build complete schema with all features", () => {
      const UserSchema = S.TaggedStruct("User", {
        id: S.String,
        name: S.String,
        status: S.Literal("ACTIVE", "INACTIVE"),
      })

      const CreateUserInput = S.Struct({
        name: S.String,
        status: S.optional(S.Literal("ACTIVE", "INACTIVE")),
      })

      const builder = GraphQLSchemaBuilder.empty
        .enumType({
          name: "UserStatus",
          values: ["ACTIVE", "INACTIVE"],
          description: "User account status",
        })
        .inputType({
          name: "CreateUserInput",
          schema: CreateUserInput,
        })
        .objectType({ schema: UserSchema })
        .query("users", {
          type: S.Array(UserSchema),
          description: "Get all users",
          resolve: () => Effect.succeed([]),
        })
        .query("user", {
          type: UserSchema,
          args: S.Struct({ id: S.String }),
          resolve: (args) =>
            Effect.succeed({
              _tag: "User" as const,
              id: args.id,
              name: "Test",
              status: "ACTIVE" as const,
            }),
        })
        .mutation("createUser", {
          type: UserSchema,
          args: S.Struct({ input: CreateUserInput }),
          resolve: (args) =>
            Effect.succeed({
              _tag: "User" as const,
              id: "new-id",
              name: args.input.name,
              status: args.input.status ?? ("ACTIVE" as const),
            }),
        })

      const schema = builder.buildSchema()

      // Verify schema structure
      expect(schema.getQueryType()).toBeDefined()
      expect(schema.getMutationType()).toBeDefined()
      expect(schema.getType("User")).toBeInstanceOf(GraphQLObjectType)
      expect(schema.getType("UserStatus")).toBeInstanceOf(GraphQLEnumType)
      expect(schema.getType("CreateUserInput")).toBeInstanceOf(GraphQLInputObjectType)

      // Verify the schema is valid
      const sdl = printSchema(schema)
      expect(sdl).toContain("type Query")
      expect(sdl).toContain("type Mutation")
      expect(sdl).toContain("type User")
      expect(sdl).toContain("enum UserStatus")
      expect(sdl).toContain("input CreateUserInput")
    })
  })

  // ==========================================================================
  // Recursive/Self-referential types
  // ==========================================================================
  describe("Recursive/Self-referential types", () => {
    it("should build schema with self-referential object type using S.suspend", () => {
      // Define a self-referential Person schema
      interface Person {
        readonly name: string
        readonly friends: readonly Person[]
      }
      const PersonSchema: S.Schema<Person> = S.Struct({
        name: S.String,
        friends: S.Array(S.suspend(() => PersonSchema)),
      })

      const builder = GraphQLSchemaBuilder.empty
        .objectType({ name: "Person", schema: PersonSchema })
        .query("person", {
          type: PersonSchema,
          resolve: () => Effect.succeed({ name: "Alice", friends: [] }),
        })

      const schema = builder.buildSchema()

      // Verify Person type exists
      const personType = schema.getType("Person") as GraphQLObjectType
      expect(personType).toBeInstanceOf(GraphQLObjectType)

      // Verify fields
      const fields = personType.getFields()
      expect(fields.name).toBeDefined()
      expect(fields.friends).toBeDefined()

      // Verify friends field is a list of Person
      const friendsType = fields.friends.type
      expect(isNonNullType(friendsType)).toBe(true)
      const innerType = (friendsType as any).ofType
      expect(innerType.ofType).toBe(personType) // Should reference the same Person type
    })

    it("should build schema with mutually recursive types using S.suspend", () => {
      // Define mutually recursive Post and Comment schemas
      interface Post {
        readonly id: string
        readonly title: string
        readonly comments: readonly Comment[]
      }
      interface Comment {
        readonly id: string
        readonly text: string
        readonly post: Post
      }

      const PostSchema: S.Schema<Post> = S.Struct({
        id: S.String,
        title: S.String,
        comments: S.Array(S.suspend(() => CommentSchema)),
      })

      const CommentSchema: S.Schema<Comment> = S.Struct({
        id: S.String,
        text: S.String,
        post: S.suspend(() => PostSchema),
      })

      const builder = GraphQLSchemaBuilder.empty
        .objectType({ name: "Post", schema: PostSchema })
        .objectType({ name: "Comment", schema: CommentSchema })
        .query("post", {
          type: PostSchema,
          resolve: () => Effect.succeed({ id: "1", title: "Hello", comments: [] }),
        })

      const schema = builder.buildSchema()

      // Verify both types exist
      const postType = schema.getType("Post") as GraphQLObjectType
      const commentType = schema.getType("Comment") as GraphQLObjectType
      expect(postType).toBeInstanceOf(GraphQLObjectType)
      expect(commentType).toBeInstanceOf(GraphQLObjectType)

      // Verify Post.comments references Comment
      const postFields = postType.getFields()
      const commentsField = postFields.comments
      const commentsListType = (commentsField.type as any).ofType // unwrap NonNull
      expect(commentsListType.ofType).toBe(commentType)

      // Verify Comment.post references Post
      const commentFields = commentType.getFields()
      const postField = commentFields.post
      const postFieldType = (postField.type as any).ofType // unwrap NonNull
      expect(postFieldType).toBe(postType)
    })

    it("should build schema with tree-like recursive structure", () => {
      // Define a recursive Category schema (tree structure)
      interface Category {
        readonly name: string
        readonly parent?: Category
        readonly children: readonly Category[]
      }
      const CategorySchema: S.Schema<Category> = S.Struct({
        name: S.String,
        parent: S.optional(S.suspend(() => CategorySchema)),
        children: S.Array(S.suspend(() => CategorySchema)),
      })

      const builder = GraphQLSchemaBuilder.empty
        .objectType({ name: "Category", schema: CategorySchema })
        .query("category", {
          type: CategorySchema,
          resolve: () => Effect.succeed({ name: "Root", children: [] }),
        })

      const schema = builder.buildSchema()

      const categoryType = schema.getType("Category") as GraphQLObjectType
      expect(categoryType).toBeInstanceOf(GraphQLObjectType)

      const fields = categoryType.getFields()
      expect(fields.name).toBeDefined()
      expect(fields.parent).toBeDefined()
      expect(fields.children).toBeDefined()

      // parent is optional, so not wrapped in NonNull
      expect(isNonNullType(fields.parent.type)).toBe(false)
      expect(fields.parent.type).toBe(categoryType)

      // children is required list
      expect(isNonNullType(fields.children.type)).toBe(true)

      // Verify the SDL is valid
      const sdl = printSchema(schema)
      expect(sdl).toContain("type Category")
      expect(sdl).toContain("parent: Category")
      // Note: Array elements are nullable by default (matches Effect Schema behavior)
      expect(sdl).toContain("children: [Category]!")
    })
  })
})
