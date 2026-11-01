import { describe, it, expect } from "vitest"
import * as S from "effect/Schema"
import {
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLObjectType,
  GraphQLInputObjectType,
  isNonNullType,
  isObjectType,
} from "graphql"
import { toGraphQLType, toGraphQLInputType, toGraphQLObjectType } from "../../src/schema-mapping"

// Helper to unwrap NonNull types
const unwrapNonNull = (type: any): any => (isNonNullType(type) ? type.ofType : type)

// =============================================================================
// Branded Types
// =============================================================================
describe("toGraphQLType - Branded Types", () => {
  it("should map branded string to GraphQLString", () => {
    const NonEmptyString = S.String.check(S.isMinLength(1))
    const BrandedId = NonEmptyString.pipe(S.brand("UserId"))

    const result = toGraphQLType(BrandedId)
    expect(result).toBe(GraphQLString)
  })

  it("should map branded int to GraphQLInt", () => {
    const PositiveInt = S.Int.check(S.isGreaterThan(0))
    const BrandedAge = PositiveInt.pipe(S.brand("Age"))

    const result = toGraphQLType(BrandedAge)
    expect(result).toBe(GraphQLInt)
  })

  it("should map branded number to GraphQLFloat", () => {
    const PositiveNumber = S.Number.check(S.isGreaterThan(0))
    const BrandedPrice = PositiveNumber.pipe(S.brand("Price"))

    const result = toGraphQLType(BrandedPrice)
    expect(result).toBe(GraphQLFloat)
  })

  it("should map nested branded types correctly", () => {
    // Multiple brands/refinements stacked
    const NonEmptyString = S.String.check(S.isMinLength(1))
    const MaxLength = NonEmptyString.check(S.isMaxLength(100))
    const BrandedName = MaxLength.pipe(S.brand("Name"))

    const result = toGraphQLType(BrandedName)
    expect(result).toBe(GraphQLString)
  })

  it("should handle branded types in struct fields", () => {
    const UserId = S.String.check(S.isMinLength(1)).pipe(S.brand("UserId"))
    const UserSchema = S.Struct({
      id: UserId,
      name: S.String,
    })

    const result = toGraphQLType(UserSchema) as GraphQLObjectType
    const fields = result.getFields()

    // id should be NonNull String (branded string -> String)
    expect(isNonNullType(fields.id.type)).toBe(true)
    expect(unwrapNonNull(fields.id.type)).toBe(GraphQLString)
  })
})

describe("toGraphQLInputType - Branded Types", () => {
  it("should map branded string input to GraphQLString", () => {
    const Email = S.String.check(S.isPattern(/@/)).pipe(S.brand("Email"))

    const result = toGraphQLInputType(Email)
    expect(result).toBe(GraphQLString)
  })

  it("should handle branded types in input struct fields", () => {
    const UserId = S.String.check(S.isMinLength(1)).pipe(S.brand("UserId"))
    const InputSchema = S.Struct({
      userId: UserId,
    })

    const result = toGraphQLInputType(InputSchema) as GraphQLInputObjectType
    const fields = result.getFields()

    expect(isNonNullType(fields.userId.type)).toBe(true)
    expect(unwrapNonNull(fields.userId.type)).toBe(GraphQLString)
  })
})

// =============================================================================
// Option Types
// =============================================================================
describe("toGraphQLType - Option Types", () => {
  it("should map S.OptionFromNullOr(String) to nullable GraphQLString", () => {
    const OptionalString = S.OptionFromNullOr(S.String)
    const result = toGraphQLType(OptionalString)

    // Should map to the inner type (String), which is nullable since not wrapped in NonNull
    expect(result).toBe(GraphQLString)
  })

  it("should map S.OptionFromNullOr(Int) to nullable GraphQLInt", () => {
    const OptionalInt = S.OptionFromNullOr(S.Int)
    const result = toGraphQLType(OptionalInt)

    expect(result).toBe(GraphQLInt)
  })

  it("should map S.OptionFromUndefinedOr(String) to nullable GraphQLString", () => {
    const OptionalString = S.OptionFromUndefinedOr(S.String)
    const result = toGraphQLType(OptionalString)

    expect(result).toBe(GraphQLString)
  })

  it("should map S.OptionFromNullOr with object type to nullable object", () => {
    const UserSchema = S.Struct({
      id: S.String,
      name: S.String,
    })
    const OptionalUser = S.OptionFromNullOr(UserSchema)
    const result = toGraphQLType(OptionalUser)

    // Should map to a GraphQL object type (nullable)
    expect(isObjectType(result)).toBe(true)
    const objectType = result as GraphQLObjectType
    const fields = objectType.getFields()
    expect(fields.id).toBeDefined()
    expect(fields.name).toBeDefined()
  })

  it("should map S.OptionFromNullOr(Boolean) to nullable GraphQLBoolean", () => {
    const OptionalBool = S.OptionFromNullOr(S.Boolean)
    const result = toGraphQLType(OptionalBool)

    expect(result).toBe(GraphQLBoolean)
  })

  it("should map S.OptionFromNullOr(Number) to nullable GraphQLFloat", () => {
    const OptionalNum = S.OptionFromNullOr(S.Number)
    const result = toGraphQLType(OptionalNum)

    expect(result).toBe(GraphQLFloat)
  })
})

describe("toGraphQLType - S.NullOr vs S.optional comparison", () => {
  it("S.optional is for struct fields, not standalone types", () => {
    const SchemaWithOptional = S.Struct({
      name: S.optional(S.String),
    })
    const result = toGraphQLType(SchemaWithOptional) as GraphQLObjectType
    const fields = result.getFields()

    // Optional fields correctly map to nullable types
    expect(isNonNullType(fields.name.type)).toBe(false)
    expect(fields.name.type).toBe(GraphQLString)
  })

  /**
   * S.NullOr creates a Union of the type and null literal.
   * This should map to a nullable GraphQL type.
   */
  it("should handle S.NullOr as nullable type", () => {
    const NullableString = S.NullOr(S.String)
    const result = toGraphQLType(NullableString)

    expect(result).toBe(GraphQLString)

  })

  it("should handle S.NullOr with Int", () => {
    const NullableInt = S.NullOr(S.Int)
    const result = toGraphQLType(NullableInt)

    expect(result).toBe(GraphQLInt)
  })
})

describe("toGraphQLInputType - Option Types", () => {
  it("should expose nullable string input for OptionFromNullOr", () => {
    const OptionalString = S.OptionFromNullOr(S.String)
    const result = toGraphQLInputType(OptionalString)

    expect(result).toBe(GraphQLString)
  })

  it("should handle S.OptionFromNullOr with Int for input", () => {
    const OptionalInt = S.OptionFromNullOr(S.Int)
    const result = toGraphQLInputType(OptionalInt)

    expect(result).toBe(GraphQLInt)
  })
})

// =============================================================================
// toGraphQLObjectType with Branded and Option fields
// =============================================================================
describe("toGraphQLObjectType - Branded and Option fields", () => {
  it("should handle object with branded fields", () => {
    const UserId = S.String.check(S.isMinLength(1)).pipe(S.brand("UserId"))
    const OrganizationId = S.String.check(S.isMinLength(1)).pipe(S.brand("OrganizationId"))

    const UserSchema = S.Struct({
      id: UserId,
      organizationId: OrganizationId,
      name: S.String,
    })

    const result = toGraphQLObjectType("User", UserSchema)
    const fields = result.getFields()

    expect(fields.id).toBeDefined()
    expect(fields.organizationId).toBeDefined()
    expect(fields.name).toBeDefined()

    // All should be NonNull String
    expect(isNonNullType(fields.id.type)).toBe(true)
    expect(unwrapNonNull(fields.id.type)).toBe(GraphQLString)
    expect(isNonNullType(fields.organizationId.type)).toBe(true)
    expect(unwrapNonNull(fields.organizationId.type)).toBe(GraphQLString)
  })

  it("should handle object with optional branded fields", () => {
    const Email = S.String.check(S.isPattern(/@/)).pipe(S.brand("Email"))

    const UserSchema = S.Struct({
      id: S.String,
      email: S.optional(Email),
    })

    const result = toGraphQLObjectType("User", UserSchema)
    const fields = result.getFields()

    // email should be nullable String
    expect(isNonNullType(fields.email.type)).toBe(false)
    expect(fields.email.type).toBe(GraphQLString)
  })

  it("should handle optional nullable fields", () => {
    const UserSchema = S.Struct({
      id: S.String,
      deactivatedAt: S.optional(S.NullOr(S.Date)),
    })

    const result = toGraphQLObjectType("User", UserSchema)
    const fields = result.getFields()

    expect(fields.id).toBeDefined()
    expect(fields.deactivatedAt).toBeDefined()

    // id is required, deactivatedAt is optional
    expect(isNonNullType(fields.id.type)).toBe(true)
    expect(isNonNullType(fields.deactivatedAt.type)).toBe(false)
  })
})

// =============================================================================
// Schema.Class with Branded types (like your OrganizationActor example)
// =============================================================================
describe("Schema.Class with Branded and Optional fields", () => {
  it("should handle Schema.Class with branded ID field", () => {
    const NonEmptyString = S.String.check(S.isMinLength(1))
    const OrganizationId = NonEmptyString.pipe(S.brand("OrganizationId"))

    class Organization extends S.Class<Organization>("Organization")({
      id: OrganizationId,
      name: NonEmptyString,
    }) {}

    const result = toGraphQLType(Organization)
    expect(isObjectType(result)).toBe(true)

    const objectType = result as GraphQLObjectType
    const fields = objectType.getFields()

    expect(fields.id).toBeDefined()
    expect(fields.name).toBeDefined()
    // Branded types map to their base type
    expect(unwrapNonNull(fields.id.type)).toBe(GraphQLString)
    expect(unwrapNonNull(fields.name.type)).toBe(GraphQLString)
  })

  it("should handle Schema.Class with optional nullable fields", () => {
    class OrganizationActor extends S.Class<OrganizationActor>("OrganizationActor")({
      id: S.String,
      name: S.String,
      createdAt: S.Date,
      updatedAt: S.Date,
      deactivatedAt: S.optional(S.NullOr(S.Date)),
    }) {}

    const result = toGraphQLType(OrganizationActor)
    expect(isObjectType(result)).toBe(true)

    const objectType = result as GraphQLObjectType
    const fields = objectType.getFields()

    expect(fields.id).toBeDefined()
    expect(fields.name).toBeDefined()
    expect(fields.createdAt).toBeDefined()
    expect(fields.updatedAt).toBeDefined()
    expect(fields.deactivatedAt).toBeDefined()

    // Required fields should be NonNull
    expect(isNonNullType(fields.id.type)).toBe(true)
    expect(isNonNullType(fields.name.type)).toBe(true)

    // Optional field should be nullable
    expect(isNonNullType(fields.deactivatedAt.type)).toBe(false)
  })
})
