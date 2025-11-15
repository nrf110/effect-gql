import { Effect } from "effect/Effect"
import * as S from "effect/Schema"
import * as AST from "effect/SchemaAST"
import {
  GraphQLObjectType,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLNonNull,
  GraphQLList,
  GraphQLOutputType,
  GraphQLInputObjectType,
  GraphQLInputType,
  GraphQLFieldConfigMap,
  GraphQLFieldConfigArgumentMap,
} from "graphql"

/**
 * Convert an Effect Schema to a GraphQL output type
 */
export const toGraphQLType = (schema: S.Schema<any, any, any>): GraphQLOutputType => {
  const ast = schema.ast

  // Handle primitives
  if (ast._tag === "StringKeyword") return GraphQLString
  if (ast._tag === "NumberKeyword") return GraphQLFloat
  if (ast._tag === "BooleanKeyword") return GraphQLBoolean

  // Handle literals
  if (ast._tag === "Literal") {
    if (typeof ast.literal === "string") return GraphQLString
    if (typeof ast.literal === "number") return GraphQLFloat
    if (typeof ast.literal === "boolean") return GraphQLBoolean
  }

  // Handle arrays - check for TupleType
  if (ast._tag === "TupleType") {
    const elements = ast.elements
    if (elements.length > 0) {
      const elementSchema = S.make(elements[0].type)
      return new GraphQLList(toGraphQLType(elementSchema))
    }
  }

  // Handle structs/objects
  if (ast._tag === "TypeLiteral") {
    const fields: GraphQLFieldConfigMap<any, any> = {}
    
    for (const field of ast.propertySignatures) {
      const fieldName = String(field.name)
      const fieldSchema = S.make(field.type)
      let fieldType = toGraphQLType(fieldSchema)
      
      // Make non-optional fields non-null
      if (!field.isOptional) {
        fieldType = new GraphQLNonNull(fieldType)
      }
      
      fields[fieldName] = { type: fieldType }
    }

    // Generate a name from the schema or use a default
    const typeName = (schema as any).annotations?.identifier || `Object_${Math.random().toString(36).substr(2, 9)}`
    
    return new GraphQLObjectType({
      name: typeName,
      fields,
    })
  }

  // Handle transformations - use the "to" side
  if (ast._tag === "Transformation") {
    return toGraphQLType(S.make(ast.to))
  }

  // Handle unions (use first type as fallback)
  if (ast._tag === "Union") {
    const types = ast.types
    if (types.length > 0) {
      return toGraphQLType(S.make(types[0]))
    }
  }

  // Default fallback
  return GraphQLString
}

/**
 * Convert an Effect Schema to a GraphQL input type
 */
export const toGraphQLInputType = (schema: S.Schema<any, any, any>): GraphQLInputType => {
  const ast = schema.ast

  // Handle primitives
  if (ast._tag === "StringKeyword") return GraphQLString
  if (ast._tag === "NumberKeyword") return GraphQLFloat
  if (ast._tag === "BooleanKeyword") return GraphQLBoolean

  // Handle literals
  if (ast._tag === "Literal") {
    if (typeof ast.literal === "string") return GraphQLString
    if (typeof ast.literal === "number") return GraphQLFloat
    if (typeof ast.literal === "boolean") return GraphQLBoolean
  }

  // Handle arrays
  if (ast._tag === "TupleType") {
    const elements = ast.elements
    if (elements.length > 0) {
      const elementSchema = S.make(elements[0].type)
      return new GraphQLList(toGraphQLInputType(elementSchema))
    }
  }

  // Handle structs/objects as input types
  if (ast._tag === "TypeLiteral") {
    const fields: Record<string, { type: GraphQLInputType }> = {}
    
    for (const field of ast.propertySignatures) {
      const fieldName = String(field.name)
      const fieldSchema = S.make(field.type)
      let fieldType = toGraphQLInputType(fieldSchema)
      
      // Make non-optional fields non-null
      if (!field.isOptional) {
        fieldType = new GraphQLNonNull(fieldType)
      }
      
      fields[fieldName] = { type: fieldType }
    }

    const typeName = (schema as any).annotations?.identifier || `Input_${Math.random().toString(36).substr(2, 9)}`
    
    return new GraphQLInputObjectType({
      name: typeName,
      fields,
    })
  }

  // Handle transformations - use the "from" side for input
  if (ast._tag === "Transformation") {
    return toGraphQLInputType(S.make(ast.from))
  }

  // Handle unions (use first type as fallback)
  if (ast._tag === "Union") {
    const types = ast.types
    if (types.length > 0) {
      return toGraphQLInputType(S.make(types[0]))
    }
  }

  // Default fallback
  return GraphQLString
}

/**
 * Additional field configuration for computed/relational fields
 */
export interface AdditionalField<Parent, Args, R, E, A> {
  type: GraphQLOutputType
  args?: GraphQLFieldConfigArgumentMap
  description?: string
  resolve: (parent: Parent, args: Args) => Effect.Effect<A, E, R>
}

/**
 * Create a GraphQL Object Type from an Effect Schema with a name
 * Optionally add computed/relational fields with resolvers
 */
export const toGraphQLObjectType = <T>(
  name: string,
  schema: S.Schema<any, any, any>,
  additionalFields?: Record<string, AdditionalField<T, any, any, any, any>>
): GraphQLObjectType => {
  const ast = schema.ast
  
  if (ast._tag === "TypeLiteral") {
    const fields: GraphQLFieldConfigMap<any, any> = {}
    
    // Add fields from schema
    for (const field of ast.propertySignatures) {
      const fieldName = String(field.name)
      const fieldSchema = S.make(field.type)
      let fieldType = toGraphQLType(fieldSchema)
      
      // Make non-optional fields non-null
      if (!field.isOptional) {
        fieldType = new GraphQLNonNull(fieldType)
      }
      
      fields[fieldName] = { type: fieldType }
    }
    
    // Add additional computed/relational fields
    if (additionalFields) {
      for (const [fieldName, fieldConfig] of Object.entries(additionalFields)) {
        fields[fieldName] = {
          type: fieldConfig.type,
          args: fieldConfig.args,
          description: fieldConfig.description,
          // Note: resolve will be set later when runtime is available
          resolve: fieldConfig.resolve as any,
        }
      }
    }
    
    return new GraphQLObjectType({
      name,
      fields,
    })
  }
  
  throw new Error(`Schema must be an object type to convert to GraphQLObjectType`)
}

/**
 * Convert an Effect Schema to GraphQL arguments
 */
export const toGraphQLArgs = (
  schema: S.Schema<any, any, any>
): GraphQLFieldConfigArgumentMap => {
  const ast = schema.ast
  
  if (ast._tag === "TypeLiteral") {
    const args: GraphQLFieldConfigArgumentMap = {}
    
    for (const field of ast.propertySignatures) {
      const fieldName = String(field.name)
      const fieldSchema = S.make(field.type)
      let fieldType = toGraphQLInputType(fieldSchema)
      
      // Make non-optional fields non-null
      if (!field.isOptional) {
        fieldType = new GraphQLNonNull(fieldType)
      }
      
      args[fieldName] = { type: fieldType }
    }
    
    return args
  }
  
  throw new Error(`Schema must be an object type to convert to GraphQL arguments`)
}
