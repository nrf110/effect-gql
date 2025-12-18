import { Effect, Layer, Runtime, Pipeable } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchema, GraphQLObjectType, GraphQLFieldConfigMap, GraphQLFieldConfig, GraphQLList, graphql } from "graphql"
import { toGraphQLType, toGraphQLArgs } from "./schema-mapping"

/**
 * Configuration for a query or mutation field
 */
interface FieldRegistration<Args = any, A = any, E = any, R = any> {
  type: S.Schema<A, any, any>
  args?: S.Schema<Args, any, any>
  description?: string
  resolve: (args: Args) => Effect.Effect<A, E, R>
}

/**
 * Configuration for an object type
 */
interface TypeRegistration {
  name: string
  schema: S.Schema<any, any, any>
}

/**
 * Configuration for a field on an object type
 */
interface ObjectFieldRegistration<Parent = any, Args = any, A = any, E = any, R = any> {
  type: S.Schema<A, any, any>
  args?: S.Schema<Args, any, any>
  description?: string
  resolve: (parent: Parent, args: Args) => Effect.Effect<A, E, R>
}

/**
 * GraphQL context that contains the Effect runtime
 */
export interface GraphQLEffectContext<R> {
  runtime: Runtime.Runtime<R>
}

/**
 * GraphQL Schema Builder with type-safe service requirements (Layer-per-Request Pattern)
 *
 * The type parameter R accumulates all service requirements from resolvers.
 * Unlike the runtime-in-context approach, this pattern builds the schema without
 * executing any Effects. At request time, you provide a Layer with all required services.
 *
 * This allows for:
 * - Request-scoped dependencies (auth, request context, etc.)
 * - Dynamic service provision
 * - Better testing (mock different services per request)
 */
export class GraphQLSchemaBuilder<R = never> implements Pipeable.Pipeable {
  private constructor(
    private readonly types: Map<string, TypeRegistration>,
    private readonly queries: Map<string, FieldRegistration>,
    private readonly mutations: Map<string, FieldRegistration>,
    private readonly objectFields: Map<string, Map<string, ObjectFieldRegistration>>
  ) {}

  /**
   * Pipeable interface implementation - enables fluent .pipe() syntax
   */
  pipe<A>(this: A): A
  pipe<A, B>(this: A, ab: (a: A) => B): B
  pipe<A, B, C>(this: A, ab: (a: A) => B, bc: (b: B) => C): C
  pipe<A, B, C, D>(this: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D): D
  pipe<A, B, C, D, E>(this: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E): E
  pipe<A, B, C, D, E, F>(this: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F): F
  pipe<A, B, C, D, E, F, G>(this: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F, fg: (f: F) => G): G
  pipe<A, B, C, D, E, F, G, H>(this: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F, fg: (f: F) => G, gh: (g: G) => H): H
  pipe<A, B, C, D, E, F, G, H, I>(this: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F, fg: (f: F) => G, gh: (g: G) => H, hi: (h: H) => I): I
  pipe() {
    return Pipeable.pipeArguments(this, arguments)
  }

  /**
   * Create an empty schema builder
   */
  static readonly empty = new GraphQLSchemaBuilder<never>(
    new Map(),
    new Map(),
    new Map(),
    new Map()
  )

  /**
   * Add a query field
   */
  query<A, E, R2, Args = void>(
    name: string,
    config: {
      type: S.Schema<A, any, any>
      args?: S.Schema<Args, any, any>
      description?: string
      resolve: (args: Args) => Effect.Effect<A, E, R2>
    }
  ): GraphQLSchemaBuilder<R | R2> {
    const newQueries = new Map(this.queries)
    newQueries.set(name, config)
    return new GraphQLSchemaBuilder(
      this.types,
      newQueries,
      this.mutations,
      this.objectFields
    ) as any
  }

  /**
   * Add a mutation field
   */
  mutation<A, E, R2, Args = void>(
    name: string,
    config: {
      type: S.Schema<A, any, any>
      args?: S.Schema<Args, any, any>
      description?: string
      resolve: (args: Args) => Effect.Effect<A, E, R2>
    }
  ): GraphQLSchemaBuilder<R | R2> {
    const newMutations = new Map(this.mutations)
    newMutations.set(name, config)
    return new GraphQLSchemaBuilder(
      this.types,
      this.queries,
      newMutations,
      this.objectFields
    ) as any
  }

  /**
   * Register an object type from a schema
   *
   * @param name - The GraphQL type name
   * @param schema - The Effect Schema for this type
   * @param fields - Optional additional/computed fields for this type
   */
  objectType<A, R2 = never>(
    name: string,
    schema: S.Schema<A, any, any>,
    fields?: Record<string, {
      type: S.Schema<any, any, any>
      args?: S.Schema<any, any, any>
      description?: string
      resolve: (parent: A, args: any) => Effect.Effect<any, any, any>
    }>
  ): GraphQLSchemaBuilder<R | R2> {
    const newTypes = new Map(this.types)
    newTypes.set(name, { name, schema })

    // If fields are provided, add them
    let newObjectFields = this.objectFields
    if (fields) {
      newObjectFields = new Map(this.objectFields)
      const typeFields = new Map<string, ObjectFieldRegistration>()

      for (const [fieldName, fieldConfig] of Object.entries(fields)) {
        typeFields.set(fieldName, fieldConfig as ObjectFieldRegistration)
      }

      newObjectFields.set(name, typeFields)
    }

    return new GraphQLSchemaBuilder(
      newTypes,
      this.queries,
      this.mutations,
      newObjectFields
    ) as any
  }

  /**
   * Add a computed/relational field to an object type
   */
  field<Parent, A, E, R2, Args = void>(
    typeName: string,
    fieldName: string,
    config: {
      type: S.Schema<A, any, any>
      args?: S.Schema<Args, any, any>
      description?: string
      resolve: (parent: Parent, args: Args) => Effect.Effect<A, E, R2>
    }
  ): GraphQLSchemaBuilder<R | R2> {
    const newObjectFields = new Map(this.objectFields)
    const typeFields = newObjectFields.get(typeName) || new Map()
    typeFields.set(fieldName, config)
    newObjectFields.set(typeName, typeFields)

    return new GraphQLSchemaBuilder(
      this.types,
      this.queries,
      this.mutations,
      newObjectFields
    ) as any
  }

  /**
   * Build the GraphQL schema (no services required)
   *
   * Resolvers will expect a runtime in the GraphQL context.
   * Use the `execute` function to run queries with a service layer.
   */
  buildSchema(): GraphQLSchema {
    // STEP 1: Build type registry
    const typeRegistry: Map<string, GraphQLObjectType> = new Map()
    const fieldBuilders: Map<string, () => GraphQLFieldConfigMap<any, any>> = new Map()

    // Store field builders for each type
    for (const [typeName, typeReg] of this.types) {
      fieldBuilders.set(typeName, () => {
        const baseFields = this.schemaToFields(typeReg.schema, typeRegistry)
        const additionalFields = this.objectFields.get(typeName)

        if (additionalFields) {
          for (const [fieldName, fieldConfig] of additionalFields) {
            baseFields[fieldName] = this.buildObjectField(fieldConfig, typeRegistry)
          }
        }

        return baseFields
      })
    }

    // Create types with field functions (allows circular references)
    for (const [typeName, fieldBuilder] of fieldBuilders) {
      const graphqlType = new GraphQLObjectType({
        name: typeName,
        fields: fieldBuilder
      })
      typeRegistry.set(typeName, graphqlType)
    }

    // STEP 2: Build query and mutation fields
    const queryFields: GraphQLFieldConfigMap<any, any> = {}
    for (const [name, config] of this.queries) {
      queryFields[name] = this.buildField(config, typeRegistry)
    }

    const mutationFields: GraphQLFieldConfigMap<any, any> = {}
    for (const [name, config] of this.mutations) {
      mutationFields[name] = this.buildField(config, typeRegistry)
    }

    // STEP 3: Build schema
    const schemaConfig: any = {
      types: Array.from(typeRegistry.values())
    }

    if (Object.keys(queryFields).length > 0) {
      schemaConfig.query = new GraphQLObjectType({
        name: "Query",
        fields: queryFields
      })
    }

    if (Object.keys(mutationFields).length > 0) {
      schemaConfig.mutation = new GraphQLObjectType({
        name: "Mutation",
        fields: mutationFields
      })
    }

    return new GraphQLSchema(schemaConfig)
  }

  /**
   * Build a GraphQL field config from a field registration
   */
  private buildField(
    config: FieldRegistration,
    typeRegistry: Map<string, GraphQLObjectType>
  ): GraphQLFieldConfig<any, any> {
    const fieldConfig: GraphQLFieldConfig<any, any> = {
      type: this.toGraphQLTypeWithRegistry(config.type, typeRegistry),
      resolve: async (_parent, args, context: GraphQLEffectContext<any>) => {
        const effect = config.resolve(args)
        return await Runtime.runPromise(context.runtime)(effect)
      }
    }
    if (config.args) {
      fieldConfig.args = toGraphQLArgs(config.args)
    }
    if (config.description) {
      fieldConfig.description = config.description
    }
    return fieldConfig
  }

  /**
   * Build a GraphQL field config for an object field (has parent param)
   */
  private buildObjectField(
    config: ObjectFieldRegistration,
    typeRegistry: Map<string, GraphQLObjectType>
  ): GraphQLFieldConfig<any, any> {
    const fieldConfig: GraphQLFieldConfig<any, any> = {
      type: this.toGraphQLTypeWithRegistry(config.type, typeRegistry),
      resolve: async (parent, args, context: GraphQLEffectContext<any>) => {
        const effect = config.resolve(parent, args)
        return await Runtime.runPromise(context.runtime)(effect)
      }
    }
    if (config.args) {
      fieldConfig.args = toGraphQLArgs(config.args)
    }
    if (config.description) {
      fieldConfig.description = config.description
    }
    return fieldConfig
  }

  /**
   * Convert schema to GraphQL type, checking registry first for registered types
   */
  private toGraphQLTypeWithRegistry(
    schema: S.Schema<any, any, any>,
    typeRegistry: Map<string, GraphQLObjectType>
  ): any {
    const ast = schema.ast

    // Handle transformations (like S.Array, S.optional, etc)
    if (ast._tag === "Transformation") {
      const toAst = (ast as any).to
      // Check if it's an array (readonly array on the to side)
      if (toAst._tag === "TupleType") {
        // S.Array() uses rest, not elements
        if (toAst.rest && toAst.rest.length > 0) {
          const elementSchema = S.make(toAst.rest[0].type)
          const elementType = this.toGraphQLTypeWithRegistry(elementSchema, typeRegistry)
          return new GraphQLList(elementType)
        } else if (toAst.elements.length > 0) {
          const elementSchema = S.make(toAst.elements[0].type)
          const elementType = this.toGraphQLTypeWithRegistry(elementSchema, typeRegistry)
          return new GraphQLList(elementType)
        }
      }
      // Other transformations - recurse on the "to" side
      return this.toGraphQLTypeWithRegistry(S.make((ast as any).to), typeRegistry)
    }

    // Check if this schema matches a registered type (compare by AST)
    for (const [typeName, typeReg] of this.types) {
      if (typeReg.schema.ast === ast || typeReg.schema === schema) {
        const result = typeRegistry.get(typeName)
        if (result) {
          return result
        }
      }
    }

    // Handle tuple types (readonly arrays)
    if (ast._tag === "TupleType") {
      const tupleAst = ast as any
      if (tupleAst.rest && tupleAst.rest.length > 0) {
        const elementSchema = S.make(tupleAst.rest[0].type)
        const elementType = this.toGraphQLTypeWithRegistry(elementSchema, typeRegistry)
        return new GraphQLList(elementType)
      } else if (tupleAst.elements && tupleAst.elements.length > 0) {
        const elementSchema = S.make(tupleAst.elements[0].type)
        const elementType = this.toGraphQLTypeWithRegistry(elementSchema, typeRegistry)
        return new GraphQLList(elementType)
      }
    }

    // Fall back to default conversion
    return toGraphQLType(schema)
  }

  /**
   * Convert a schema to GraphQL fields
   */
  private schemaToFields(
    schema: S.Schema<any, any, any>,
    typeRegistry: Map<string, GraphQLObjectType>
  ): GraphQLFieldConfigMap<any, any> {
    const ast = schema.ast

    if (ast._tag === "TypeLiteral") {
      const fields: GraphQLFieldConfigMap<any, any> = {}

      for (const field of ast.propertySignatures) {
        const fieldName = String(field.name)
        const fieldSchema = S.make(field.type)
        fields[fieldName] = {
          type: this.toGraphQLTypeWithRegistry(fieldSchema, typeRegistry)
        }
      }

      return fields
    }

    return {}
  }
}

// ============================================================================
// Pipe-able API Functions
// ============================================================================

/**
 * Add an object type to the schema builder (pipe-able)
 */
export const objectType = <A, R2 = never>(
  name: string,
  schema: S.Schema<A, any, any>,
  fields?: Record<string, {
    type: S.Schema<any, any, any>
    args?: S.Schema<any, any, any>
    description?: string
    resolve: (parent: A, args: any) => Effect.Effect<any, any, any>
  }>
) => <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R | R2> =>
  builder.objectType(name, schema, fields)

/**
 * Add a query field to the schema builder (pipe-able)
 */
export const query = <A, E, R2, Args = void>(
  name: string,
  config: {
    type: S.Schema<A, any, any>
    args?: S.Schema<Args, any, any>
    description?: string
    resolve: (args: Args) => Effect.Effect<A, E, R2>
  }
) => <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R | R2> =>
  builder.query(name, config)

/**
 * Add a mutation field to the schema builder (pipe-able)
 */
export const mutation = <A, E, R2, Args = void>(
  name: string,
  config: {
    type: S.Schema<A, any, any>
    args?: S.Schema<Args, any, any>
    description?: string
    resolve: (args: Args) => Effect.Effect<A, E, R2>
  }
) => <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R | R2> =>
  builder.mutation(name, config)

/**
 * Add a field to an existing object type (pipe-able)
 */
export const field = <Parent, A, E, R2, Args = void>(
  typeName: string,
  fieldName: string,
  config: {
    type: S.Schema<A, any, any>
    args?: S.Schema<Args, any, any>
    description?: string
    resolve: (parent: Parent, args: Args) => Effect.Effect<A, E, R2>
  }
) => <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R | R2> =>
  builder.field(typeName, fieldName, config)

/**
 * Compose multiple schema operations (helper for arrays)
 */
export const compose = <R>(...operations: Array<(builder: GraphQLSchemaBuilder<any>) => GraphQLSchemaBuilder<any>>) =>
  (builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<any> =>
    operations.reduce((b, op) => op(b), builder)

/**
 * Execute a GraphQL query with a service layer
 *
 * This is the layer-per-request execution model. Build the schema once,
 * then execute each request with its own layer (including request-scoped services).
 */
export const execute = <R>(
  schema: GraphQLSchema,
  layer: Layer.Layer<R>
) => (
  source: string,
  variableValues?: Record<string, unknown>,
  operationName?: string
): Effect.Effect<any, Error> =>
  Effect.gen(function*() {
    // Create runtime from the provided layer
    const runtime = yield* Effect.runtime<R>()

    // Execute GraphQL with runtime in context
    const result = yield* Effect.tryPromise({
      try: () => graphql({
        schema,
        source,
        variableValues,
        operationName,
        contextValue: { runtime } satisfies GraphQLEffectContext<R>
      }),
      catch: (error) => new Error(String(error))
    })

    return result
  }).pipe(Effect.provide(layer))
