import { describe, it, expect } from "vitest"
import * as S from "effect/Schema"
import {
  GraphQLInt,
  GraphQLInputObjectType,
  GraphQLObjectType,
  GraphQLString,
  isNonNullType,
} from "graphql"
import { toGraphQLInputType, toGraphQLType, toGraphQLArgs } from "../../src/schema-mapping"

// Helper to unwrap NonNull types
const unwrapNonNull = (type: any): any => (isNonNullType(type) ? type.ofType : type)

describe("User reported issues with schema mapping", () => {
  describe("Integer type refinements", () => {
    it("should map non-negative integers to GraphQLInt (not Float)", () => {
      const result = toGraphQLInputType(S.Int.check(S.isGreaterThanOrEqualTo(0)))
      expect(result).toBe(GraphQLInt)
    })

    it("should map positive integers to GraphQLInt", () => {
      const PositiveInt = S.Int.check(S.isGreaterThan(0))
      const result = toGraphQLInputType(PositiveInt)
      expect(result).toBe(GraphQLInt)
    })

    it("should map non-positive integers to GraphQLInt", () => {
      const NonPositiveInt = S.Int.check(S.isLessThanOrEqualTo(0))
      const result = toGraphQLInputType(NonPositiveInt)
      expect(result).toBe(GraphQLInt)
    })

    it("should map negative integers to GraphQLInt", () => {
      const NegativeInt = S.Int.check(S.isLessThan(0))
      const result = toGraphQLInputType(NegativeInt)
      expect(result).toBe(GraphQLInt)
    })

    it("should map custom int refinements to GraphQLInt", () => {
      const CustomInt = S.Int.check(S.isGreaterThan(0), S.isLessThan(100))
      const result = toGraphQLInputType(CustomInt)
      expect(result).toBe(GraphQLInt)
    })
  })

  describe("Option transformations in struct fields", () => {
    it("should map S.OptionFromNullOr(S.Int) fields to nullable Int (not Int!)", () => {
      const Cursor = S.Struct({
        pageSize: S.Int.check(S.isGreaterThanOrEqualTo(0)),
        offset: S.OptionFromNullOr(S.Int),
      })

      const result = toGraphQLInputType(Cursor) as GraphQLInputObjectType
      const fields = result.getFields()

      // pageSize should be NonNull Int
      expect(isNonNullType(fields.pageSize.type)).toBe(true)
      expect(unwrapNonNull(fields.pageSize.type)).toBe(GraphQLInt)

      // offset should be nullable Int (not wrapped in NonNull)
      expect(isNonNullType(fields.offset.type)).toBe(false)
      expect(fields.offset.type).toBe(GraphQLInt)
    })

    it("should handle OptionFromNullOr in output types", () => {
      const User = S.Struct({
        id: S.String,
        age: S.OptionFromNullOr(S.Int.check(S.isGreaterThanOrEqualTo(0))),
      })

      const result = toGraphQLType(User) as GraphQLObjectType
      const fields = result.getFields()

      // id should be NonNull String
      expect(isNonNullType(fields.id.type)).toBe(true)
      expect(unwrapNonNull(fields.id.type)).toBe(GraphQLString)

      // age should be nullable Int
      expect(isNonNullType(fields.age.type)).toBe(false)
      expect(fields.age.type).toBe(GraphQLInt)
    })

    it("should handle OptionFromNullOr in GraphQL arguments", () => {
      const Args = S.Struct({
        limit: S.Int.check(S.isGreaterThanOrEqualTo(0)),
        cursor: S.OptionFromNullOr(S.String),
      })

      const result = toGraphQLArgs(Args)

      // limit should be NonNull Int
      expect(isNonNullType(result.limit.type)).toBe(true)
      expect(unwrapNonNull(result.limit.type)).toBe(GraphQLInt)

      // cursor should be nullable String
      expect(isNonNullType(result.cursor.type)).toBe(false)
      expect(result.cursor.type).toBe(GraphQLString)
    })

    it("should handle OptionFromUndefinedOr in struct fields", () => {
      const Schema = S.Struct({
        required: S.String,
        optional: S.OptionFromUndefinedOr(S.Int.check(S.isGreaterThanOrEqualTo(0))),
      })

      const result = toGraphQLInputType(Schema) as GraphQLInputObjectType
      const fields = result.getFields()

      // required should be NonNull String
      expect(isNonNullType(fields.required.type)).toBe(true)

      // optional should be nullable Int
      expect(isNonNullType(fields.optional.type)).toBe(false)
      expect(fields.optional.type).toBe(GraphQLInt)
    })
  })

  describe("Combined refinements and options", () => {
    it("should handle the exact user-reported schema", () => {
      const Cursor = S.Struct({
        pageSize: S.Int.check(S.isGreaterThanOrEqualTo(0)),
        offset: S.OptionFromNullOr(S.Int),
      })

      // Test the base Cursor struct
      const result = toGraphQLInputType(Cursor) as GraphQLInputObjectType
      const fields = result.getFields()

      expect(fields.pageSize).toBeDefined()
      expect(isNonNullType(fields.pageSize.type)).toBe(true)
      expect(unwrapNonNull(fields.pageSize.type)).toBe(GraphQLInt)

      expect(fields.offset).toBeDefined()
      expect(isNonNullType(fields.offset.type)).toBe(false)
      expect(fields.offset.type).toBe(GraphQLInt)
    })
  })
})
