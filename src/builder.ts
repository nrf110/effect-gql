import { Effect, Layer, Runtime, Pipeable, Stream, Queue, Fiber, Option, Chunk } from "effect"
import * as S from "effect/Schema"
import * as AST from "effect/SchemaAST"
import { GraphQLSchema, GraphQLObjectType, GraphQLInterfaceType, GraphQLEnumType, GraphQLUnionType, GraphQLInputObjectType, GraphQLFieldConfigMap, GraphQLFieldConfig, GraphQLInputFieldConfigMap, GraphQLList, GraphQLNonNull, GraphQLDirective, DirectiveLocation, graphql } from "graphql"

// Re-export DirectiveLocation for convenience
export { DirectiveLocation } from "graphql"
import { toGraphQLType, toGraphQLArgs, toGraphQLInputType } from "./schema-mapping"

/**
 * Extract type name from a schema if it has one.
 * Supports:
 * - S.TaggedStruct("Name", {...}) - extracts from _tag literal
 * - S.TaggedClass()("Name", {...}) - extracts from identifier annotation
 * - S.Class<T>("Name")({...}) - extracts from identifier annotation
 */
function getSchemaName(schema: S.Schema<any, any, any>): string | undefined {
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
 * Configuration for a query or mutation field
 */
interface FieldRegistration<Args = any, A = any, E = any, R = any> {
  type: S.Schema<A, any, any>
  args?: S.Schema<Args, any, any>
  description?: string
  directives?: readonly DirectiveApplication[]
  resolve: (args: Args) => Effect.Effect<A, E, R>
}

/**
 * Configuration for an object type
 */
interface TypeRegistration {
  name: string
  schema: S.Schema<any, any, any>
  implements?: readonly string[]
  directives?: readonly DirectiveApplication[]
}

/**
 * Configuration for an interface type
 */
interface InterfaceRegistration {
  name: string
  schema: S.Schema<any, any, any>
  resolveType: (value: any) => string
}

/**
 * Configuration for an enum type
 */
interface EnumRegistration {
  name: string
  values: readonly string[]
  description?: string
}

/**
 * Configuration for a union type
 */
interface UnionRegistration {
  name: string
  types: readonly string[]
  resolveType: (value: any) => string
}

/**
 * Configuration for an input type
 */
interface InputTypeRegistration {
  name: string
  schema: S.Schema<any, any, any>
  description?: string
}

/**
 * A reference to a directive applied to a type, field, or argument
 */
export interface DirectiveApplication {
  readonly name: string
  readonly args?: Record<string, unknown>
}

/**
 * Configuration for a directive definition
 */
interface DirectiveRegistration<Args = any, R = never> {
  name: string
  description?: string
  locations: readonly DirectiveLocation[]
  args?: S.Schema<Args, any, any>
  /**
   * For executable directives - transforms the resolver Effect.
   * Called with directive args, returns an Effect transformer.
   */
  apply?: (args: Args) => <A, E, R2>(effect: Effect.Effect<A, E, R2>) => Effect.Effect<A, E, R | R2>
}

/**
 * Configuration for a subscription field
 * Returns a Stream that yields values over time
 */
interface SubscriptionFieldRegistration<Args = any, A = any, E = any, R = any> {
  type: S.Schema<A, any, any>
  args?: S.Schema<Args, any, any>
  description?: string
  directives?: readonly DirectiveApplication[]
  /**
   * Subscribe function returns an Effect that produces a Stream.
   * The Stream yields values that are passed to the resolve function.
   */
  subscribe: (args: Args) => Effect.Effect<Stream.Stream<A, E, R>, E, R>
  /**
   * Optional resolve function to transform each yielded value.
   * If not provided, yields values directly.
   */
  resolve?: (value: A, args: Args) => Effect.Effect<A, E, R>
}

/**
 * Configuration for a field on an object type
 */
interface ObjectFieldRegistration<Parent = any, Args = any, A = any, E = any, R = any> {
  type: S.Schema<A, any, any>
  args?: S.Schema<Args, any, any>
  description?: string
  directives?: readonly DirectiveApplication[]
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
    private readonly interfaces: Map<string, InterfaceRegistration>,
    private readonly enums: Map<string, EnumRegistration>,
    private readonly unions: Map<string, UnionRegistration>,
    private readonly inputs: Map<string, InputTypeRegistration>,
    private readonly directives: Map<string, DirectiveRegistration>,
    private readonly queries: Map<string, FieldRegistration>,
    private readonly mutations: Map<string, FieldRegistration>,
    private readonly subscriptions: Map<string, SubscriptionFieldRegistration>,
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
    new Map(),
    new Map(),
    new Map(),
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
      directives?: readonly DirectiveApplication[]
      resolve: (args: Args) => Effect.Effect<A, E, R2>
    }
  ): GraphQLSchemaBuilder<R | R2> {
    const newQueries = new Map(this.queries)
    newQueries.set(name, config)
    return new GraphQLSchemaBuilder(
      this.types,
      this.interfaces,
      this.enums,
      this.unions,
      this.inputs,
      this.directives,
      newQueries,
      this.mutations,
      this.subscriptions,
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
      directives?: readonly DirectiveApplication[]
      resolve: (args: Args) => Effect.Effect<A, E, R2>
    }
  ): GraphQLSchemaBuilder<R | R2> {
    const newMutations = new Map(this.mutations)
    newMutations.set(name, config)
    return new GraphQLSchemaBuilder(
      this.types,
      this.interfaces,
      this.enums,
      this.unions,
      this.inputs,
      this.directives,
      this.queries,
      newMutations,
      this.subscriptions,
      this.objectFields
    ) as any
  }

  /**
   * Add a subscription field
   *
   * Subscriptions return a Stream that yields values over time.
   * The subscribe function returns an Effect that produces a Stream.
   *
   * @example
   * ```typescript
   * builder.subscription("userCreated", {
   *   type: User,
   *   subscribe: Effect.gen(function*() {
   *     const pubsub = yield* PubSubService
   *     return pubsub.subscribe("USER_CREATED")
   *   }),
   * })
   * ```
   */
  subscription<A, E, R2, Args = void>(
    name: string,
    config: {
      type: S.Schema<A, any, any>
      args?: S.Schema<Args, any, any>
      description?: string
      directives?: readonly DirectiveApplication[]
      /**
       * Subscribe function returns an Effect that produces a Stream.
       * The Stream yields values that are passed to the resolve function.
       */
      subscribe: (args: Args) => Effect.Effect<Stream.Stream<A, E, R2>, E, R2>
      /**
       * Optional resolve function to transform each yielded value.
       * If not provided, yields values directly.
       */
      resolve?: (value: A, args: Args) => Effect.Effect<A, E, R2>
    }
  ): GraphQLSchemaBuilder<R | R2> {
    const newSubscriptions = new Map(this.subscriptions)
    newSubscriptions.set(name, config)
    return new GraphQLSchemaBuilder(
      this.types,
      this.interfaces,
      this.enums,
      this.unions,
      this.inputs,
      this.directives,
      this.queries,
      this.mutations,
      newSubscriptions,
      this.objectFields
    ) as any
  }

  /**
   * Register an object type from a schema
   *
   * @param config - Object type configuration
   * @param config.name - The GraphQL type name (optional if schema is TaggedStruct, TaggedClass, or Schema.Class)
   * @param config.schema - The Effect Schema for this type
   * @param config.implements - Optional array of interface names this type implements
   * @param config.directives - Optional array of directives applied to this type
   * @param config.fields - Optional additional/computed fields for this type
   */
  objectType<A, R2 = never>(config: {
    name?: string
    schema: S.Schema<A, any, any>
    implements?: readonly string[]
    directives?: readonly DirectiveApplication[]
    fields?: Record<string, {
      type: S.Schema<any, any, any>
      args?: S.Schema<any, any, any>
      description?: string
      directives?: readonly DirectiveApplication[]
      resolve: (parent: A, args: any) => Effect.Effect<any, any, any>
    }>
  }): GraphQLSchemaBuilder<R | R2> {
    const { schema, implements: implementsInterfaces, directives, fields } = config
    const name = config.name ?? getSchemaName(schema)
    if (!name) {
      throw new Error("objectType requires a name. Either provide one explicitly or use a TaggedStruct/TaggedClass/Schema.Class")
    }
    const newTypes = new Map(this.types)
    newTypes.set(name, { name, schema, implements: implementsInterfaces, directives })

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
      this.interfaces,
      this.enums,
      this.unions,
      this.inputs,
      this.directives,
      this.queries,
      this.mutations,
      this.subscriptions,
      newObjectFields
    ) as any
  }

  /**
   * Register an interface type from a schema
   *
   * @param config - Interface type configuration
   * @param config.name - The GraphQL interface name (optional if schema is TaggedStruct, TaggedClass, or Schema.Class)
   * @param config.schema - The Effect Schema defining interface fields
   * @param config.resolveType - Optional function to resolve concrete type (defaults to value._tag)
   */
  interfaceType(config: {
    name?: string
    schema: S.Schema<any, any, any>
    resolveType?: (value: any) => string
  }): GraphQLSchemaBuilder<R> {
    const { schema, resolveType } = config
    const name = config.name ?? getSchemaName(schema)
    if (!name) {
      throw new Error("interfaceType requires a name. Either provide one explicitly or use a TaggedStruct/TaggedClass/Schema.Class")
    }
    const newInterfaces = new Map(this.interfaces)
    newInterfaces.set(name, {
      name,
      schema,
      resolveType: resolveType ?? ((value: any) => value._tag),
    })

    return new GraphQLSchemaBuilder(
      this.types,
      newInterfaces,
      this.enums,
      this.unions,
      this.inputs,
      this.directives,
      this.queries,
      this.mutations,
      this.subscriptions,
      this.objectFields
    )
  }

  /**
   * Register an enum type
   *
   * @param config - Enum type configuration
   * @param config.name - The GraphQL enum name
   * @param config.values - Array of enum value strings
   * @param config.description - Optional description
   */
  enumType(config: {
    name: string
    values: readonly string[]
    description?: string
  }): GraphQLSchemaBuilder<R> {
    const { name, values, description } = config
    const newEnums = new Map(this.enums)
    newEnums.set(name, { name, values, description })

    return new GraphQLSchemaBuilder(
      this.types,
      this.interfaces,
      newEnums,
      this.unions,
      this.inputs,
      this.directives,
      this.queries,
      this.mutations,
      this.subscriptions,
      this.objectFields
    )
  }

  /**
   * Register a union type
   *
   * @param config - Union type configuration
   * @param config.name - The GraphQL union name
   * @param config.types - Array of object type names that are part of this union
   * @param config.resolveType - Optional function to resolve concrete type (defaults to value._tag)
   */
  unionType(config: {
    name: string
    types: readonly string[]
    resolveType?: (value: any) => string
  }): GraphQLSchemaBuilder<R> {
    const { name, types, resolveType } = config
    const newUnions = new Map(this.unions)
    newUnions.set(name, {
      name,
      types,
      resolveType: resolveType ?? ((value: any) => value._tag),
    })

    return new GraphQLSchemaBuilder(
      this.types,
      this.interfaces,
      this.enums,
      newUnions,
      this.inputs,
      this.directives,
      this.queries,
      this.mutations,
      this.subscriptions,
      this.objectFields
    )
  }

  /**
   * Register an input type
   *
   * @param config - Input type configuration
   * @param config.name - The GraphQL input type name (optional if schema is TaggedStruct, TaggedClass, or Schema.Class)
   * @param config.schema - The Effect Schema for this input type
   * @param config.description - Optional description
   */
  inputType(config: {
    name?: string
    schema: S.Schema<any, any, any>
    description?: string
  }): GraphQLSchemaBuilder<R> {
    const { schema, description } = config
    const name = config.name ?? getSchemaName(schema)
    if (!name) {
      throw new Error("inputType requires a name. Either provide one explicitly or use a TaggedStruct/TaggedClass/Schema.Class")
    }
    const newInputs = new Map(this.inputs)
    newInputs.set(name, { name, schema, description })

    return new GraphQLSchemaBuilder(
      this.types,
      this.interfaces,
      this.enums,
      this.unions,
      newInputs,
      this.directives,
      this.queries,
      this.mutations,
      this.subscriptions,
      this.objectFields
    )
  }

  /**
   * Register a directive
   *
   * @param config - Directive configuration
   * @param config.name - The directive name (without @)
   * @param config.description - Optional description
   * @param config.locations - Array of DirectiveLocation values where this directive can be applied
   * @param config.args - Optional Effect Schema for directive arguments
   * @param config.apply - Optional function to transform resolver Effects (for executable directives)
   */
  directive<Args = void, R2 = never>(config: {
    name: string
    description?: string
    locations: readonly DirectiveLocation[]
    args?: S.Schema<Args, any, any>
    apply?: (args: Args) => <A, E, R3>(effect: Effect.Effect<A, E, R3>) => Effect.Effect<A, E, R2 | R3>
  }): GraphQLSchemaBuilder<R | R2> {
    const newDirectives = new Map(this.directives)
    newDirectives.set(config.name, config as DirectiveRegistration)

    return new GraphQLSchemaBuilder(
      this.types,
      this.interfaces,
      this.enums,
      this.unions,
      this.inputs,
      newDirectives,
      this.queries,
      this.mutations,
      this.subscriptions,
      this.objectFields
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
      directives?: readonly DirectiveApplication[]
      resolve: (parent: Parent, args: Args) => Effect.Effect<A, E, R2>
    }
  ): GraphQLSchemaBuilder<R | R2> {
    const newObjectFields = new Map(this.objectFields)
    const typeFields = newObjectFields.get(typeName) || new Map()
    typeFields.set(fieldName, config)
    newObjectFields.set(typeName, typeFields)

    return new GraphQLSchemaBuilder(
      this.types,
      this.interfaces,
      this.enums,
      this.unions,
      this.inputs,
      this.directives,
      this.queries,
      this.mutations,
      this.subscriptions,
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
    // STEP 0: Build directive registry first
    const directiveRegistry: Map<string, GraphQLDirective> = new Map()

    for (const [directiveName, directiveReg] of this.directives) {
      const graphqlDirective = new GraphQLDirective({
        name: directiveName,
        description: directiveReg.description,
        locations: [...directiveReg.locations],
        args: directiveReg.args
          ? this.toGraphQLArgsWithRegistry(directiveReg.args, new Map(), new Map())
          : undefined,
      })
      directiveRegistry.set(directiveName, graphqlDirective)
    }

    // STEP 1: Build enum registry first (can be used anywhere)
    const enumRegistry: Map<string, GraphQLEnumType> = new Map()

    for (const [enumName, enumReg] of this.enums) {
      const enumValues: Record<string, { value: string }> = {}
      for (const value of enumReg.values) {
        enumValues[value] = { value }
      }
      const enumType = new GraphQLEnumType({
        name: enumName,
        values: enumValues,
        description: enumReg.description,
      })
      enumRegistry.set(enumName, enumType)
    }

    // STEP 2: Build input type registry (can reference enums and other input types)
    const inputRegistry: Map<string, GraphQLInputObjectType> = new Map()

    for (const [inputName, inputReg] of this.inputs) {
      const inputType = new GraphQLInputObjectType({
        name: inputName,
        description: inputReg.description,
        fields: () => this.schemaToInputFields(inputReg.schema, enumRegistry, inputRegistry),
      })
      inputRegistry.set(inputName, inputType)
    }

    // STEP 3: Build interface registry (object types may reference them)
    const interfaceRegistry: Map<string, GraphQLInterfaceType> = new Map()

    for (const [interfaceName, interfaceReg] of this.interfaces) {
      const interfaceType = new GraphQLInterfaceType({
        name: interfaceName,
        fields: () => this.schemaToFields(interfaceReg.schema, typeRegistry, interfaceRegistry, enumRegistry, unionRegistry),
        resolveType: interfaceReg.resolveType,
      })
      interfaceRegistry.set(interfaceName, interfaceType)
    }

    // STEP 4: Build object type registry
    const typeRegistry: Map<string, GraphQLObjectType> = new Map()
    const fieldBuilders: Map<string, () => GraphQLFieldConfigMap<any, any>> = new Map()

    // Store field builders for each type
    for (const [typeName, typeReg] of this.types) {
      fieldBuilders.set(typeName, () => {
        const baseFields = this.schemaToFields(typeReg.schema, typeRegistry, interfaceRegistry, enumRegistry, unionRegistry)
        const additionalFields = this.objectFields.get(typeName)

        if (additionalFields) {
          for (const [fieldName, fieldConfig] of additionalFields) {
            baseFields[fieldName] = this.buildObjectField(fieldConfig, typeRegistry, interfaceRegistry, enumRegistry, unionRegistry)
          }
        }

        return baseFields
      })
    }

    // Create types with field functions (allows circular references)
    for (const [typeName, fieldBuilder] of fieldBuilders) {
      const typeReg = this.types.get(typeName)!
      const implementedInterfaces = typeReg.implements?.map(
        (name) => interfaceRegistry.get(name)!
      ).filter(Boolean) ?? []

      const graphqlType = new GraphQLObjectType({
        name: typeName,
        fields: fieldBuilder,
        interfaces: implementedInterfaces.length > 0 ? implementedInterfaces : undefined,
      })
      typeRegistry.set(typeName, graphqlType)
    }

    // STEP 5: Build union registry (references object types)
    const unionRegistry: Map<string, GraphQLUnionType> = new Map()

    for (const [unionName, unionReg] of this.unions) {
      const unionType = new GraphQLUnionType({
        name: unionName,
        types: () => unionReg.types.map((typeName) => typeRegistry.get(typeName)!).filter(Boolean),
        resolveType: unionReg.resolveType,
      })
      unionRegistry.set(unionName, unionType)
    }

    // STEP 6: Build query, mutation, and subscription fields
    const queryFields: GraphQLFieldConfigMap<any, any> = {}
    for (const [name, config] of this.queries) {
      queryFields[name] = this.buildField(config, typeRegistry, interfaceRegistry, enumRegistry, unionRegistry, inputRegistry)
    }

    const mutationFields: GraphQLFieldConfigMap<any, any> = {}
    for (const [name, config] of this.mutations) {
      mutationFields[name] = this.buildField(config, typeRegistry, interfaceRegistry, enumRegistry, unionRegistry, inputRegistry)
    }

    const subscriptionFields: GraphQLFieldConfigMap<any, any> = {}
    for (const [name, config] of this.subscriptions) {
      subscriptionFields[name] = this.buildSubscriptionField(config, typeRegistry, interfaceRegistry, enumRegistry, unionRegistry, inputRegistry)
    }

    // STEP 7: Build schema
    const schemaConfig: any = {
      types: [
        ...Array.from(enumRegistry.values()),
        ...Array.from(inputRegistry.values()),
        ...Array.from(interfaceRegistry.values()),
        ...Array.from(typeRegistry.values()),
        ...Array.from(unionRegistry.values()),
      ],
      directives: directiveRegistry.size > 0
        ? [...Array.from(directiveRegistry.values())]
        : undefined,
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

    if (Object.keys(subscriptionFields).length > 0) {
      schemaConfig.subscription = new GraphQLObjectType({
        name: "Subscription",
        fields: subscriptionFields
      })
    }

    return new GraphQLSchema(schemaConfig)
  }

  /**
   * Build a GraphQL field config from a field registration
   */
  private buildField(
    config: FieldRegistration,
    typeRegistry: Map<string, GraphQLObjectType>,
    interfaceRegistry: Map<string, GraphQLInterfaceType>,
    enumRegistry: Map<string, GraphQLEnumType>,
    unionRegistry: Map<string, GraphQLUnionType>,
    inputRegistry: Map<string, GraphQLInputObjectType>
  ): GraphQLFieldConfig<any, any> {
    const fieldConfig: GraphQLFieldConfig<any, any> = {
      type: this.toGraphQLTypeWithRegistry(config.type, typeRegistry, interfaceRegistry, enumRegistry, unionRegistry),
      resolve: async (_parent, args, context: GraphQLEffectContext<any>) => {
        let effect = config.resolve(args)

        // Apply directives in order (first directive wraps outermost)
        if (config.directives) {
          for (const directiveApp of config.directives) {
            const directiveReg = this.directives.get(directiveApp.name)
            if (directiveReg?.apply) {
              effect = directiveReg.apply(directiveApp.args ?? {})(effect)
            }
          }
        }

        return await Runtime.runPromise(context.runtime)(effect)
      }
    }
    if (config.args) {
      fieldConfig.args = this.toGraphQLArgsWithRegistry(config.args, enumRegistry, inputRegistry)
    }
    if (config.description) {
      fieldConfig.description = config.description
    }
    return fieldConfig
  }

  /**
   * Build a GraphQL subscription field config.
   *
   * Subscriptions in GraphQL have a special structure:
   * - `subscribe` returns an AsyncIterator that yields the "root value" for each event
   * - `resolve` transforms each yielded value into the final result
   *
   * We convert Effect's Stream to an AsyncIterator using a Queue-based approach.
   */
  private buildSubscriptionField(
    config: SubscriptionFieldRegistration,
    typeRegistry: Map<string, GraphQLObjectType>,
    interfaceRegistry: Map<string, GraphQLInterfaceType>,
    enumRegistry: Map<string, GraphQLEnumType>,
    unionRegistry: Map<string, GraphQLUnionType>,
    inputRegistry: Map<string, GraphQLInputObjectType>
  ): GraphQLFieldConfig<any, any> {
    const directivesRef = this.directives

    const fieldConfig: GraphQLFieldConfig<any, any> = {
      type: this.toGraphQLTypeWithRegistry(config.type, typeRegistry, interfaceRegistry, enumRegistry, unionRegistry),

      // The subscribe function returns an AsyncIterator
      subscribe: async (_parent, args, context: GraphQLEffectContext<any>) => {
        // Get the Stream from the subscribe Effect
        let subscribeEffect = config.subscribe(args)

        // Apply directives to the subscribe effect
        if (config.directives) {
          for (const directiveApp of config.directives) {
            const directiveReg = directivesRef.get(directiveApp.name)
            if (directiveReg?.apply) {
              subscribeEffect = directiveReg.apply(directiveApp.args ?? {})(subscribeEffect) as any
            }
          }
        }

        const stream = await Runtime.runPromise(context.runtime)(subscribeEffect)

        // Use a Queue to bridge between Effect Stream and AsyncIterator
        // Create the queue first
        const queue = await Runtime.runPromise(context.runtime)(
          Queue.unbounded<Option.Option<any>>()
        )

        // Fork a fiber to run the stream and push values to the queue
        // Use Runtime.runFork to ensure proper execution context
        const fiber = Runtime.runFork(context.runtime)(
          Effect.ensuring(
            Stream.runForEach(stream, (value) => Queue.offer(queue, Option.some(value))),
            // Signal completion by pushing None
            Queue.offer(queue, Option.none())
          )
        )

        // Track if we're done
        let done = false

        // Return an AsyncIterator that takes from the queue
        return {
          [Symbol.asyncIterator]() { return this },
          async next(): Promise<IteratorResult<any>> {
            if (done) {
              return { done: true, value: undefined }
            }

            try {
              const optionValue = await Runtime.runPromise(context.runtime)(
                Queue.take(queue)
              )

              if (Option.isNone(optionValue)) {
                done = true
                return { done: true, value: undefined }
              }

              return { done: false, value: optionValue.value }
            } catch (error) {
              done = true
              throw error
            }
          },
          async return(): Promise<IteratorResult<any>> {
            // Cleanup - interrupt the fiber and shutdown the queue
            done = true
            try {
              // Interrupt the fiber (fiber is a RuntimeFiber from Runtime.runFork)
              await Runtime.runPromise(context.runtime)(
                Fiber.interrupt(fiber as unknown as Fiber.Fiber<any, any>)
              )
              await Runtime.runPromise(context.runtime)(
                Queue.shutdown(queue)
              )
            } catch {
              // Ignore cleanup errors
            }
            return { done: true, value: undefined }
          },
        }
      },

      // The resolve function transforms each yielded value
      // If no custom resolve is provided, return the payload directly
      // (GraphQL's default resolver would look for a property matching the field name)
      resolve: config.resolve
        ? async (value, args, context: GraphQLEffectContext<any>) => {
            const effect = config.resolve!(value, args)
            return await Runtime.runPromise(context.runtime)(effect)
          }
        : (value) => value,
    }

    if (config.args) {
      fieldConfig.args = this.toGraphQLArgsWithRegistry(config.args, enumRegistry, inputRegistry)
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
    typeRegistry: Map<string, GraphQLObjectType>,
    interfaceRegistry: Map<string, GraphQLInterfaceType>,
    enumRegistry: Map<string, GraphQLEnumType>,
    unionRegistry: Map<string, GraphQLUnionType>,
    inputRegistry: Map<string, GraphQLInputObjectType> = new Map()
  ): GraphQLFieldConfig<any, any> {
    const fieldConfig: GraphQLFieldConfig<any, any> = {
      type: this.toGraphQLTypeWithRegistry(config.type, typeRegistry, interfaceRegistry, enumRegistry, unionRegistry),
      resolve: async (parent, args, context: GraphQLEffectContext<any>) => {
        let effect = config.resolve(parent, args)

        // Apply directives in order (first directive wraps outermost)
        if (config.directives) {
          for (const directiveApp of config.directives) {
            const directiveReg = this.directives.get(directiveApp.name)
            if (directiveReg?.apply) {
              effect = directiveReg.apply(directiveApp.args ?? {})(effect)
            }
          }
        }

        return await Runtime.runPromise(context.runtime)(effect)
      }
    }
    if (config.args) {
      fieldConfig.args = this.toGraphQLArgsWithRegistry(config.args, enumRegistry, inputRegistry)
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
    typeRegistry: Map<string, GraphQLObjectType>,
    interfaceRegistry: Map<string, GraphQLInterfaceType> = new Map(),
    enumRegistry: Map<string, GraphQLEnumType> = new Map(),
    unionRegistry: Map<string, GraphQLUnionType> = new Map()
  ): any {
    const ast = schema.ast

    // FIRST: Check if this schema matches a registered type (by schema reference or AST)
    // This must happen before handling transformations so Schema.Class types are matched
    for (const [typeName, typeReg] of this.types) {
      if (typeReg.schema === schema || typeReg.schema.ast === ast) {
        const result = typeRegistry.get(typeName)
        if (result) {
          return result
        }
      }
    }

    // Check if this schema matches a registered interface
    for (const [interfaceName, interfaceReg] of this.interfaces) {
      if (interfaceReg.schema === schema || interfaceReg.schema.ast === ast) {
        const result = interfaceRegistry.get(interfaceName)
        if (result) {
          return result
        }
      }
    }

    // Handle transformations (like S.Array, S.optional, etc)
    if (ast._tag === "Transformation") {
      const toAst = (ast as any).to
      // Check if it's an array (readonly array on the to side)
      if (toAst._tag === "TupleType") {
        // S.Array() uses rest, not elements
        if (toAst.rest && toAst.rest.length > 0) {
          const elementSchema = S.make(toAst.rest[0].type)
          const elementType = this.toGraphQLTypeWithRegistry(elementSchema, typeRegistry, interfaceRegistry, enumRegistry, unionRegistry)
          return new GraphQLList(elementType)
        } else if (toAst.elements.length > 0) {
          const elementSchema = S.make(toAst.elements[0].type)
          const elementType = this.toGraphQLTypeWithRegistry(elementSchema, typeRegistry, interfaceRegistry, enumRegistry, unionRegistry)
          return new GraphQLList(elementType)
        }
      }
      // Other transformations - recurse on the "to" side
      return this.toGraphQLTypeWithRegistry(S.make((ast as any).to), typeRegistry, interfaceRegistry, enumRegistry, unionRegistry)
    }

    // Check if this schema matches a registered enum by comparing literal values
    // S.Literal("A", "B", "C") creates a Union of Literals
    if (ast._tag === "Union") {
      const unionAst = ast as any
      const allLiterals = unionAst.types.every((t: any) => t._tag === "Literal")

      if (allLiterals) {
        // Extract literal values from the union
        const literalValues = unionAst.types.map((t: any) => String(t.literal)).sort()

        // Check if any registered enum has the same values
        for (const [enumName, enumReg] of this.enums) {
          const enumValues = [...enumReg.values].sort()
          if (literalValues.length === enumValues.length &&
              literalValues.every((v: string, i: number) => v === enumValues[i])) {
            const result = enumRegistry.get(enumName)
            if (result) {
              return result
            }
          }
        }
      } else {
        // This is a Union of object types - check if it matches a registered union
        // First, collect the _tag values from each union member
        const memberTags: string[] = []
        for (const memberAst of unionAst.types) {
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
        if (memberTags.length === unionAst.types.length) {
          for (const [unionName, unionReg] of this.unions) {
            const unionTypes = [...unionReg.types].sort()
            const sortedTags = [...memberTags].sort()
            if (sortedTags.length === unionTypes.length &&
                sortedTags.every((tag, i) => tag === unionTypes[i])) {
              const result = unionRegistry.get(unionName)
              if (result) {
                return result
              }
            }
          }
        }
      }
    }

    // Check single literal (for cases like status: S.Literal("DRAFT"))
    if (ast._tag === "Literal") {
      const literalValue = String((ast as any).literal)
      // Check if this literal is part of any registered enum
      for (const [enumName, enumReg] of this.enums) {
        if (enumReg.values.includes(literalValue)) {
          const result = enumRegistry.get(enumName)
          if (result) {
            return result
          }
        }
      }
    }

    // Handle tuple types (readonly arrays)
    if (ast._tag === "TupleType") {
      const tupleAst = ast as any
      if (tupleAst.rest && tupleAst.rest.length > 0) {
        const elementSchema = S.make(tupleAst.rest[0].type)
        const elementType = this.toGraphQLTypeWithRegistry(elementSchema, typeRegistry, interfaceRegistry, enumRegistry, unionRegistry)
        return new GraphQLList(elementType)
      } else if (tupleAst.elements && tupleAst.elements.length > 0) {
        const elementSchema = S.make(tupleAst.elements[0].type)
        const elementType = this.toGraphQLTypeWithRegistry(elementSchema, typeRegistry, interfaceRegistry, enumRegistry, unionRegistry)
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
    typeRegistry: Map<string, GraphQLObjectType>,
    interfaceRegistry: Map<string, GraphQLInterfaceType> = new Map(),
    enumRegistry: Map<string, GraphQLEnumType> = new Map(),
    unionRegistry: Map<string, GraphQLUnionType> = new Map()
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
        let fieldType = this.toGraphQLTypeWithRegistry(fieldSchema, typeRegistry, interfaceRegistry, enumRegistry, unionRegistry)

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
  private schemaToInputFields(
    schema: S.Schema<any, any, any>,
    enumRegistry: Map<string, GraphQLEnumType>,
    inputRegistry: Map<string, GraphQLInputObjectType>
  ): GraphQLInputFieldConfigMap {
    const ast = schema.ast

    if (ast._tag === "TypeLiteral") {
      const fields: GraphQLInputFieldConfigMap = {}

      for (const field of ast.propertySignatures) {
        const fieldName = String(field.name)
        const fieldSchema = S.make(field.type)
        let fieldType = this.toGraphQLInputTypeWithRegistry(fieldSchema, enumRegistry, inputRegistry)

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
  private toGraphQLInputTypeWithRegistry(
    schema: S.Schema<any, any, any>,
    enumRegistry: Map<string, GraphQLEnumType>,
    inputRegistry: Map<string, GraphQLInputObjectType> = new Map()
  ): any {
    const ast = schema.ast

    // Handle transformations (like S.optional wrapping)
    if (ast._tag === "Transformation") {
      const toAst = (ast as any).to
      // Recurse on the "to" side for transformations
      return this.toGraphQLInputTypeWithRegistry(S.make(toAst), enumRegistry, inputRegistry)
    }

    // Check if this schema matches a registered input type (by AST reference)
    for (const [inputName, inputReg] of this.inputs) {
      if (inputReg.schema.ast === ast || inputReg.schema === schema) {
        const result = inputRegistry.get(inputName)
        if (result) {
          return result
        }
      }
    }

    // Check if this schema matches a registered enum by comparing literal values
    if (ast._tag === "Union") {
      const unionAst = ast as any

      // Handle S.optional which creates Union(LiteralUnion, UndefinedKeyword)
      const nonUndefinedTypes = unionAst.types.filter((t: any) => t._tag !== "UndefinedKeyword")
      if (nonUndefinedTypes.length === 1 && nonUndefinedTypes[0]._tag === "Union") {
        // Recurse on the inner union (the actual enum values)
        return this.toGraphQLInputTypeWithRegistry(S.make(nonUndefinedTypes[0]), enumRegistry, inputRegistry)
      }

      // Check for nested input type inside optional
      if (nonUndefinedTypes.length === 1 && nonUndefinedTypes[0]._tag === "TypeLiteral") {
        return this.toGraphQLInputTypeWithRegistry(S.make(nonUndefinedTypes[0]), enumRegistry, inputRegistry)
      }

      const allLiterals = unionAst.types.every((t: any) => t._tag === "Literal")

      if (allLiterals) {
        const literalValues = unionAst.types.map((t: any) => String(t.literal)).sort()

        for (const [enumName, enumReg] of this.enums) {
          const enumValues = [...enumReg.values].sort()
          if (literalValues.length === enumValues.length &&
              literalValues.every((v: string, i: number) => v === enumValues[i])) {
            const result = enumRegistry.get(enumName)
            if (result) {
              return result
            }
          }
        }
      }
    }

    // Check single literal
    if (ast._tag === "Literal") {
      const literalValue = String((ast as any).literal)
      for (const [enumName, enumReg] of this.enums) {
        if (enumReg.values.includes(literalValue)) {
          const result = enumRegistry.get(enumName)
          if (result) {
            return result
          }
        }
      }
    }

    // Fall back to default toGraphQLInputType
    return toGraphQLInputType(schema)
  }

  /**
   * Convert a schema to GraphQL arguments with registry support
   */
  private toGraphQLArgsWithRegistry(
    schema: S.Schema<any, any, any>,
    enumRegistry: Map<string, GraphQLEnumType>,
    inputRegistry: Map<string, GraphQLInputObjectType> = new Map()
  ): any {
    const ast = schema.ast

    if (ast._tag === "TypeLiteral") {
      const args: Record<string, { type: any }> = {}

      for (const field of (ast as any).propertySignatures) {
        const fieldName = String(field.name)
        const fieldSchema = S.make(field.type)
        let fieldType = this.toGraphQLInputTypeWithRegistry(fieldSchema, enumRegistry, inputRegistry)

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
}

// ============================================================================
// Pipe-able API Functions
// ============================================================================

/**
 * Add an object type to the schema builder (pipe-able)
 * Name is optional if schema is TaggedStruct, TaggedClass, or Schema.Class
 */
export const objectType = <A, R2 = never>(config: {
  name?: string
  schema: S.Schema<A, any, any>
  implements?: readonly string[]
  directives?: readonly DirectiveApplication[]
  fields?: Record<string, {
    type: S.Schema<any, any, any>
    args?: S.Schema<any, any, any>
    description?: string
    directives?: readonly DirectiveApplication[]
    resolve: (parent: A, args: any) => Effect.Effect<any, any, any>
  }>
}) => <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R | R2> =>
  builder.objectType(config)

/**
 * Add an interface type to the schema builder (pipe-able)
 * Name is optional if schema is TaggedStruct, TaggedClass, or Schema.Class
 */
export const interfaceType = (config: {
  name?: string
  schema: S.Schema<any, any, any>
  resolveType?: (value: any) => string
}) => <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R> =>
  builder.interfaceType(config)

/**
 * Add an enum type to the schema builder (pipe-able)
 */
export const enumType = (config: {
  name: string
  values: readonly string[]
  description?: string
}) => <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R> =>
  builder.enumType(config)

/**
 * Add a union type to the schema builder (pipe-able)
 */
export const unionType = (config: {
  name: string
  types: readonly string[]
  resolveType?: (value: any) => string
}) => <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R> =>
  builder.unionType(config)

/**
 * Add an input type to the schema builder (pipe-able)
 * Name is optional if schema is TaggedStruct, TaggedClass, or Schema.Class
 */
export const inputType = (config: {
  name?: string
  schema: S.Schema<any, any, any>
  description?: string
}) => <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R> =>
  builder.inputType(config)

/**
 * Register a directive (pipe-able)
 *
 * @param config - Directive configuration
 * @param config.name - The directive name (without @)
 * @param config.description - Optional description
 * @param config.locations - Array of DirectiveLocation values where this directive can be applied
 * @param config.args - Optional Effect Schema for directive arguments
 * @param config.apply - Optional function to transform resolver Effects (for executable directives)
 */
export const directive = <Args = void, R2 = never>(config: {
  name: string
  description?: string
  locations: readonly DirectiveLocation[]
  args?: S.Schema<Args, any, any>
  apply?: (args: Args) => <A, E, R3>(effect: Effect.Effect<A, E, R3>) => Effect.Effect<A, E, R2 | R3>
}) => <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R | R2> =>
  builder.directive(config)

/**
 * Add a query field to the schema builder (pipe-able)
 */
export const query = <A, E, R2, Args = void>(
  name: string,
  config: {
    type: S.Schema<A, any, any>
    args?: S.Schema<Args, any, any>
    description?: string
    directives?: readonly DirectiveApplication[]
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
    directives?: readonly DirectiveApplication[]
    resolve: (args: Args) => Effect.Effect<A, E, R2>
  }
) => <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R | R2> =>
  builder.mutation(name, config)

/**
 * Add a subscription field to the schema builder (pipe-able)
 *
 * Subscriptions return a Stream that yields values over time.
 *
 * @example
 * ```typescript
 * GraphQLSchemaBuilder.empty.pipe(
 *   subscription("userCreated", {
 *     type: User,
 *     subscribe: Effect.gen(function*() {
 *       const pubsub = yield* PubSubService
 *       return pubsub.subscribe("USER_CREATED")
 *     }),
 *   })
 * )
 * ```
 */
export const subscription = <A, E, R2, Args = void>(
  name: string,
  config: {
    type: S.Schema<A, any, any>
    args?: S.Schema<Args, any, any>
    description?: string
    directives?: readonly DirectiveApplication[]
    subscribe: (args: Args) => Effect.Effect<Stream.Stream<A, E, R2>, E, R2>
    resolve?: (value: A, args: Args) => Effect.Effect<A, E, R2>
  }
) => <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R | R2> =>
  builder.subscription(name, config)

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
    directives?: readonly DirectiveApplication[]
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
