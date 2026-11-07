import { describe, it, expect } from "vitest"
import { Effect, Layer, Option } from "effect"
import * as S from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import {
  GraphQLObjectType,
  GraphQLInterfaceType,
  GraphQLEnumType,
  GraphQLUnionType,
  GraphQLInputObjectType,
  GraphQLString,
  GraphQLInt,
  GraphQLSchema,
  graphql,
  getNamedType,
  isListType,
  isNonNullType,
} from "graphql"
import {
  getSchemaName,
  toGraphQLTypeWithRegistry,
  schemaToFields,
  schemaToInputFields,
  toGraphQLInputTypeWithRegistry,
  toGraphQLArgsWithRegistry,
  TypeConversionContext,
  buildInputTypeLookupCache,
} from "../../../src/builder/type-registry"
import { GraphQLSchemaBuilder } from "../../../src/builder/schema-builder"
import { execute } from "../../../src/builder/execute"

// Helper to create a minimal context
const createEmptyContext = (): TypeConversionContext => ({
  types: new Map(),
  interfaces: new Map(),
  enums: new Map(),
  unions: new Map(),
  inputs: new Map(),
  typeRegistry: new Map(),
  interfaceRegistry: new Map(),
  enumRegistry: new Map(),
  unionRegistry: new Map(),
  inputRegistry: new Map(),
})

describe("type-registry.ts", () => {
  // ==========================================================================
  // getSchemaName
  // ==========================================================================
  describe("getSchemaName", () => {
    it("should extract name from TaggedStruct", () => {
      const UserSchema = S.TaggedStruct("User", {
        id: S.String,
        name: S.String,
      })
      const name = getSchemaName(UserSchema)
      expect(name).toBe("User")
    })

    it("should extract name from TaggedStruct with different tag", () => {
      const PostSchema = S.TaggedStruct("Post", {
        title: S.String,
      })
      expect(getSchemaName(PostSchema)).toBe("Post")
    })

    it("should extract name from Schema.Class", () => {
      class User extends S.Class<User>("User")({
        id: S.String,
      }) {}
      expect(getSchemaName(User)).toBe("User")
    })

    it("should return undefined for plain Struct", () => {
      const PlainSchema = S.Struct({
        id: S.String,
      })
      expect(getSchemaName(PlainSchema)).toBeUndefined()
    })

    it("should return undefined for primitives", () => {
      expect(getSchemaName(S.String)).toBeUndefined()
      expect(getSchemaName(S.Number)).toBeUndefined()
      expect(getSchemaName(S.Boolean)).toBeUndefined()
    })

    it("should return undefined for arrays", () => {
      expect(getSchemaName(S.Array(S.String))).toBeUndefined()
    })

    it("should handle struct with _tag that is not a literal", () => {
      // Edge case: _tag field exists but is not a literal
      const Schema = S.Struct({
        _tag: S.String, // Not a literal
        id: S.String,
      })
      expect(getSchemaName(Schema)).toBeUndefined()
    })
  })

  // ==========================================================================
  // toGraphQLTypeWithRegistry - Basic
  // ==========================================================================
  describe("toGraphQLTypeWithRegistry - Basic", () => {
    it("should fall back to toGraphQLType for primitives", () => {
      const ctx = createEmptyContext()

      expect(toGraphQLTypeWithRegistry(S.String, ctx)).toBe(GraphQLString)
      expect(toGraphQLTypeWithRegistry(S.Int, ctx)).toBe(GraphQLInt)
    })

    it("should find registered object type", () => {
      const UserSchema = S.Struct({ id: S.String, name: S.String })
      const userType = new GraphQLObjectType({
        name: "User",
        fields: { id: { type: GraphQLString }, name: { type: GraphQLString } },
      })

      const ctx = createEmptyContext()
      ctx.types.set("User", { name: "User", schema: UserSchema })
      ctx.typeRegistry.set("User", userType)

      const result = toGraphQLTypeWithRegistry(UserSchema, ctx)
      expect(result).toBe(userType)
    })

    it("should find registered interface", () => {
      const NodeSchema = S.Struct({ id: S.String })
      const nodeInterface = new GraphQLInterfaceType({
        name: "Node",
        fields: { id: { type: GraphQLString } },
      })

      const ctx = createEmptyContext()
      ctx.interfaces.set("Node", { name: "Node", schema: NodeSchema, resolveType: () => "Node" })
      ctx.interfaceRegistry.set("Node", nodeInterface)

      const result = toGraphQLTypeWithRegistry(NodeSchema, ctx)
      expect(result).toBe(nodeInterface)
    })
  })

  // ==========================================================================
  // toGraphQLTypeWithRegistry - Arrays
  // ==========================================================================
  describe("toGraphQLTypeWithRegistry - Arrays", () => {
    it("should handle S.Array with registry lookup for elements", () => {
      const ctx = createEmptyContext()

      const result = toGraphQLTypeWithRegistry(S.Array(S.String), ctx)
      expect(isListType(result)).toBe(true)
      expect((result as any).ofType).toBe(GraphQLString)
    })

    it("should handle S.Array of registered types", () => {
      const UserSchema = S.Struct({ id: S.String })
      const userType = new GraphQLObjectType({
        name: "User",
        fields: { id: { type: GraphQLString } },
      })

      const ctx = createEmptyContext()
      ctx.types.set("User", { name: "User", schema: UserSchema })
      ctx.typeRegistry.set("User", userType)

      const result = toGraphQLTypeWithRegistry(S.Array(UserSchema), ctx)
      expect(isListType(result)).toBe(true)
      expect((result as any).ofType).toBe(userType)
    })

    it("should handle S.Tuple with elements", () => {
      const ctx = createEmptyContext()
      const result = toGraphQLTypeWithRegistry(S.Tuple([S.String]), ctx)
      expect(isListType(result)).toBe(true)
    })
  })

  // ==========================================================================
  // toGraphQLTypeWithRegistry - Enums
  // ==========================================================================
  describe("toGraphQLTypeWithRegistry - Enums", () => {
    it("should find registered enum for literal union", () => {
      const StatusEnum = new GraphQLEnumType({
        name: "Status",
        values: {
          ACTIVE: { value: "ACTIVE" },
          INACTIVE: { value: "INACTIVE" },
        },
      })

      const ctx = createEmptyContext()
      ctx.enums.set("Status", {
        name: "Status",
        values: ["ACTIVE", "INACTIVE"],
      })
      ctx.enumRegistry.set("Status", StatusEnum)

      const StatusSchema = S.Literals(["ACTIVE", "INACTIVE"])
      const result = toGraphQLTypeWithRegistry(StatusSchema, ctx)
      expect(result).toBe(StatusEnum)
    })

    it("should find registered enum for single literal", () => {
      const StatusEnum = new GraphQLEnumType({
        name: "Status",
        values: {
          ACTIVE: { value: "ACTIVE" },
          INACTIVE: { value: "INACTIVE" },
        },
      })

      const ctx = createEmptyContext()
      ctx.enums.set("Status", {
        name: "Status",
        values: ["ACTIVE", "INACTIVE"],
      })
      ctx.enumRegistry.set("Status", StatusEnum)

      const result = toGraphQLTypeWithRegistry(S.Literal("ACTIVE"), ctx)
      expect(result).toBe(StatusEnum)
    })

    it("should fall back to string for unregistered literal", () => {
      const ctx = createEmptyContext()
      const result = toGraphQLTypeWithRegistry(S.Literal("UNKNOWN"), ctx)
      expect(result).toBe(GraphQLString)
    })
  })

  // ==========================================================================
  // toGraphQLTypeWithRegistry - Unions
  // ==========================================================================
  describe("toGraphQLTypeWithRegistry - Unions", () => {
    it("should find registered union type", () => {
      const TextSchema = S.TaggedStruct("Text", { body: S.String })
      const ImageSchema = S.TaggedStruct("Image", { url: S.String })

      const textType = new GraphQLObjectType({
        name: "Text",
        fields: { body: { type: GraphQLString } },
      })
      const imageType = new GraphQLObjectType({
        name: "Image",
        fields: { url: { type: GraphQLString } },
      })
      const contentUnion = new GraphQLUnionType({
        name: "Content",
        types: [textType, imageType],
      })

      const ctx = createEmptyContext()
      ctx.types.set("Text", { name: "Text", schema: TextSchema })
      ctx.types.set("Image", { name: "Image", schema: ImageSchema })
      ctx.typeRegistry.set("Text", textType)
      ctx.typeRegistry.set("Image", imageType)
      ctx.unions.set("Content", {
        name: "Content",
        types: ["Text", "Image"],
        resolveType: () => "Content",
      })
      ctx.unionRegistry.set("Content", contentUnion)

      // Create a union schema - this is the S.Union of the tagged structs
      // Note: In practice this happens via schema AST matching
      const UnionSchema = S.Union([
        S.Struct({ _tag: S.Literal("Text"), body: S.String }),
        S.Struct({ _tag: S.Literal("Image"), url: S.String }),
      ])

      const result = toGraphQLTypeWithRegistry(UnionSchema, ctx)
      expect(result).toBe(contentUnion)
    })
  })

  // ==========================================================================
  // schemaToFields
  // ==========================================================================
  describe("schemaToFields", () => {
    it("should convert struct schemas to fields", () => {
      const ctx = createEmptyContext()
      const UserSchema = S.Struct({
        id: S.String,
        name: S.String,
        age: S.Int,
      })

      const fields = schemaToFields(UserSchema, ctx)

      expect(fields.id).toBeDefined()
      expect(fields.name).toBeDefined()
      expect(fields.age).toBeDefined()
    })

    it("should wrap non-optional fields in NonNull", () => {
      const ctx = createEmptyContext()
      const UserSchema = S.Struct({
        id: S.String,
      })

      const fields = schemaToFields(UserSchema, ctx)
      expect(isNonNullType(fields.id.type)).toBe(true)
    })

    it("should not wrap optional fields in NonNull", () => {
      const ctx = createEmptyContext()
      const UserSchema = S.Struct({
        bio: S.optional(S.String),
      })

      const fields = schemaToFields(UserSchema, ctx)
      expect(isNonNullType(fields.bio.type)).toBe(false)
    })

    it("should handle TaggedStruct", () => {
      const ctx = createEmptyContext()
      const UserSchema = S.TaggedStruct("User", {
        id: S.String,
        name: S.String,
      })

      const fields = schemaToFields(UserSchema, ctx)
      expect(fields.id).toBeDefined()
      expect(fields.name).toBeDefined()
      // _tag is filtered out as it's an internal discriminator not needed in GraphQL
      expect(fields._tag).toBeUndefined()
    })

    it("should handle Schema.Class", () => {
      const ctx = createEmptyContext()
      class User extends S.Class<User>("User")({
        id: S.String,
        name: S.String,
      }) {}

      const fields = schemaToFields(User, ctx)
      expect(fields.id).toBeDefined()
      expect(fields.name).toBeDefined()
    })

    it("should handle Schema.Class with OptionFromNullOr fields as nullable", () => {
      const ctx = createEmptyContext()
      class User extends S.Class<User>("User")({
        id: S.String,
        name: S.String,
        age: S.OptionFromNullOr(S.Int),
        email: S.OptionFromNullOr(S.String),
      }) {}

      const fields = schemaToFields(User, ctx)
      expect(fields.id).toBeDefined()
      expect(fields.name).toBeDefined()
      expect(fields.age).toBeDefined()
      expect(fields.email).toBeDefined()

      // Required fields should be NonNull
      expect(isNonNullType(fields.id.type)).toBe(true)
      expect(isNonNullType(fields.name.type)).toBe(true)

      // OptionFromNullOr fields should be nullable (not wrapped in NonNull)
      expect(isNonNullType(fields.age.type)).toBe(false)
      expect(isNonNullType(fields.email.type)).toBe(false)
    })

    it("should return empty object for a non-object schema", () => {
      const ctx = createEmptyContext()
      const fields = schemaToFields(S.String, ctx)
      expect(Object.keys(fields)).toHaveLength(0)
    })

    it("should use registry for field types", () => {
      const AddressSchema = S.Struct({ city: S.String })
      const addressType = new GraphQLObjectType({
        name: "Address",
        fields: { city: { type: GraphQLString } },
      })

      const ctx = createEmptyContext()
      ctx.types.set("Address", { name: "Address", schema: AddressSchema })
      ctx.typeRegistry.set("Address", addressType)

      const UserSchema = S.Struct({
        name: S.String,
        address: AddressSchema,
      })

      const fields = schemaToFields(UserSchema, ctx)
      const addressFieldType = isNonNullType(fields.address.type)
        ? (fields.address.type as any).ofType
        : fields.address.type

      expect(addressFieldType).toBe(addressType)
    })
  })

  // ==========================================================================
  // schemaToInputFields
  // ==========================================================================
  describe("schemaToInputFields", () => {
    it("should convert struct schemas to input fields", () => {
      const InputSchema = S.Struct({
        name: S.String,
        email: S.String,
      })

      const fields = schemaToInputFields(InputSchema, new Map(), new Map(), new Map(), new Map())

      expect(fields.name).toBeDefined()
      expect(fields.email).toBeDefined()
    })

    it("should wrap required fields in NonNull", () => {
      const InputSchema = S.Struct({ name: S.String })

      const fields = schemaToInputFields(InputSchema, new Map(), new Map(), new Map(), new Map())

      expect(isNonNullType(fields.name.type)).toBe(true)
    })

    it("should not wrap optional fields in NonNull", () => {
      const InputSchema = S.Struct({ name: S.optional(S.String) })

      const fields = schemaToInputFields(InputSchema, new Map(), new Map(), new Map(), new Map())

      expect(isNonNullType(fields.name.type)).toBe(false)
    })

    it("should handle OptionFromNullOr fields in input types as nullable", () => {
      const InputSchema = S.Struct({
        name: S.String,
        age: S.OptionFromNullOr(S.Int),
        email: S.OptionFromNullOr(S.String),
      })

      const fields = schemaToInputFields(InputSchema, new Map(), new Map(), new Map(), new Map())

      expect(fields.name).toBeDefined()
      expect(fields.age).toBeDefined()
      expect(fields.email).toBeDefined()

      // Required field should be NonNull
      expect(isNonNullType(fields.name.type)).toBe(true)

      // OptionFromNullOr fields should be nullable (not wrapped in NonNull)
      expect(isNonNullType(fields.age.type)).toBe(false)
      expect(isNonNullType(fields.email.type)).toBe(false)
    })

    it("should return empty object for a non-object schema", () => {
      const fields = schemaToInputFields(S.String, new Map(), new Map(), new Map(), new Map())
      expect(Object.keys(fields)).toHaveLength(0)
    })

    it("should use input registry for nested types", () => {
      const AddressInput = S.Struct({ city: S.String })
      const addressInputType = new GraphQLInputObjectType({
        name: "AddressInput",
        fields: { city: { type: GraphQLString } },
      })

      const inputRegistry = new Map<string, GraphQLInputObjectType>()
      inputRegistry.set("AddressInput", addressInputType)

      const inputs = new Map()
      inputs.set("AddressInput", { name: "AddressInput", schema: AddressInput })

      const UserInput = S.Struct({
        name: S.String,
        address: AddressInput,
      })

      const fields = schemaToInputFields(UserInput, new Map(), inputRegistry, inputs, new Map())

      const addressFieldType = isNonNullType(fields.address.type)
        ? (fields.address.type as any).ofType
        : fields.address.type

      expect(addressFieldType).toBe(addressInputType)
    })
  })

  // ==========================================================================
  // toGraphQLInputTypeWithRegistry
  // ==========================================================================
  describe("toGraphQLInputTypeWithRegistry", () => {
    it("should find registered input type", () => {
      const InputSchema = S.Struct({ name: S.String })
      const inputType = new GraphQLInputObjectType({
        name: "UserInput",
        fields: { name: { type: GraphQLString } },
      })

      const inputRegistry = new Map<string, GraphQLInputObjectType>()
      inputRegistry.set("UserInput", inputType)

      const inputs = new Map()
      inputs.set("UserInput", { name: "UserInput", schema: InputSchema })

      const result = toGraphQLInputTypeWithRegistry(
        InputSchema,
        new Map(),
        inputRegistry,
        inputs,
        new Map()
      )

      expect(result).toBe(inputType)
    })

    it.each(["AInput", "CustomInput"])(
      "reuses the registered first union member as %s",
      async (name) => {
        const A = S.TaggedStruct("A", { id: S.String })
        const B = S.TaggedStruct("B", { name: S.String })
        const schema = GraphQLSchemaBuilder.empty
          .inputType({ name, schema: A })
          .query("echo", {
            type: S.String,
            args: S.Struct({ direct: A, input: S.Union([A, B]) }),
            resolve: ({ direct, input }) =>
              Effect.succeed(
                `${direct._tag}:${direct.id}:${input._tag}:${input._tag === "A" ? input.id : input.name}`
              ),
          })
          .buildSchema()
        const args = schema.getQueryType()!.getFields().echo.args

        expect(getNamedType(args[0].type)).toBe(schema.getType(name))
        expect(getNamedType(args[1].type)).toBe(schema.getType(name))

        const result = await Effect.runPromise(
          execute(schema, Layer.empty)(
            `query($direct: ${name}!, $input: ${name}!) { echo(direct: $direct, input: $input) }`,
            { direct: { id: "direct" }, input: { id: "union" } }
          )
        )

        expect(result.errors).toBeUndefined()
        expect(result.data).toEqual({ echo: "A:direct:A:union" })
      }
    )

    it("should find registered enum for literal union", () => {
      const StatusEnum = new GraphQLEnumType({
        name: "Status",
        values: {
          ACTIVE: { value: "ACTIVE" },
          INACTIVE: { value: "INACTIVE" },
        },
      })

      const enumRegistry = new Map<string, GraphQLEnumType>()
      enumRegistry.set("Status", StatusEnum)

      const enums = new Map()
      enums.set("Status", { name: "Status", values: ["ACTIVE", "INACTIVE"] })

      const StatusSchema = S.Literals(["ACTIVE", "INACTIVE"])
      const result = toGraphQLInputTypeWithRegistry(
        StatusSchema,
        enumRegistry,
        new Map(),
        new Map(),
        enums
      )

      expect(result).toBe(StatusEnum)
    })

    it("decodes unmatched literal unions without narrowing them to an overlapping enum", async () => {
      const status = S.Literals(["ACTIVE", "PENDING"]).pipe(
        S.decodeTo(S.String, {
          decode: SchemaGetter.transform((value) => value.toLowerCase()),
          encode: SchemaGetter.transform((value) => value.toUpperCase() as "ACTIVE" | "PENDING"),
        })
      )
      const received: string[] = []
      const schema = GraphQLSchemaBuilder.empty
        .enumType({ name: "Status", values: ["ACTIVE", "INACTIVE"] })
        .query("echo", {
          type: S.String,
          args: S.Struct({
            status,
            exact: S.Literals(["ACTIVE", "INACTIVE"]),
          }),
          resolve: ({ status, exact }) =>
            Effect.sync(() => {
              received.push(status)
              return `${status}:${exact}`
            }),
        })
        .buildSchema()
      const run = execute(schema, Layer.empty)
      const source =
        "query($status: String!, $exact: Status!) { echo(status: $status, exact: $exact) }"

      const accepted = await Effect.runPromise(
        run(source, { status: "PENDING", exact: "INACTIVE" })
      )
      expect(accepted.errors).toBeUndefined()
      expect(accepted.data).toEqual({ echo: "pending:INACTIVE" })
      expect(received).toEqual(["pending"])

      const rejected = await Effect.runPromise(run(source, { status: "INACTIVE", exact: "ACTIVE" }))
      expect(rejected.data).toEqual({ echo: null })
      expect(rejected.errors?.[0].path).toEqual(["echo"])
      expect(received).toEqual(["pending"])
    })

    it("keeps mixed-member union fallback scalar after a failed enum match", async () => {
      const received: Array<string | number> = []
      const schema = GraphQLSchemaBuilder.empty
        .enumType({ name: "Status", values: ["ACTIVE", "INACTIVE"] })
        .query("echo", {
          type: S.String,
          args: S.Struct({ status: S.Union([S.Literal("ACTIVE"), S.Number]) }),
          resolve: ({ status }) =>
            Effect.sync(() => {
              received.push(status)
              return String(status)
            }),
        })
        .buildSchema()
      const run = execute(schema, Layer.empty)
      const source = "query($status: String!) { echo(status: $status) }"
      const accepted = await Effect.runPromise(run(source, { status: "ACTIVE" }))
      expect(accepted.errors).toBeUndefined()
      expect(accepted.data).toEqual({ echo: "ACTIVE" })
      const rejected = await Effect.runPromise(run(source, { status: "INACTIVE" }))
      expect(rejected.data).toEqual({ echo: null })
      expect(rejected.errors?.[0].path).toEqual(["echo"])
      expect(received).toEqual(["ACTIVE"])
    })

    it("should handle S.optional wrapping", () => {
      const InputSchema = S.Struct({ name: S.String })
      const inputType = new GraphQLInputObjectType({
        name: "UserInput",
        fields: { name: { type: GraphQLString } },
      })

      const inputRegistry = new Map<string, GraphQLInputObjectType>()
      inputRegistry.set("UserInput", inputType)

      const inputs = new Map()
      inputs.set("UserInput", { name: "UserInput", schema: InputSchema })

      // Test the inner type extraction
      const result = toGraphQLInputTypeWithRegistry(
        InputSchema,
        new Map(),
        inputRegistry,
        inputs,
        new Map()
      )
      expect(result).toBe(inputType)
    })

    it("should fall back to toGraphQLInputType for unknown types", () => {
      const result = toGraphQLInputTypeWithRegistry(
        S.String,
        new Map(),
        new Map(),
        new Map(),
        new Map()
      )
      expect(result).toBe(GraphQLString)
    })

    it("should handle single literal matching enum", () => {
      const StatusEnum = new GraphQLEnumType({
        name: "Status",
        values: { ACTIVE: { value: "ACTIVE" } },
      })

      const enumRegistry = new Map<string, GraphQLEnumType>()
      enumRegistry.set("Status", StatusEnum)

      const enums = new Map()
      enums.set("Status", { name: "Status", values: ["ACTIVE"] })

      const result = toGraphQLInputTypeWithRegistry(
        S.Literal("ACTIVE"),
        enumRegistry,
        new Map(),
        new Map(),
        enums
      )

      expect(result).toBe(StatusEnum)
    })
  })

  // ==========================================================================
  // toGraphQLArgsWithRegistry
  // ==========================================================================
  describe("toGraphQLArgsWithRegistry", () => {
    it("should convert struct to args", () => {
      const ArgsSchema = S.Struct({
        id: S.String,
        limit: S.Int,
      })

      const args = toGraphQLArgsWithRegistry(ArgsSchema, new Map(), new Map(), new Map(), new Map())

      expect(args.id).toBeDefined()
      expect(args.limit).toBeDefined()
    })

    it("should wrap required args in NonNull", () => {
      const ArgsSchema = S.Struct({ id: S.String })

      const args = toGraphQLArgsWithRegistry(ArgsSchema, new Map(), new Map(), new Map(), new Map())

      expect(isNonNullType(args.id.type)).toBe(true)
    })

    it("should not wrap optional args in NonNull", () => {
      const ArgsSchema = S.Struct({ limit: S.optional(S.Int) })

      const args = toGraphQLArgsWithRegistry(ArgsSchema, new Map(), new Map(), new Map(), new Map())

      expect(isNonNullType(args.limit.type)).toBe(false)
    })

    it("should handle OptionFromNullOr fields in query arguments as nullable", () => {
      const ArgsSchema = S.Struct({
        limit: S.Int.check(S.isGreaterThanOrEqualTo(0)),
        cursor: S.OptionFromNullOr(S.String),
        offset: S.OptionFromNullOr(S.Int),
      })

      const args = toGraphQLArgsWithRegistry(ArgsSchema, new Map(), new Map(), new Map(), new Map())

      expect(args.limit).toBeDefined()
      expect(args.cursor).toBeDefined()
      expect(args.offset).toBeDefined()

      // Required field should be NonNull
      expect(isNonNullType(args.limit.type)).toBe(true)

      // OptionFromNullOr fields should be nullable (not wrapped in NonNull)
      expect(isNonNullType(args.cursor.type)).toBe(false)
      expect(isNonNullType(args.offset.type)).toBe(false)
    })

    it("should use enum registry for enum args", () => {
      const StatusEnum = new GraphQLEnumType({
        name: "Status",
        values: {
          ACTIVE: { value: "ACTIVE" },
          INACTIVE: { value: "INACTIVE" },
        },
      })

      const enumRegistry = new Map<string, GraphQLEnumType>()
      enumRegistry.set("Status", StatusEnum)

      const enums = new Map()
      enums.set("Status", { name: "Status", values: ["ACTIVE", "INACTIVE"] })

      const ArgsSchema = S.Struct({
        status: S.Literals(["ACTIVE", "INACTIVE"]),
      })

      const args = toGraphQLArgsWithRegistry(ArgsSchema, enumRegistry, new Map(), new Map(), enums)

      const statusType = isNonNullType(args.status.type)
        ? (args.status.type as any).ofType
        : args.status.type

      expect(statusType).toBe(StatusEnum)
    })

    it("should use input registry for input type args", () => {
      const FilterSchema = S.Struct({ name: S.optional(S.String) })
      const filterInputType = new GraphQLInputObjectType({
        name: "FilterInput",
        fields: { name: { type: GraphQLString } },
      })

      const inputRegistry = new Map<string, GraphQLInputObjectType>()
      inputRegistry.set("FilterInput", filterInputType)

      const inputs = new Map()
      inputs.set("FilterInput", { name: "FilterInput", schema: FilterSchema })

      const ArgsSchema = S.Struct({
        filter: FilterSchema,
      })

      const args = toGraphQLArgsWithRegistry(
        ArgsSchema,
        new Map(),
        inputRegistry,
        inputs,
        new Map()
      )

      const filterType = isNonNullType(args.filter.type)
        ? (args.filter.type as any).ofType
        : args.filter.type

      expect(filterType).toBe(filterInputType)
    })

    it("should fall back to toGraphQLArgs for non-struct", () => {
      // This should throw or return empty based on toGraphQLArgs behavior
      expect(() => {
        toGraphQLArgsWithRegistry(S.String, new Map(), new Map(), new Map(), new Map())
      }).toThrow()
    })
  })

  // ==========================================================================
  // toGraphQLTypeWithRegistry - Suspend (recursive types)
  // ==========================================================================
  describe("toGraphQLTypeWithRegistry - Suspend", () => {
    it("should handle S.suspend for self-referential types", () => {
      // Define a self-referential Person schema
      interface Person {
        readonly name: string
        readonly friends: readonly Person[]
      }
      const PersonSchema: S.Schema<Person> = S.Struct({
        name: S.String,
        friends: S.Array(S.suspend(() => PersonSchema)),
      })

      const personType: GraphQLObjectType = new GraphQLObjectType({
        name: "Person",
        fields: () => ({
          name: { type: GraphQLString },
          friends: { type: personType },
        }),
      })

      const ctx = createEmptyContext()
      ctx.types.set("Person", { name: "Person", schema: PersonSchema })
      ctx.typeRegistry.set("Person", personType)

      // Test that suspend resolves to the registered type
      const result = toGraphQLTypeWithRegistry(S.Array(S.suspend(() => PersonSchema)), ctx)
      expect(isListType(result)).toBe(true)
      expect((result as any).ofType).toBe(personType)
    })

    it("should handle S.suspend that resolves to a primitive", () => {
      const ctx = createEmptyContext()

      const LazyString = S.suspend(() => S.String)
      const result = toGraphQLTypeWithRegistry(LazyString, ctx)
      expect(result).toBe(GraphQLString)
    })

    it("should handle nested suspend in arrays", () => {
      const ItemSchema = S.Struct({ id: S.String })
      const itemType = new GraphQLObjectType({
        name: "Item",
        fields: { id: { type: GraphQLString } },
      })

      const ctx = createEmptyContext()
      ctx.types.set("Item", { name: "Item", schema: ItemSchema })
      ctx.typeRegistry.set("Item", itemType)

      // Array of suspended items
      const result = toGraphQLTypeWithRegistry(S.Array(S.suspend(() => ItemSchema)), ctx)

      expect(isListType(result)).toBe(true)
      expect((result as any).ofType).toBe(itemType)
    })
  })

  // ==========================================================================
  // toGraphQLInputTypeWithRegistry - Suspend (recursive types)
  // ==========================================================================
  describe("toGraphQLInputTypeWithRegistry - Suspend", () => {
    it("should handle S.suspend for self-referential input types", () => {
      interface NestedInput {
        readonly value: string
        readonly children?: readonly NestedInput[]
      }
      const NestedInputSchema: S.Schema<NestedInput> = S.Struct({
        value: S.String,
        children: S.optional(S.Array(S.suspend(() => NestedInputSchema))),
      })

      const nestedInputType: GraphQLInputObjectType = new GraphQLInputObjectType({
        name: "NestedInput",
        fields: () => ({
          value: { type: GraphQLString },
          children: { type: nestedInputType },
        }),
      })

      const inputRegistry = new Map<string, GraphQLInputObjectType>()
      inputRegistry.set("NestedInput", nestedInputType)

      const inputs = new Map()
      inputs.set("NestedInput", { name: "NestedInput", schema: NestedInputSchema })

      // Test that suspend resolves to the registered input type
      const result = toGraphQLInputTypeWithRegistry(
        S.suspend(() => NestedInputSchema),
        new Map(),
        inputRegistry,
        inputs,
        new Map()
      )
      expect(result).toBe(nestedInputType)
    })

    it("should handle S.suspend that resolves to a primitive for input", () => {
      const LazyString = S.suspend(() => S.String)
      const result = toGraphQLInputTypeWithRegistry(
        LazyString,
        new Map(),
        new Map(),
        new Map(),
        new Map()
      )
      expect(result).toBe(GraphQLString)
    })
  })

  // ==========================================================================
  // Complex scenarios
  // ==========================================================================
  describe("Complex scenarios", () => {
    it("should handle nested registered types with arrays", () => {
      const PostSchema = S.Struct({ id: S.String, title: S.String })
      const UserSchema = S.Struct({
        id: S.String,
        posts: S.Array(PostSchema),
      })

      const postType = new GraphQLObjectType({
        name: "Post",
        fields: { id: { type: GraphQLString }, title: { type: GraphQLString } },
      })

      const ctx = createEmptyContext()
      ctx.types.set("Post", { name: "Post", schema: PostSchema })
      ctx.typeRegistry.set("Post", postType)

      const fields = schemaToFields(UserSchema, ctx)

      const postsType = isNonNullType(fields.posts.type)
        ? (fields.posts.type as any).ofType
        : fields.posts.type

      expect(isListType(postsType)).toBe(true)
      expect((postsType as any).ofType).toBe(postType)
    })

    it("should handle mixed enum and object type args", () => {
      const StatusEnum = new GraphQLEnumType({
        name: "Status",
        values: { ACTIVE: { value: "ACTIVE" } },
      })
      const FilterInput = S.Struct({ name: S.optional(S.String) })
      const filterInputType = new GraphQLInputObjectType({
        name: "FilterInput",
        fields: { name: { type: GraphQLString } },
      })

      const enumRegistry = new Map<string, GraphQLEnumType>()
      enumRegistry.set("Status", StatusEnum)

      const inputRegistry = new Map<string, GraphQLInputObjectType>()
      inputRegistry.set("FilterInput", filterInputType)

      const inputs = new Map()
      inputs.set("FilterInput", { name: "FilterInput", schema: FilterInput })

      const enums = new Map()
      enums.set("Status", { name: "Status", values: ["ACTIVE"] })

      const ArgsSchema = S.Struct({
        status: S.Literal("ACTIVE"),
        filter: FilterInput,
      })

      const args = toGraphQLArgsWithRegistry(ArgsSchema, enumRegistry, inputRegistry, inputs, enums)

      const statusType = isNonNullType(args.status.type)
        ? (args.status.type as any).ofType
        : args.status.type
      const filterType = isNonNullType(args.filter.type)
        ? (args.filter.type as any).ofType
        : args.filter.type

      expect(statusType).toBe(StatusEnum)
      expect(filterType).toBe(filterInputType)
    })
  })

  // ==========================================================================
  // Class schemas with declaration-backed fields
  // ==========================================================================
  describe("Class schemas with declaration-backed fields", () => {
    it("should handle S.Class with Date fields", () => {
      class Event extends S.Class<Event>("Event")({
        id: S.String,
        createdAt: S.Date,
      }) {}

      const ctx = createEmptyContext()
      const fields = schemaToFields(Event, ctx)

      expect(fields.id).toBeDefined()
      expect(fields.createdAt).toBeDefined()
      expect(Object.keys(fields)).toHaveLength(2)
    })

    it("should handle S.Class with multiple transformation fields", () => {
      class Record extends S.Class<Record>("Record")({
        id: S.String,
        created: S.Date,
        updated: S.Date,
        value: S.Number,
      }) {}

      const ctx = createEmptyContext()
      const fields = schemaToFields(Record, ctx)

      expect(fields.id).toBeDefined()
      expect(fields.created).toBeDefined()
      expect(fields.updated).toBeDefined()
      expect(fields.value).toBeDefined()
    })

    it("should handle schemaToInputFields with TaggedStruct", () => {
      const InputData = S.TaggedStruct("InputData", {
        name: S.String,
        value: S.Number,
      })

      const fields = schemaToInputFields(InputData, new Map(), new Map(), new Map(), new Map())

      expect(fields.name).toBeDefined()
      expect(fields.value).toBeDefined()
      // _tag should be filtered out
      expect(fields._tag).toBeUndefined()
    })
  })

  // ==========================================================================
  // Bug fixes - Registry lookup order for input types
  // ==========================================================================
  describe("Bug fixes - Registry lookup order", () => {
    it("should find registered input type before handling transformations", () => {
      // Bug 2: Registry lookup should happen BEFORE transformation handling
      class CursorInput extends S.Class<CursorInput>("CursorInput")({
        value: S.String,
      }) {}

      const cursorInputType = new GraphQLInputObjectType({
        name: "CursorInput",
        fields: { value: { type: GraphQLString } },
      })

      const inputRegistry = new Map<string, GraphQLInputObjectType>()
      inputRegistry.set("CursorInput", cursorInputType)

      const inputs = new Map()
      inputs.set("CursorInput", { name: "CursorInput", schema: CursorInput })

      const result = toGraphQLInputTypeWithRegistry(
        CursorInput,
        new Map(),
        inputRegistry,
        inputs,
        new Map()
      )

      expect(result).toBe(cursorInputType)
    })

    it("should find registered input type when wrapped in optional", () => {
      const InnerInput = S.Struct({ value: S.String })
      const innerInputType = new GraphQLInputObjectType({
        name: "InnerInput",
        fields: { value: { type: GraphQLString } },
      })

      const inputRegistry = new Map<string, GraphQLInputObjectType>()
      inputRegistry.set("InnerInput", innerInputType)

      const inputs = new Map()
      inputs.set("InnerInput", { name: "InnerInput", schema: InnerInput })

      // When used as an optional field, should still resolve to registered type
      const WrapperSchema = S.Struct({
        inner: S.optional(InnerInput),
      })

      const fields = schemaToInputFields(WrapperSchema, new Map(), inputRegistry, inputs, new Map())
      expect(fields.inner.type).toBe(innerInputType)
    })
  })

  // ==========================================================================
  // Bug fixes - S.Option and Union member traversal
  // ==========================================================================
  describe("Bug fixes - S.Option and Union handling", () => {
    it("should find registered type inside S.Option Union (from position)", () => {
      const ActorSchema = S.Struct({ id: S.String, name: S.String })
      const actorType = new GraphQLObjectType({
        name: "Actor",
        fields: { id: { type: GraphQLString }, name: { type: GraphQLString } },
      })

      const ctx = createEmptyContext()
      ctx.types.set("Actor", { name: "Actor", schema: ActorSchema })
      ctx.typeRegistry.set("Actor", actorType)

      // Create an optional actor schema
      const OptionalActorSchema = S.OptionFromNullOr(ActorSchema)

      const result = toGraphQLTypeWithRegistry(OptionalActorSchema, ctx)
      expect(result).toBe(actorType)
    })

    it("should find registered input type inside S.Option Union", () => {
      const CursorSchema = S.Struct({ value: S.String })
      const cursorInputType = new GraphQLInputObjectType({
        name: "CursorInput",
        fields: { value: { type: GraphQLString } },
      })

      const inputRegistry = new Map<string, GraphQLInputObjectType>()
      inputRegistry.set("CursorInput", cursorInputType)

      const inputs = new Map()
      inputs.set("CursorInput", { name: "CursorInput", schema: CursorSchema })

      // Build cache with unwrapped AST forms
      const cache = buildInputTypeLookupCache(inputs, new Map())

      const OptionalCursorSchema = S.OptionFromNullOr(CursorSchema)

      const result = toGraphQLInputTypeWithRegistry(
        OptionalCursorSchema,
        new Map(),
        inputRegistry,
        inputs,
        new Map(),
        cache
      )

      expect(result).toBe(cursorInputType)
    })

    it("should find registered type inside Option.Some value field", () => {
      // S.Option creates: Union[Option.None, Option.Some{ value: X }]
      const ItemSchema = S.Struct({ id: S.String })
      const itemType = new GraphQLObjectType({
        name: "Item",
        fields: { id: { type: GraphQLString } },
      })

      const ctx = createEmptyContext()
      ctx.types.set("Item", { name: "Item", schema: ItemSchema })
      ctx.typeRegistry.set("Item", itemType)

      // S.Option wraps the type in Option.Some's value field
      const OptionalItemSchema = S.Option(ItemSchema)

      const result = toGraphQLTypeWithRegistry(OptionalItemSchema, ctx)
      expect(result).toBe(itemType)
    })

    it("should find registered input inside Option.Some value field", () => {
      const FilterSchema = S.Struct({ term: S.String })
      const filterInputType = new GraphQLInputObjectType({
        name: "FilterInput",
        fields: { term: { type: GraphQLString } },
      })

      const inputRegistry = new Map<string, GraphQLInputObjectType>()
      inputRegistry.set("FilterInput", filterInputType)

      const inputs = new Map()
      inputs.set("FilterInput", { name: "FilterInput", schema: FilterSchema })

      const cache = buildInputTypeLookupCache(inputs, new Map())

      const OptionalFilterSchema = S.Option(FilterSchema)

      const result = toGraphQLInputTypeWithRegistry(
        OptionalFilterSchema,
        new Map(),
        inputRegistry,
        inputs,
        new Map(),
        cache
      )

      expect(result).toBe(filterInputType)
    })
  })

  // ==========================================================================
  // Bug fixes - Lookup cache with unwrapped AST forms
  // ==========================================================================
  describe("Bug fixes - Lookup cache unwrapped AST forms", () => {
    it("should find registered type via unwrapped AST lookup", () => {
      class UserType extends S.Class<UserType>("UserType")({
        id: S.String,
        name: S.String,
      }) {}

      const userGraphQLType = new GraphQLObjectType({
        name: "UserType",
        fields: { id: { type: GraphQLString }, name: { type: GraphQLString } },
      })

      const ctx = createEmptyContext()
      ctx.types.set("UserType", { name: "UserType", schema: UserType })
      ctx.typeRegistry.set("UserType", userGraphQLType)

      // The schema is a transformation, lookup should work via unwrapped AST
      const result = toGraphQLTypeWithRegistry(UserType, ctx)
      expect(result).toBe(userGraphQLType)
    })
  })

  // ==========================================================================
  // Registered Option schemas in arguments
  // ==========================================================================
  describe("Registered Option schemas in arguments", () => {
    it("should find registered input when using S.Option(Schema.Class) in args - with cache", () => {
      // Simulates: S.Option(CursorFromHex) where CursorFromHex is a Schema.Class
      class CursorFromHex extends S.Class<CursorFromHex>("CursorFromHex")({
        value: S.String,
      }) {}

      const cursorInputType = new GraphQLInputObjectType({
        name: "CursorInput",
        fields: { value: { type: GraphQLString } },
      })

      const inputRegistry = new Map<string, GraphQLInputObjectType>()
      inputRegistry.set("CursorInput", cursorInputType)

      const inputs = new Map()
      inputs.set("CursorInput", { name: "CursorInput", schema: CursorFromHex })

      const cache = buildInputTypeLookupCache(inputs, new Map())

      // Use S.Option(CursorFromHex) - this is the problematic case
      const OptionalCursorSchema = S.Option(CursorFromHex)

      const result = toGraphQLInputTypeWithRegistry(
        OptionalCursorSchema,
        new Map(),
        inputRegistry,
        inputs,
        new Map(),
        cache
      )

      expect(result).toBe(cursorInputType)
    })

    it("should find registered input when using S.Option(Schema.Class) in args - WITHOUT cache", () => {
      // Same test but without cache - tests the fallback linear scan
      class CursorFromHex extends S.Class<CursorFromHex>("CursorFromHex")({
        value: S.String,
      }) {}

      const cursorInputType = new GraphQLInputObjectType({
        name: "CursorInput",
        fields: { value: { type: GraphQLString } },
      })

      const inputRegistry = new Map<string, GraphQLInputObjectType>()
      inputRegistry.set("CursorInput", cursorInputType)

      const inputs = new Map()
      inputs.set("CursorInput", { name: "CursorInput", schema: CursorFromHex })

      // NO cache passed - tests fallback linear scan
      const OptionalCursorSchema = S.Option(CursorFromHex)

      const result = toGraphQLInputTypeWithRegistry(
        OptionalCursorSchema,
        new Map(),
        inputRegistry,
        inputs,
        new Map()
        // No cache parameter
      )

      expect(result).toBe(cursorInputType)
    })

    it("should find registered input when using S.OptionFromNullOr(Schema.Class) in args - WITHOUT cache", () => {
      class CursorFromHex extends S.Class<CursorFromHex>("CursorFromHex")({
        value: S.String,
      }) {}

      const cursorInputType = new GraphQLInputObjectType({
        name: "CursorInput",
        fields: { value: { type: GraphQLString } },
      })

      const inputRegistry = new Map<string, GraphQLInputObjectType>()
      inputRegistry.set("CursorInput", cursorInputType)

      const inputs = new Map()
      inputs.set("CursorInput", { name: "CursorInput", schema: CursorFromHex })

      // Use S.OptionFromNullOr - another common pattern
      const OptionalCursorSchema = S.OptionFromNullOr(CursorFromHex)

      const result = toGraphQLInputTypeWithRegistry(
        OptionalCursorSchema,
        new Map(),
        inputRegistry,
        inputs,
        new Map()
        // No cache parameter
      )

      expect(result).toBe(cursorInputType)
    })

    it("should find registered branded/transformed input in S.Option - WITHOUT cache", () => {
      // Simulates a branded type like CursorFromHex which is S.String.pipe(S.brand("Cursor"))
      const CursorFromHex = S.String.pipe(S.brand("Cursor"))

      const cursorInputType = new GraphQLInputObjectType({
        name: "CursorInput",
        fields: { value: { type: GraphQLString } },
      })

      const inputRegistry = new Map<string, GraphQLInputObjectType>()
      inputRegistry.set("CursorInput", cursorInputType)

      const inputs = new Map()
      inputs.set("CursorInput", { name: "CursorInput", schema: CursorFromHex })

      const OptionalCursorSchema = S.Option(CursorFromHex)

      const result = toGraphQLInputTypeWithRegistry(
        OptionalCursorSchema,
        new Map(),
        inputRegistry,
        inputs,
        new Map()
      )

      expect(result).toBe(cursorInputType)
    })

    it("should find registered input in args struct containing S.optional(RegisteredType) - WITHOUT cache", () => {
      // This tests the full args scenario: S.Struct({ cursor: S.optional(CursorFromHex) })
      class CursorFromHex extends S.Class<CursorFromHex>("CursorFromHex")({
        value: S.String,
      }) {}

      const cursorInputType = new GraphQLInputObjectType({
        name: "CursorInput",
        fields: { value: { type: GraphQLString } },
      })

      const inputRegistry = new Map<string, GraphQLInputObjectType>()
      inputRegistry.set("CursorInput", cursorInputType)

      const inputs = new Map()
      inputs.set("CursorInput", { name: "CursorInput", schema: CursorFromHex })

      const ArgsSchema = S.Struct({
        limit: S.Int,
        cursor: S.optional(CursorFromHex),
      })

      const args = toGraphQLArgsWithRegistry(
        ArgsSchema,
        new Map(),
        inputRegistry,
        inputs,
        new Map()
        // No cache parameter
      )

      expect(args.limit).toBeDefined()
      expect(args.cursor).toBeDefined()
      // The cursor type should be the registered CursorInput (nullable since it's optional)
      expect(args.cursor.type).toBe(cursorInputType)
    })
  })

  // ==========================================================================
  // _tag field filtering
  // ==========================================================================
  describe("_tag field filtering", () => {
    it("should filter out _tag from TaggedStruct in schemaToFields", () => {
      const ctx = createEmptyContext()
      const TaggedSchema = S.TaggedStruct("MyTag", {
        id: S.String,
        value: S.Number,
      })

      const fields = schemaToFields(TaggedSchema, ctx)

      expect(fields._tag).toBeUndefined()
      expect(fields.id).toBeDefined()
      expect(fields.value).toBeDefined()
    })

    it("should filter out _tag from TaggedStruct in schemaToInputFields", () => {
      const TaggedSchema = S.TaggedStruct("MyInput", {
        id: S.String,
        data: S.String,
      })

      const fields = schemaToInputFields(TaggedSchema, new Map(), new Map(), new Map(), new Map())

      expect(fields._tag).toBeUndefined()
      expect(fields.id).toBeDefined()
      expect(fields.data).toBeDefined()
    })

    it("should filter out _tag from TaggedStruct in toGraphQLArgsWithRegistry", () => {
      const TaggedArgs = S.TaggedStruct("MyArgs", {
        id: S.String,
        limit: S.Int,
      })

      const args = toGraphQLArgsWithRegistry(TaggedArgs, new Map(), new Map(), new Map(), new Map())

      expect(args._tag).toBeUndefined()
      expect(args.id).toBeDefined()
      expect(args.limit).toBeDefined()
    })
  })
})

describe("registered unencoded key-context variants", () => {
  it.each([false, true])(
    "preserves computed fields, nullability, and distinct primitive registrations (%s)",
    async (reversed) => {
      const Token = S.String.annotate({ identifier: "TokenValue" })
      const OtherToken = S.String.annotate({ identifier: "TokenValue" })
      const Result = S.Struct({
        required: Token,
        mutable: S.mutableKey(Token),
        optional: S.optionalKey(Token),
        mutableOptional: S.mutableKey(S.optionalKey(Token)),
        optionalMutable: S.optionalKey(S.mutableKey(Token)),
        optionalValue: S.optional(Token),
        other: S.optionalKey(OtherToken),
      }).annotate({ identifier: "TokenResult" })
      const registrations = [
        {
          name: "Token",
          schema: Token,
          fields: {
            valid: {
              type: S.Boolean,
              resolve: (token: string) => Effect.succeed(token === "valid"),
            },
          },
        },
        {
          name: "OtherToken",
          schema: OtherToken,
          fields: {
            valid: { type: S.Boolean, resolve: () => Effect.succeed(false) },
          },
        },
      ]
      let builder = GraphQLSchemaBuilder.empty
      for (const registration of reversed ? registrations.reverse() : registrations) {
        builder = builder.objectType(registration)
      }
      const schema = builder
        .query("result", {
          type: Result,
          resolve: () =>
            Effect.succeed({
              required: "valid",
              mutable: "invalid",
              optional: "valid",
              mutableOptional: "valid",
              optionalMutable: "valid",
              optionalValue: "valid",
              other: "valid",
            }),
        })
        .query("absent", {
          type: Result,
          resolve: () => Effect.succeed({ required: "valid", mutable: "valid" }),
        })
        .buildSchema()

      const fields = (
        getNamedType(schema.getQueryType()!.getFields().result.type) as GraphQLObjectType
      ).getFields()
      expect(
        Object.fromEntries(
          Object.entries(fields).map(([name, field]) => [name, String(field.type)])
        )
      ).toEqual({
        required: "Token!",
        mutable: "Token!",
        optional: "Token",
        mutableOptional: "Token",
        optionalMutable: "Token",
        optionalValue: "Token",
        other: "OtherToken",
      })
      const result = await Effect.runPromise(
        execute(
          schema,
          Layer.empty
        )(`{
          result {
            required { valid }
            mutable { valid }
            optional { valid }
            mutableOptional { valid }
            optionalMutable { valid }
            optionalValue { valid }
            other { valid }
          }
          absent {
            required { valid }
            mutable { valid }
            optional { valid }
            mutableOptional { valid }
            optionalMutable { valid }
            optionalValue { valid }
            other { valid }
          }
        }`)
      )
      expect(result.errors).toBeUndefined()
      expect(result.data).toEqual({
        result: {
          required: { valid: true },
          mutable: { valid: false },
          optional: { valid: true },
          mutableOptional: { valid: true },
          optionalMutable: { valid: true },
          optionalValue: { valid: true },
          other: { valid: false },
        },
        absent: {
          required: { valid: true },
          mutable: { valid: true },
          optional: null,
          mutableOptional: null,
          optionalMutable: null,
          optionalValue: null,
          other: null,
        },
      })
    }
  )
})

describe("exact registration precedence", () => {
  it.each([false, true])(
    "keeps an explicitly registered transformation distinct from its registered projection (%s)",
    async (projectedFirst) => {
      const decoded = S.Struct({ id: S.String })
      const original = S.String.pipe(
        S.decodeTo(decoded, {
          decode: SchemaGetter.transform((id) => ({ id })),
          encode: SchemaGetter.transform((value) => value.id),
        })
      )
      const projected = S.toType(original)
      const ctx = createEmptyContext()
      const registrations = [
        { name: "Original", schema: original },
        { name: "Projected", schema: projected },
      ]
      for (const registration of projectedFirst ? registrations.reverse() : registrations) {
        ctx.types.set(registration.name, registration)
        ctx.typeRegistry.set(
          registration.name,
          new GraphQLObjectType({
            name: registration.name,
            fields: {
              [registration.name === "Original" ? "originalOnly" : "projectedOnly"]: {
                type: GraphQLString,
                resolve: () => registration.name,
              },
            },
          })
        )
      }
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            original: {
              type: toGraphQLTypeWithRegistry(original, ctx),
              resolve: () => ({ id: "1" }),
            },
            nested: {
              type: toGraphQLTypeWithRegistry(
                S.Struct({ original: S.optionalKey(original), projected }),
                ctx
              ),
              resolve: () => ({ original: { id: "2" }, projected: { id: "3" } }),
            },
          },
        }),
      })
      const result = await graphql({
        schema,
        source:
          "{ original { originalOnly } nested { original { originalOnly } projected { projectedOnly } } }",
      })
      expect(result.errors).toBeUndefined()
      expect(result.data).toEqual({
        original: { originalOnly: "Original" },
        nested: {
          original: { originalOnly: "Original" },
          projected: { projectedOnly: "Projected" },
        },
      })
    }
  )

  it.each([false, true])(
    "keeps optional-key codecs distinct when their encoded input is shared (%s)",
    async (reversed) => {
      const encoded = S.Struct({ id: S.String })
      const decoded = S.Struct({ id: S.String })
      const one = encoded.pipe(S.decodeTo(decoded))
      const two = encoded.pipe(S.decodeTo(decoded))
      const registrations = [
        { name: "OneInput", schema: one },
        { name: "TwoInput", schema: two },
      ]
      let builder = GraphQLSchemaBuilder.empty
      for (const registration of reversed ? registrations.reverse() : registrations) {
        builder = builder.inputType(registration)
      }
      const schema = builder
        .query("echo", {
          type: S.String,
          args: S.Struct({
            one: S.OptionFromOptionalKey(one),
            two: S.OptionFromOptionalKey(two),
          }),
          resolve: ({ one, two }) =>
            Effect.succeed(
              `${Option.isSome(one) ? one.value.id : "absent"}:${Option.isSome(two) ? two.value.id : "absent"}`
            ),
        })
        .buildSchema()

      const result = await Effect.runPromise(
        execute(schema, Layer.empty)(
          "query($one: OneInput, $two: TwoInput) { echo(one: $one, two: $two) }",
          { one: { id: "1" }, two: { id: "2" } }
        )
      )

      expect(result.errors).toBeUndefined()
      expect(result.data).toEqual({ echo: "1:2" })
    }
  )
})
