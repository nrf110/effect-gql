import {
  graphql,
  GraphQLSchema,
  printSchema,
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLEnumType,
  GraphQLUnionType,
  GraphQLInterfaceType,
  GraphQLType,
  GraphQLNonNull,
  GraphQLList,
  isNonNullType,
  isListType,
  isNamedType,
} from "graphql"
import { Effect, Layer, Runtime } from "effect"
import type { GraphQLEffectContext } from "../../src/builder/types"

/**
 * Execute a GraphQL query against a schema with a test layer
 */
export const executeGraphQL = async <R>(
  schema: GraphQLSchema,
  query: string,
  layer: Layer.Layer<R, never, never>,
  variables?: Record<string, unknown>,
  operationName?: string
): Promise<{ data?: unknown; errors?: readonly { message: string }[] }> => {
  const runtime = await Effect.runPromise(Effect.scoped(Layer.toRuntime(layer)))

  return graphql({
    schema,
    source: query,
    variableValues: variables,
    operationName,
    contextValue: { runtime } satisfies GraphQLEffectContext<R>,
  })
}

/**
 * Execute a GraphQL query without layer requirements
 */
export const executeGraphQLNoLayer = async (
  schema: GraphQLSchema,
  query: string,
  variables?: Record<string, unknown>
): Promise<{ data?: unknown; errors?: readonly { message: string }[] }> => {
  const runtime = Runtime.defaultRuntime

  return graphql({
    schema,
    source: query,
    variableValues: variables,
    contextValue: { runtime } satisfies GraphQLEffectContext<never>,
  })
}

/**
 * Assert schema contains expected type
 */
export const assertSchemaHasType = (schema: GraphQLSchema, typeName: string): void => {
  const type = schema.getType(typeName)
  if (!type) {
    throw new Error(`Schema does not contain type: ${typeName}`)
  }
}

/**
 * Assert schema has query type with field
 */
export const assertSchemaHasQueryField = (schema: GraphQLSchema, fieldName: string): void => {
  const queryType = schema.getQueryType()
  if (!queryType) {
    throw new Error("Schema does not have a Query type")
  }
  const fields = queryType.getFields()
  if (!fields[fieldName]) {
    throw new Error(`Query type does not have field: ${fieldName}`)
  }
}

/**
 * Assert schema has mutation type with field
 */
export const assertSchemaHasMutationField = (schema: GraphQLSchema, fieldName: string): void => {
  const mutationType = schema.getMutationType()
  if (!mutationType) {
    throw new Error("Schema does not have a Mutation type")
  }
  const fields = mutationType.getFields()
  if (!fields[fieldName]) {
    throw new Error(`Mutation type does not have field: ${fieldName}`)
  }
}

/**
 * Assert schema has subscription type with field
 */
export const assertSchemaHasSubscriptionField = (
  schema: GraphQLSchema,
  fieldName: string
): void => {
  const subscriptionType = schema.getSubscriptionType()
  if (!subscriptionType) {
    throw new Error("Schema does not have a Subscription type")
  }
  const fields = subscriptionType.getFields()
  if (!fields[fieldName]) {
    throw new Error(`Subscription type does not have field: ${fieldName}`)
  }
}

/**
 * Get SDL representation for debugging
 */
export const getSchemaSDL = (schema: GraphQLSchema): string => printSchema(schema)

/**
 * Get the Query type from schema
 */
export const getQueryType = (schema: GraphQLSchema): GraphQLObjectType => {
  const queryType = schema.getQueryType()
  if (!queryType) {
    throw new Error("Schema does not have a Query type")
  }
  return queryType
}

/**
 * Get a specific type from schema
 */
export const getType = (schema: GraphQLSchema, typeName: string): GraphQLType => {
  const type = schema.getType(typeName)
  if (!type) {
    throw new Error(`Type "${typeName}" not found in schema`)
  }
  return type
}

/**
 * Get object type from schema
 */
export const getObjectType = (schema: GraphQLSchema, typeName: string): GraphQLObjectType => {
  const type = getType(schema, typeName)
  if (!(type instanceof GraphQLObjectType)) {
    throw new Error(`Type "${typeName}" is not an object type`)
  }
  return type
}

/**
 * Get input type from schema
 */
export const getInputType = (schema: GraphQLSchema, typeName: string): GraphQLInputObjectType => {
  const type = getType(schema, typeName)
  if (!(type instanceof GraphQLInputObjectType)) {
    throw new Error(`Type "${typeName}" is not an input type`)
  }
  return type
}

/**
 * Get enum type from schema
 */
export const getEnumType = (schema: GraphQLSchema, typeName: string): GraphQLEnumType => {
  const type = getType(schema, typeName)
  if (!(type instanceof GraphQLEnumType)) {
    throw new Error(`Type "${typeName}" is not an enum type`)
  }
  return type
}

/**
 * Get union type from schema
 */
export const getUnionType = (schema: GraphQLSchema, typeName: string): GraphQLUnionType => {
  const type = getType(schema, typeName)
  if (!(type instanceof GraphQLUnionType)) {
    throw new Error(`Type "${typeName}" is not a union type`)
  }
  return type
}

/**
 * Get interface type from schema
 */
export const getInterfaceType = (schema: GraphQLSchema, typeName: string): GraphQLInterfaceType => {
  const type = getType(schema, typeName)
  if (!(type instanceof GraphQLInterfaceType)) {
    throw new Error(`Type "${typeName}" is not an interface type`)
  }
  return type
}

/**
 * Unwrap NonNull and List wrappers to get the named type
 */
export const unwrapType = (type: GraphQLType): GraphQLType => {
  if (isNonNullType(type)) {
    return unwrapType(type.ofType)
  }
  if (isListType(type)) {
    return unwrapType(type.ofType)
  }
  return type
}

/**
 * Check if a type is wrapped in NonNull
 */
export const isNonNull = (type: GraphQLType): boolean => isNonNullType(type)

/**
 * Check if a type is a List (possibly wrapped in NonNull)
 */
export const isList = (type: GraphQLType): boolean => {
  if (isNonNullType(type)) {
    return isListType(type.ofType)
  }
  return isListType(type)
}

/**
 * Get the name of a type (unwrapping NonNull and List)
 */
export const getTypeName = (type: GraphQLType): string => {
  const unwrapped = unwrapType(type)
  if (isNamedType(unwrapped)) {
    return unwrapped.name
  }
  throw new Error("Type does not have a name")
}
