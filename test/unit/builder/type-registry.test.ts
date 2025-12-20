import { describe, it, expect } from "vitest"
import * as S from "effect/Schema"
import {
  GraphQLObjectType,
  GraphQLInterfaceType,
  GraphQLEnumType,
  GraphQLUnionType,
  GraphQLInputObjectType,
  GraphQLString,
  GraphQLInt,
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
} from "../../../src/builder/type-registry"

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

      // S.Array creates a Transformation with TupleType on "to" side
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
      const result = toGraphQLTypeWithRegistry(S.Tuple(S.String), ctx)
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

      const StatusSchema = S.Literal("ACTIVE", "INACTIVE")
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
      const UnionSchema = S.Union(
        S.Struct({ _tag: S.Literal("Text"), body: S.String }),
        S.Struct({ _tag: S.Literal("Image"), url: S.String })
      )

      const result = toGraphQLTypeWithRegistry(UnionSchema, ctx)
      expect(result).toBe(contentUnion)
    })
  })

  // ==========================================================================
  // schemaToFields
  // ==========================================================================
  describe("schemaToFields", () => {
    it("should convert TypeLiteral to fields", () => {
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

    it("should handle TaggedStruct (Transformation)", () => {
      const ctx = createEmptyContext()
      const UserSchema = S.TaggedStruct("User", {
        id: S.String,
        name: S.String,
      })

      const fields = schemaToFields(UserSchema, ctx)
      expect(fields.id).toBeDefined()
      expect(fields.name).toBeDefined()
      expect(fields._tag).toBeDefined()
    })

    it("should handle Schema.Class (Transformation)", () => {
      const ctx = createEmptyContext()
      class User extends S.Class<User>("User")({
        id: S.String,
        name: S.String,
      }) {}

      const fields = schemaToFields(User, ctx)
      expect(fields.id).toBeDefined()
      expect(fields.name).toBeDefined()
    })

    it("should return empty object for non-TypeLiteral", () => {
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
    it("should convert TypeLiteral to input fields", () => {
      const InputSchema = S.Struct({
        name: S.String,
        email: S.String,
      })

      const fields = schemaToInputFields(
        InputSchema,
        new Map(),
        new Map(),
        new Map(),
        new Map()
      )

      expect(fields.name).toBeDefined()
      expect(fields.email).toBeDefined()
    })

    it("should wrap required fields in NonNull", () => {
      const InputSchema = S.Struct({ name: S.String })

      const fields = schemaToInputFields(
        InputSchema,
        new Map(),
        new Map(),
        new Map(),
        new Map()
      )

      expect(isNonNullType(fields.name.type)).toBe(true)
    })

    it("should not wrap optional fields in NonNull", () => {
      const InputSchema = S.Struct({ name: S.optional(S.String) })

      const fields = schemaToInputFields(
        InputSchema,
        new Map(),
        new Map(),
        new Map(),
        new Map()
      )

      expect(isNonNullType(fields.name.type)).toBe(false)
    })

    it("should return empty object for non-TypeLiteral", () => {
      const fields = schemaToInputFields(
        S.String,
        new Map(),
        new Map(),
        new Map(),
        new Map()
      )
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

      const fields = schemaToInputFields(
        UserInput,
        new Map(),
        inputRegistry,
        inputs,
        new Map()
      )

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

      const StatusSchema = S.Literal("ACTIVE", "INACTIVE")
      const result = toGraphQLInputTypeWithRegistry(
        StatusSchema,
        enumRegistry,
        new Map(),
        new Map(),
        enums
      )

      expect(result).toBe(StatusEnum)
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

      // S.optional creates a Union with UndefinedKeyword
      const OptionalInput = S.Struct({
        data: S.optional(InputSchema),
      })

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

      const args = toGraphQLArgsWithRegistry(
        ArgsSchema,
        new Map(),
        new Map(),
        new Map(),
        new Map()
      )

      expect(args.id).toBeDefined()
      expect(args.limit).toBeDefined()
    })

    it("should wrap required args in NonNull", () => {
      const ArgsSchema = S.Struct({ id: S.String })

      const args = toGraphQLArgsWithRegistry(
        ArgsSchema,
        new Map(),
        new Map(),
        new Map(),
        new Map()
      )

      expect(isNonNullType(args.id.type)).toBe(true)
    })

    it("should not wrap optional args in NonNull", () => {
      const ArgsSchema = S.Struct({ limit: S.optional(S.Int) })

      const args = toGraphQLArgsWithRegistry(
        ArgsSchema,
        new Map(),
        new Map(),
        new Map(),
        new Map()
      )

      expect(isNonNullType(args.limit.type)).toBe(false)
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
        status: S.Literal("ACTIVE", "INACTIVE"),
      })

      const args = toGraphQLArgsWithRegistry(
        ArgsSchema,
        enumRegistry,
        new Map(),
        new Map(),
        enums
      )

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
        toGraphQLArgsWithRegistry(
          S.String,
          new Map(),
          new Map(),
          new Map(),
          new Map()
        )
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

      const personType = new GraphQLObjectType({
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
      const result = toGraphQLTypeWithRegistry(
        S.Array(S.suspend(() => ItemSchema)),
        ctx
      )

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

      const nestedInputType = new GraphQLInputObjectType({
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

      const args = toGraphQLArgsWithRegistry(
        ArgsSchema,
        enumRegistry,
        inputRegistry,
        inputs,
        enums
      )

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
})
