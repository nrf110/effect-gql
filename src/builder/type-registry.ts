import * as S from "effect/Schema"
import * as AST from "effect/SchemaAST"
import {
  GraphQLObjectType,
  GraphQLInterfaceType,
  GraphQLEnumType,
  GraphQLUnionType,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLFieldConfigMap,
  GraphQLInputFieldConfigMap,
} from "graphql"
import { toGraphQLType, toGraphQLArgs, toGraphQLInputType } from "../schema-mapping"
import type {
  TypeRegistration,
  InterfaceRegistration,
  EnumRegistration,
  UnionRegistration,
  InputTypeRegistration,
} from "./types"

/**
 * Extract type name from a schema if it has one.
 * Supports:
 * - S.TaggedStruct("Name", {...}) - extracts from _tag literal
 * - S.TaggedClass()("Name", {...}) - extracts from identifier annotation
 * - S.Class<T>("Name")({...}) - extracts from identifier annotation
 */
export function getSchemaName(schema: S.Schema<any, any, any>): string | undefined {
  const ast = schema.ast

  // Handle Transformation (Schema.Class, TaggedClass)
  if (ast._tag === "Transformation") {
    const identifier = AST.getIdentifierAnnotation((ast as any).to)
    if (identifier._tag === "Some") {
      return identifier.value
    }
  }

  // Handle TypeLiteral (TaggedStruct)
  if (ast._tag === "TypeLiteral") {
    const tagProp = (ast as any).propertySignatures.find(
      (p: any) => String(p.name) === "_tag"
    )
    if (tagProp && tagProp.type._tag === "Literal" && typeof tagProp.type.literal === "string") {
      return tagProp.type.literal
    }
  }

  return undefined
}

/**
 * Context needed for type conversion operations
 */
export interface TypeConversionContext {
  types: Map<string, TypeRegistration>
  interfaces: Map<string, InterfaceRegistration>
  enums: Map<string, EnumRegistration>
  unions: Map<string, UnionRegistration>
  inputs: Map<string, InputTypeRegistration>
  typeRegistry: Map<string, GraphQLObjectType>
  interfaceRegistry: Map<string, GraphQLInterfaceType>
  enumRegistry: Map<string, GraphQLEnumType>
  unionRegistry: Map<string, GraphQLUnionType>
  inputRegistry: Map<string, GraphQLInputObjectType>
}

/**
 * Convert schema to GraphQL type, checking registry first for registered types
 */
export function toGraphQLTypeWithRegistry(
  schema: S.Schema<any, any, any>,
  ctx: TypeConversionContext
): any {
  const ast = schema.ast

  // Check registered object types first
  const registeredType = findRegisteredType(schema, ast, ctx)
  if (registeredType) return registeredType

  // Check registered interfaces
  const registeredInterface = findRegisteredInterface(schema, ast, ctx)
  if (registeredInterface) return registeredInterface

  // Handle transformations (like S.Array, S.optional, etc)
  if (ast._tag === "Transformation") {
    return handleTransformationAST(ast, ctx)
  }

  // Handle unions (enum literals or object type unions)
  if (ast._tag === "Union") {
    return handleUnionAST(ast, ctx)
  }

  // Check single literal for enum match
  if (ast._tag === "Literal") {
    const enumType = findEnumForLiteral(ast, ctx)
    if (enumType) return enumType
  }

  // Handle tuple types (readonly arrays)
  if (ast._tag === "TupleType") {
    return handleTupleTypeAST(ast, ctx)
  }

  // Handle Suspend (recursive/self-referential schemas)
  if (ast._tag === "Suspend") {
    const innerAst = (ast as any).f()
    return toGraphQLTypeWithRegistry(S.make(innerAst), ctx)
  }

  // Fall back to default conversion
  return toGraphQLType(schema)
}

/**
 * Find a registered object type matching this schema
 */
function findRegisteredType(
  schema: S.Schema<any, any, any>,
  ast: AST.AST,
  ctx: TypeConversionContext
): GraphQLObjectType | undefined {
  for (const [typeName, typeReg] of ctx.types) {
    if (typeReg.schema === schema || typeReg.schema.ast === ast) {
      return ctx.typeRegistry.get(typeName)
    }
  }
  return undefined
}

/**
 * Find a registered interface matching this schema
 */
function findRegisteredInterface(
  schema: S.Schema<any, any, any>,
  ast: AST.AST,
  ctx: TypeConversionContext
): GraphQLInterfaceType | undefined {
  for (const [interfaceName, interfaceReg] of ctx.interfaces) {
    if (interfaceReg.schema === schema || interfaceReg.schema.ast === ast) {
      return ctx.interfaceRegistry.get(interfaceName)
    }
  }
  return undefined
}

/**
 * Handle Transformation AST nodes (arrays, optional, Schema.Class, etc.)
 */
function handleTransformationAST(ast: any, ctx: TypeConversionContext): any {
  const toAst = ast.to

  // Check if it's an array (readonly array on the to side)
  if (toAst._tag === "TupleType") {
    if (toAst.rest && toAst.rest.length > 0) {
      const elementSchema = S.make(toAst.rest[0].type)
      const elementType = toGraphQLTypeWithRegistry(elementSchema, ctx)
      return new GraphQLList(elementType)
    } else if (toAst.elements.length > 0) {
      const elementSchema = S.make(toAst.elements[0].type)
      const elementType = toGraphQLTypeWithRegistry(elementSchema, ctx)
      return new GraphQLList(elementType)
    }
  }

  // Other transformations - recurse on the "to" side
  return toGraphQLTypeWithRegistry(S.make(ast.to), ctx)
}

/**
 * Handle Union AST nodes (literal enums or object type unions)
 */
function handleUnionAST(ast: any, ctx: TypeConversionContext): any {
  const allLiterals = ast.types.every((t: any) => t._tag === "Literal")

  if (allLiterals) {
    // This might be an enum
    const enumType = findEnumForLiteralUnion(ast.types, ctx)
    if (enumType) return enumType
  } else {
    // This is a Union of object types - check if it matches a registered union
    const unionType = findRegisteredUnion(ast.types, ctx)
    if (unionType) return unionType
  }

  // Fallback: use first type
  if (ast.types.length > 0) {
    return toGraphQLTypeWithRegistry(S.make(ast.types[0]), ctx)
  }

  return toGraphQLType(S.make(ast))
}

/**
 * Find a registered enum matching a union of literals
 */
function findEnumForLiteralUnion(
  types: any[],
  ctx: TypeConversionContext
): GraphQLEnumType | undefined {
  const literalValues = types.map((t: any) => String(t.literal)).sort()

  for (const [enumName, enumReg] of ctx.enums) {
    const enumValues = [...enumReg.values].sort()
    if (literalValues.length === enumValues.length &&
        literalValues.every((v: string, i: number) => v === enumValues[i])) {
      return ctx.enumRegistry.get(enumName)
    }
  }
  return undefined
}

/**
 * Find a registered union matching an object type union
 */
function findRegisteredUnion(
  types: any[],
  ctx: TypeConversionContext
): GraphQLUnionType | undefined {
  // Collect _tag values from each union member
  const memberTags: string[] = []
  for (const memberAst of types) {
    if (memberAst._tag === "TypeLiteral") {
      const tagProp = memberAst.propertySignatures.find(
        (p: any) => String(p.name) === "_tag"
      )
      if (tagProp && tagProp.type._tag === "Literal") {
        memberTags.push(String(tagProp.type.literal))
      }
    }
  }

  // Check if any registered union has matching types
  if (memberTags.length === types.length) {
    for (const [unionName, unionReg] of ctx.unions) {
      const unionTypes = [...unionReg.types].sort()
      const sortedTags = [...memberTags].sort()
      if (sortedTags.length === unionTypes.length &&
          sortedTags.every((tag, i) => tag === unionTypes[i])) {
        return ctx.unionRegistry.get(unionName)
      }
    }
  }
  return undefined
}

/**
 * Find a registered enum containing a single literal value
 */
function findEnumForLiteral(
  ast: any,
  ctx: TypeConversionContext
): GraphQLEnumType | undefined {
  const literalValue = String(ast.literal)
  for (const [enumName, enumReg] of ctx.enums) {
    if (enumReg.values.includes(literalValue)) {
      return ctx.enumRegistry.get(enumName)
    }
  }
  return undefined
}

/**
 * Handle TupleType AST nodes (arrays)
 */
function handleTupleTypeAST(ast: any, ctx: TypeConversionContext): any {
  if (ast.rest && ast.rest.length > 0) {
    const elementSchema = S.make(ast.rest[0].type)
    const elementType = toGraphQLTypeWithRegistry(elementSchema, ctx)
    return new GraphQLList(elementType)
  } else if (ast.elements && ast.elements.length > 0) {
    const elementSchema = S.make(ast.elements[0].type)
    const elementType = toGraphQLTypeWithRegistry(elementSchema, ctx)
    return new GraphQLList(elementType)
  }
  return toGraphQLType(S.make(ast))
}

/**
 * Convert a schema to GraphQL fields
 */
export function schemaToFields(
  schema: S.Schema<any, any, any>,
  ctx: TypeConversionContext
): GraphQLFieldConfigMap<any, any> {
  let ast = schema.ast

  // Handle Transformation (Schema.Class, TaggedClass)
  if (ast._tag === "Transformation") {
    ast = (ast as any).to
  }

  // Handle Declaration (Schema.Class wraps TypeLiteral in Declaration)
  if (ast._tag === "Declaration") {
    const typeParams = (ast as any).typeParameters
    if (typeParams && typeParams.length > 0 && typeParams[0]._tag === "TypeLiteral") {
      ast = typeParams[0]
    }
  }

  if (ast._tag === "TypeLiteral") {
    const fields: GraphQLFieldConfigMap<any, any> = {}

    for (const field of (ast as any).propertySignatures) {
      const fieldName = String(field.name)
      const fieldSchema = S.make(field.type)
      let fieldType = toGraphQLTypeWithRegistry(fieldSchema, ctx)

      // Make non-optional fields non-null
      if (!field.isOptional) {
        fieldType = new GraphQLNonNull(fieldType)
      }

      fields[fieldName] = { type: fieldType }
    }

    return fields
  }

  return {}
}

/**
 * Convert a schema to GraphQL input fields
 */
export function schemaToInputFields(
  schema: S.Schema<any, any, any>,
  enumRegistry: Map<string, GraphQLEnumType>,
  inputRegistry: Map<string, GraphQLInputObjectType>,
  inputs: Map<string, InputTypeRegistration>,
  enums: Map<string, EnumRegistration>
): GraphQLInputFieldConfigMap {
  const ast = schema.ast

  if (ast._tag === "TypeLiteral") {
    const fields: GraphQLInputFieldConfigMap = {}

    for (const field of ast.propertySignatures) {
      const fieldName = String(field.name)
      const fieldSchema = S.make(field.type)
      let fieldType = toGraphQLInputTypeWithRegistry(
        fieldSchema,
        enumRegistry,
        inputRegistry,
        inputs,
        enums
      )

      // Make non-optional fields non-null
      if (!field.isOptional) {
        fieldType = new GraphQLNonNull(fieldType)
      }

      fields[fieldName] = { type: fieldType }
    }

    return fields
  }

  return {}
}

/**
 * Convert a schema to GraphQL input type, checking enum and input registries
 */
export function toGraphQLInputTypeWithRegistry(
  schema: S.Schema<any, any, any>,
  enumRegistry: Map<string, GraphQLEnumType>,
  inputRegistry: Map<string, GraphQLInputObjectType>,
  inputs: Map<string, InputTypeRegistration>,
  enums: Map<string, EnumRegistration>
): any {
  const ast = schema.ast

  // Handle transformations (like S.optional wrapping)
  if (ast._tag === "Transformation") {
    const toAst = (ast as any).to
    return toGraphQLInputTypeWithRegistry(S.make(toAst), enumRegistry, inputRegistry, inputs, enums)
  }

  // Check if this schema matches a registered input type
  for (const [inputName, inputReg] of inputs) {
    if (inputReg.schema.ast === ast || inputReg.schema === schema) {
      const result = inputRegistry.get(inputName)
      if (result) return result
    }
  }

  // Check if this schema matches a registered enum
  if (ast._tag === "Union") {
    const unionAst = ast as any

    // Handle S.optional which creates Union(LiteralUnion, UndefinedKeyword)
    const nonUndefinedTypes = unionAst.types.filter((t: any) => t._tag !== "UndefinedKeyword")
    if (nonUndefinedTypes.length === 1 && nonUndefinedTypes[0]._tag === "Union") {
      return toGraphQLInputTypeWithRegistry(
        S.make(nonUndefinedTypes[0]),
        enumRegistry,
        inputRegistry,
        inputs,
        enums
      )
    }

    // Check for nested input type inside optional
    if (nonUndefinedTypes.length === 1 && nonUndefinedTypes[0]._tag === "TypeLiteral") {
      return toGraphQLInputTypeWithRegistry(
        S.make(nonUndefinedTypes[0]),
        enumRegistry,
        inputRegistry,
        inputs,
        enums
      )
    }

    const allLiterals = unionAst.types.every((t: any) => t._tag === "Literal")

    if (allLiterals) {
      const literalValues = unionAst.types.map((t: any) => String(t.literal)).sort()

      for (const [enumName, enumReg] of enums) {
        const enumValues = [...enumReg.values].sort()
        if (literalValues.length === enumValues.length &&
            literalValues.every((v: string, i: number) => v === enumValues[i])) {
          const result = enumRegistry.get(enumName)
          if (result) return result
        }
      }
    }
  }

  // Check single literal
  if (ast._tag === "Literal") {
    const literalValue = String((ast as any).literal)
    for (const [enumName, enumReg] of enums) {
      if (enumReg.values.includes(literalValue)) {
        const result = enumRegistry.get(enumName)
        if (result) return result
      }
    }
  }

  // Handle Suspend (recursive/self-referential schemas)
  if (ast._tag === "Suspend") {
    const innerAst = (ast as any).f()
    return toGraphQLInputTypeWithRegistry(S.make(innerAst), enumRegistry, inputRegistry, inputs, enums)
  }

  // Fall back to default toGraphQLInputType
  return toGraphQLInputType(schema)
}

/**
 * Convert a schema to GraphQL arguments with registry support
 */
export function toGraphQLArgsWithRegistry(
  schema: S.Schema<any, any, any>,
  enumRegistry: Map<string, GraphQLEnumType>,
  inputRegistry: Map<string, GraphQLInputObjectType>,
  inputs: Map<string, InputTypeRegistration>,
  enums: Map<string, EnumRegistration>
): any {
  const ast = schema.ast

  if (ast._tag === "TypeLiteral") {
    const args: Record<string, { type: any }> = {}

    for (const field of (ast as any).propertySignatures) {
      const fieldName = String(field.name)
      const fieldSchema = S.make(field.type)
      let fieldType = toGraphQLInputTypeWithRegistry(
        fieldSchema,
        enumRegistry,
        inputRegistry,
        inputs,
        enums
      )

      // Make non-optional fields non-null
      if (!field.isOptional) {
        fieldType = new GraphQLNonNull(fieldType)
      }

      args[fieldName] = { type: fieldType }
    }

    return args
  }

  // Fall back to default toGraphQLArgs
  return toGraphQLArgs(schema)
}
