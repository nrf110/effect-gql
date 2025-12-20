import { describe, it, expect } from "vitest"
import * as S from "effect/Schema"
import {
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLNonNull,
  GraphQLList,
  GraphQLObjectType,
  GraphQLInputObjectType,
  isNonNullType,
  isListType,
  isNamedType,
} from "graphql"
import {
  toGraphQLType,
  toGraphQLInputType,
  toGraphQLObjectType,
  toGraphQLArgs,
} from "../../src/schema-mapping"

// Helper to unwrap NonNull types
const unwrapNonNull = (type: any): any =>
  isNonNullType(type) ? type.ofType : type

// Helper to get type name
const getTypeName = (type: any): string => {
  const unwrapped = unwrapNonNull(type)
  if (isListType(unwrapped)) {
    return `[${getTypeName(unwrapped.ofType)}]`
  }
  if (isNamedType(unwrapped)) {
    return unwrapped.name
  }
  return "Unknown"
}

describe("schema-mapping.ts", () => {
  // ==========================================================================
  // toGraphQLType - Primitives
  // ==========================================================================
  describe("toGraphQLType - Primitives", () => {
    it("should map S.String to GraphQLString", () => {
      const result = toGraphQLType(S.String)
      expect(result).toBe(GraphQLString)
    })

    it("should map S.Number to GraphQLFloat", () => {
      const result = toGraphQLType(S.Number)
      expect(result).toBe(GraphQLFloat)
    })

    it("should map S.Boolean to GraphQLBoolean", () => {
      const result = toGraphQLType(S.Boolean)
      expect(result).toBe(GraphQLBoolean)
    })
  })

  // ==========================================================================
  // toGraphQLType - Refinements
  // ==========================================================================
  describe("toGraphQLType - Refinements", () => {
    it("should map S.Int to GraphQLInt", () => {
      const result = toGraphQLType(S.Int)
      expect(result).toBe(GraphQLInt)
    })

    it("should handle nested refinements with Int base", () => {
      // S.Int with additional refinement (positive)
      const PositiveInt = S.Int.pipe(S.positive())
      const result = toGraphQLType(PositiveInt)
      // Should still be GraphQLInt since base is Int
      expect(result).toBe(GraphQLInt)
    })

    it("should handle non-integer refinements (fallback to base type)", () => {
      // A string with a pattern refinement
      const Email = S.String.pipe(S.pattern(/@/))
      const result = toGraphQLType(Email)
      expect(result).toBe(GraphQLString)
    })

    it("should handle number refinements without integer filter", () => {
      // S.Number with positive refinement should stay Float
      const PositiveNumber = S.Number.pipe(S.positive())
      const result = toGraphQLType(PositiveNumber)
      expect(result).toBe(GraphQLFloat)
    })
  })

  // ==========================================================================
  // toGraphQLType - Literals
  // ==========================================================================
  describe("toGraphQLType - Literals", () => {
    it("should map string literal to GraphQLString", () => {
      const result = toGraphQLType(S.Literal("hello"))
      expect(result).toBe(GraphQLString)
    })

    it("should map integer number literal to GraphQLInt", () => {
      const result = toGraphQLType(S.Literal(42))
      expect(result).toBe(GraphQLInt)
    })

    it("should map float number literal to GraphQLFloat", () => {
      const result = toGraphQLType(S.Literal(3.14))
      expect(result).toBe(GraphQLFloat)
    })

    it("should map boolean literal to GraphQLBoolean", () => {
      const result = toGraphQLType(S.Literal(true))
      expect(result).toBe(GraphQLBoolean)
    })

    it("should map false literal to GraphQLBoolean", () => {
      const result = toGraphQLType(S.Literal(false))
      expect(result).toBe(GraphQLBoolean)
    })
  })

  // ==========================================================================
  // toGraphQLType - Arrays
  // Note: The current implementation uses TupleType.elements which doesn't
  // handle S.Array properly (S.Array uses rest elements). These tests document
  // the current fallback behavior.
  // ==========================================================================
  describe("toGraphQLType - Arrays", () => {
    it("should handle tuple with explicit elements", () => {
      // Use S.Tuple which puts types in elements array
      const result = toGraphQLType(S.Tuple(S.String))
      expect(isListType(result)).toBe(true)
      expect((result as any).ofType).toBe(GraphQLString)
    })

    it("should handle tuple with Int element", () => {
      const result = toGraphQLType(S.Tuple(S.Int))
      expect(isListType(result)).toBe(true)
      expect((result as any).ofType).toBe(GraphQLInt)
    })

    it("should handle tuple with Boolean element", () => {
      const result = toGraphQLType(S.Tuple(S.Boolean))
      expect(isListType(result)).toBe(true)
      expect((result as any).ofType).toBe(GraphQLBoolean)
    })

    it("should fallback to GraphQLString for S.Array (uses rest elements)", () => {
      // S.Array uses rest elements, not elements array, so it falls through to default
      const result = toGraphQLType(S.Array(S.String))
      // Current behavior: falls back to GraphQLString
      expect(result).toBe(GraphQLString)
    })
  })

  // ==========================================================================
  // toGraphQLType - Structs
  // ==========================================================================
  describe("toGraphQLType - Structs", () => {
    it("should map simple struct to GraphQLObjectType", () => {
      const UserSchema = S.Struct({
        id: S.String,
        name: S.String,
      })
      const result = toGraphQLType(UserSchema)

      expect(result).toBeInstanceOf(GraphQLObjectType)
      const objectType = result as GraphQLObjectType
      const fields = objectType.getFields()

      expect(fields.id).toBeDefined()
      expect(fields.name).toBeDefined()
    })

    it("should wrap non-optional fields in NonNull", () => {
      const UserSchema = S.Struct({
        id: S.String,
      })
      const result = toGraphQLType(UserSchema) as GraphQLObjectType
      const fields = result.getFields()

      expect(isNonNullType(fields.id.type)).toBe(true)
      expect(unwrapNonNull(fields.id.type)).toBe(GraphQLString)
    })

    it("should not wrap optional fields in NonNull", () => {
      const UserSchema = S.Struct({
        bio: S.optional(S.String),
      })
      const result = toGraphQLType(UserSchema) as GraphQLObjectType
      const fields = result.getFields()

      expect(isNonNullType(fields.bio.type)).toBe(false)
      expect(fields.bio.type).toBe(GraphQLString)
    })

    it("should handle mixed optional and required fields", () => {
      const ProfileSchema = S.Struct({
        id: S.String,
        name: S.String,
        bio: S.optional(S.String),
        age: S.optional(S.Int),
      })
      const result = toGraphQLType(ProfileSchema) as GraphQLObjectType
      const fields = result.getFields()

      // Required fields
      expect(isNonNullType(fields.id.type)).toBe(true)
      expect(isNonNullType(fields.name.type)).toBe(true)

      // Optional fields
      expect(isNonNullType(fields.bio.type)).toBe(false)
      expect(isNonNullType(fields.age.type)).toBe(false)
    })

    it("should handle nested struct fields", () => {
      const AddressSchema = S.Struct({
        street: S.String,
        city: S.String,
      })
      const UserSchema = S.Struct({
        name: S.String,
        address: AddressSchema,
      })
      const result = toGraphQLType(UserSchema) as GraphQLObjectType
      const fields = result.getFields()

      expect(fields.address).toBeDefined()
      const addressType = unwrapNonNull(fields.address.type)
      expect(addressType).toBeInstanceOf(GraphQLObjectType)
    })

    it("should handle empty struct", () => {
      const EmptySchema = S.Struct({})
      const result = toGraphQLType(EmptySchema) as GraphQLObjectType
      const fields = result.getFields()

      expect(Object.keys(fields)).toHaveLength(0)
    })
  })

  // ==========================================================================
  // toGraphQLType - Transformations
  // ==========================================================================
  describe("toGraphQLType - Transformations", () => {
    it("should use 'to' side for transformations", () => {
      // TaggedStruct creates a transformation
      const UserSchema = S.TaggedStruct("User", {
        id: S.String,
        name: S.String,
      })

      const result = toGraphQLType(UserSchema)
      expect(result).toBeInstanceOf(GraphQLObjectType)

      const objectType = result as GraphQLObjectType
      const fields = objectType.getFields()
      expect(fields.id).toBeDefined()
      expect(fields.name).toBeDefined()
    })
  })

  // ==========================================================================
  // toGraphQLType - Unions
  // ==========================================================================
  describe("toGraphQLType - Unions", () => {
    it("should use first type for literal unions (enum-like)", () => {
      const StatusSchema = S.Literal("ACTIVE", "INACTIVE")
      const result = toGraphQLType(StatusSchema)
      // Uses first type which is a string literal
      expect(result).toBe(GraphQLString)
    })

    it("should handle union of primitive types", () => {
      const MixedSchema = S.Union(S.String, S.Number)
      const result = toGraphQLType(MixedSchema)
      // Uses first type
      expect(result).toBe(GraphQLString)
    })
  })

  // ==========================================================================
  // toGraphQLType - Default fallback
  // ==========================================================================
  describe("toGraphQLType - Default fallback", () => {
    it("should return GraphQLString for unknown/unsupported types", () => {
      // Symbol type is not directly supported
      const schema = S.SymbolFromSelf
      const result = toGraphQLType(schema)
      expect(result).toBe(GraphQLString)
    })
  })

  // ==========================================================================
  // toGraphQLInputType - Primitives
  // ==========================================================================
  describe("toGraphQLInputType - Primitives", () => {
    it("should map S.String to GraphQLString", () => {
      expect(toGraphQLInputType(S.String)).toBe(GraphQLString)
    })

    it("should map S.Number to GraphQLFloat", () => {
      expect(toGraphQLInputType(S.Number)).toBe(GraphQLFloat)
    })

    it("should map S.Boolean to GraphQLBoolean", () => {
      expect(toGraphQLInputType(S.Boolean)).toBe(GraphQLBoolean)
    })

    it("should map S.Int to GraphQLInt", () => {
      expect(toGraphQLInputType(S.Int)).toBe(GraphQLInt)
    })
  })

  // ==========================================================================
  // toGraphQLInputType - Structs
  // ==========================================================================
  describe("toGraphQLInputType - Structs", () => {
    it("should map struct to GraphQLInputObjectType", () => {
      const InputSchema = S.Struct({
        name: S.String,
        email: S.String,
      })
      const result = toGraphQLInputType(InputSchema)

      expect(result).toBeInstanceOf(GraphQLInputObjectType)
    })

    it("should wrap non-optional fields in NonNull", () => {
      const InputSchema = S.Struct({
        name: S.String,
      })
      const result = toGraphQLInputType(InputSchema) as GraphQLInputObjectType
      const fields = result.getFields()

      expect(isNonNullType(fields.name.type)).toBe(true)
    })

    it("should not wrap optional fields in NonNull", () => {
      const InputSchema = S.Struct({
        bio: S.optional(S.String),
      })
      const result = toGraphQLInputType(InputSchema) as GraphQLInputObjectType
      const fields = result.getFields()

      expect(isNonNullType(fields.bio.type)).toBe(false)
    })

    it("should handle nested input types", () => {
      const AddressInput = S.Struct({
        street: S.String,
      })
      const UserInput = S.Struct({
        name: S.String,
        address: AddressInput,
      })
      const result = toGraphQLInputType(UserInput) as GraphQLInputObjectType
      const fields = result.getFields()

      const addressType = unwrapNonNull(fields.address.type)
      expect(addressType).toBeInstanceOf(GraphQLInputObjectType)
    })
  })

  // ==========================================================================
  // toGraphQLInputType - Arrays
  // Note: Same limitation as toGraphQLType - S.Array uses rest elements
  // ==========================================================================
  describe("toGraphQLInputType - Arrays", () => {
    it("should handle tuple with explicit elements", () => {
      const result = toGraphQLInputType(S.Tuple(S.String))
      expect(isListType(result)).toBe(true)
      expect((result as any).ofType).toBe(GraphQLString)
    })

    it("should handle tuple of input objects", () => {
      const ItemInput = S.Struct({ id: S.String })
      const result = toGraphQLInputType(S.Tuple(ItemInput))

      expect(isListType(result)).toBe(true)
      const inner = (result as any).ofType
      expect(inner).toBeInstanceOf(GraphQLInputObjectType)
    })

    it("should fallback to GraphQLString for S.Array (uses rest elements)", () => {
      const result = toGraphQLInputType(S.Array(S.String))
      expect(result).toBe(GraphQLString)
    })
  })

  // ==========================================================================
  // toGraphQLInputType - Transformations
  // ==========================================================================
  describe("toGraphQLInputType - Transformations", () => {
    it("should use 'from' side for transformations", () => {
      // For input types, we use the "from" side (the encoded/serialized form)
      class UserInput extends S.Class<UserInput>("UserInput")({
        name: S.String,
      }) {}

      const result = toGraphQLInputType(UserInput)
      expect(result).toBeInstanceOf(GraphQLInputObjectType)
    })
  })

  // ==========================================================================
  // toGraphQLObjectType
  // ==========================================================================
  describe("toGraphQLObjectType", () => {
    it("should create named GraphQL object type", () => {
      const UserSchema = S.Struct({
        id: S.String,
        name: S.String,
      })
      const result = toGraphQLObjectType("User", UserSchema)

      expect(result).toBeInstanceOf(GraphQLObjectType)
      expect(result.name).toBe("User")
    })

    it("should include all schema fields", () => {
      const UserSchema = S.Struct({
        id: S.String,
        name: S.String,
        email: S.optional(S.String),
      })
      const result = toGraphQLObjectType("User", UserSchema)
      const fields = result.getFields()

      expect(fields.id).toBeDefined()
      expect(fields.name).toBeDefined()
      expect(fields.email).toBeDefined()
    })

    it("should add additional computed fields", () => {
      const UserSchema = S.Struct({
        id: S.String,
        firstName: S.String,
        lastName: S.String,
      })

      const result = toGraphQLObjectType("User", UserSchema, {
        fullName: {
          type: GraphQLString,
          resolve: (parent) => `${parent.firstName} ${parent.lastName}`,
        },
      })

      const fields = result.getFields()
      expect(fields.fullName).toBeDefined()
      expect(fields.fullName.type).toBe(GraphQLString)
    })

    it("should support field arguments on additional fields", () => {
      const UserSchema = S.Struct({
        id: S.String,
      })

      const result = toGraphQLObjectType("User", UserSchema, {
        posts: {
          type: new GraphQLList(GraphQLString),
          args: {
            limit: { type: GraphQLInt },
          },
          description: "User's posts",
          resolve: () => [],
        },
      })

      const fields = result.getFields()
      expect(fields.posts.args).toHaveLength(1)
      expect(fields.posts.args[0].name).toBe("limit")
      expect(fields.posts.description).toBe("User's posts")
    })

    it("should throw for non-object schema", () => {
      expect(() => {
        toGraphQLObjectType("String", S.String)
      }).toThrow("Schema must be an object type to convert to GraphQLObjectType")
    })

    it("should handle schema with all field types", () => {
      const ComplexSchema = S.Struct({
        stringField: S.String,
        intField: S.Int,
        floatField: S.Number,
        boolField: S.Boolean,
        tupleField: S.Tuple(S.String), // Use Tuple instead of Array for proper list handling
        optionalField: S.optional(S.String),
      })

      const result = toGraphQLObjectType("Complex", ComplexSchema)
      const fields = result.getFields()

      expect(getTypeName(fields.stringField.type)).toBe("String")
      expect(getTypeName(fields.intField.type)).toBe("Int")
      expect(getTypeName(fields.floatField.type)).toBe("Float")
      expect(getTypeName(fields.boolField.type)).toBe("Boolean")
      expect(isListType(unwrapNonNull(fields.tupleField.type))).toBe(true)
      expect(isNonNullType(fields.optionalField.type)).toBe(false)
    })
  })

  // ==========================================================================
  // toGraphQLArgs
  // ==========================================================================
  describe("toGraphQLArgs", () => {
    it("should convert struct to argument map", () => {
      const ArgsSchema = S.Struct({
        id: S.String,
        limit: S.Int,
      })
      const result = toGraphQLArgs(ArgsSchema)

      expect(result.id).toBeDefined()
      expect(result.limit).toBeDefined()
    })

    it("should wrap required args in NonNull", () => {
      const ArgsSchema = S.Struct({
        id: S.String,
      })
      const result = toGraphQLArgs(ArgsSchema)

      expect(isNonNullType(result.id.type)).toBe(true)
      expect(unwrapNonNull(result.id.type)).toBe(GraphQLString)
    })

    it("should not wrap optional args in NonNull", () => {
      const ArgsSchema = S.Struct({
        limit: S.optional(S.Int),
      })
      const result = toGraphQLArgs(ArgsSchema)

      expect(isNonNullType(result.limit.type)).toBe(false)
    })

    it("should handle mixed required and optional args", () => {
      const ArgsSchema = S.Struct({
        id: S.String,
        limit: S.optional(S.Int),
        offset: S.optional(S.Int),
      })
      const result = toGraphQLArgs(ArgsSchema)

      expect(isNonNullType(result.id.type)).toBe(true)
      expect(isNonNullType(result.limit.type)).toBe(false)
      expect(isNonNullType(result.offset.type)).toBe(false)
    })

    it("should throw for non-object schema", () => {
      expect(() => {
        toGraphQLArgs(S.String)
      }).toThrow("Schema must be an object type to convert to GraphQL arguments")
    })

    it("should handle input type arguments (nested structs)", () => {
      const FilterSchema = S.Struct({
        name: S.optional(S.String),
      })
      const ArgsSchema = S.Struct({
        filter: FilterSchema,
      })
      const result = toGraphQLArgs(ArgsSchema)

      expect(result.filter).toBeDefined()
      const filterType = unwrapNonNull(result.filter.type)
      expect(filterType).toBeInstanceOf(GraphQLInputObjectType)
    })

    it("should handle tuple arguments", () => {
      const ArgsSchema = S.Struct({
        ids: S.Tuple(S.String), // Use Tuple for proper list handling
      })
      const result = toGraphQLArgs(ArgsSchema)

      const idsType = unwrapNonNull(result.ids.type)
      expect(isListType(idsType)).toBe(true)
    })

    it("should fallback to String for S.Array arguments", () => {
      const ArgsSchema = S.Struct({
        ids: S.Array(S.String),
      })
      const result = toGraphQLArgs(ArgsSchema)

      // Current behavior: S.Array falls back to String
      const idsType = unwrapNonNull(result.ids.type)
      expect(idsType).toBe(GraphQLString)
    })
  })

  // ==========================================================================
  // toGraphQLType - Suspend (recursive types)
  // ==========================================================================
  describe("toGraphQLType - Suspend", () => {
    it("should handle S.suspend for primitive types", () => {
      const LazyString = S.suspend(() => S.String)
      const result = toGraphQLType(LazyString)
      expect(result).toBe(GraphQLString)
    })

    it("should handle S.suspend for Int", () => {
      const LazyInt = S.suspend(() => S.Int)
      const result = toGraphQLType(LazyInt)
      expect(result).toBe(GraphQLInt)
    })

    it("should handle S.suspend for struct types", () => {
      const PersonSchema = S.Struct({
        name: S.String,
        age: S.Int,
      })
      const LazyPerson = S.suspend(() => PersonSchema)
      const result = toGraphQLType(LazyPerson)

      expect(result).toBeInstanceOf(GraphQLObjectType)
      const fields = (result as GraphQLObjectType).getFields()
      expect(fields.name).toBeDefined()
      expect(fields.age).toBeDefined()
    })

    it("should handle suspend that references a different schema (non-recursive)", () => {
      // Non-recursive suspend - references a different schema
      const AddressSchema = S.Struct({
        city: S.String,
      })
      const PersonSchema = S.Struct({
        name: S.String,
        address: S.suspend(() => AddressSchema),
      })

      const result = toGraphQLType(PersonSchema)
      expect(result).toBeInstanceOf(GraphQLObjectType)

      const fields = (result as GraphQLObjectType).getFields()
      expect(fields.name).toBeDefined()
      expect(fields.address).toBeDefined()

      const addressType = unwrapNonNull(fields.address.type)
      expect(addressType).toBeInstanceOf(GraphQLObjectType)
    })

    // Note: True self-referential types require the registry-aware version
    // (toGraphQLTypeWithRegistry) to avoid infinite recursion. The base
    // toGraphQLType function cannot handle cycles on its own.
  })

  // ==========================================================================
  // toGraphQLInputType - Suspend (recursive types)
  // ==========================================================================
  describe("toGraphQLInputType - Suspend", () => {
    it("should handle S.suspend for primitive input types", () => {
      const LazyString = S.suspend(() => S.String)
      const result = toGraphQLInputType(LazyString)
      expect(result).toBe(GraphQLString)
    })

    it("should handle S.suspend for struct input types", () => {
      const InputSchema = S.Struct({
        name: S.String,
      })
      const LazyInput = S.suspend(() => InputSchema)
      const result = toGraphQLInputType(LazyInput)

      expect(result).toBeInstanceOf(GraphQLInputObjectType)
    })

    it("should handle suspend that references a different input schema (non-recursive)", () => {
      // Non-recursive suspend - references a different schema
      const AddressInput = S.Struct({
        city: S.String,
      })
      const PersonInput = S.Struct({
        name: S.String,
        address: S.suspend(() => AddressInput),
      })

      const result = toGraphQLInputType(PersonInput)
      expect(result).toBeInstanceOf(GraphQLInputObjectType)

      const fields = (result as GraphQLInputObjectType).getFields()
      expect(fields.name).toBeDefined()
      expect(fields.address).toBeDefined()

      const addressType = unwrapNonNull(fields.address.type)
      expect(addressType).toBeInstanceOf(GraphQLInputObjectType)
    })

    // Note: True self-referential input types require the registry-aware version
    // (toGraphQLInputTypeWithRegistry) to avoid infinite recursion.
  })

  // ==========================================================================
  // Edge Cases
  // ==========================================================================
  describe("Edge Cases", () => {
    it("should handle optional fields with tuple type", () => {
      const Schema = S.Struct({
        data: S.optional(S.Tuple(S.String)),
      })
      const result = toGraphQLType(Schema) as GraphQLObjectType
      const fields = result.getFields()

      // data should be nullable (optional)
      expect(isNonNullType(fields.data.type)).toBe(false)
      // Should be a list
      expect(isListType(fields.data.type)).toBe(true)
    })

    it("should handle optional S.Array (falls back to String)", () => {
      const Schema = S.Struct({
        data: S.optional(S.Array(S.String)),
      })
      const result = toGraphQLType(Schema) as GraphQLObjectType
      const fields = result.getFields()

      // data should be nullable (optional)
      expect(isNonNullType(fields.data.type)).toBe(false)
      // Current behavior: S.Array falls back to String
      expect(fields.data.type).toBe(GraphQLString)
    })

    it("should handle struct with numeric field names", () => {
      const Schema = S.Struct({
        field1: S.String,
        field2: S.Int,
      })
      const result = toGraphQLType(Schema) as GraphQLObjectType
      const fields = result.getFields()

      expect(fields.field1).toBeDefined()
      expect(fields.field2).toBeDefined()
    })

    it("should handle TaggedStruct", () => {
      const UserSchema = S.TaggedStruct("User", {
        id: S.String,
        name: S.String,
      })
      const result = toGraphQLType(UserSchema)

      // TaggedStruct creates a transformation, so we get an object type
      expect(result).toBeInstanceOf(GraphQLObjectType)
    })
  })
})
