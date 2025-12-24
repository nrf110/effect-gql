import { Effect, Pipeable } from "effect"
import * as S from "effect/Schema"
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLInterfaceType,
  GraphQLEnumType,
  GraphQLUnionType,
  GraphQLInputObjectType,
  GraphQLFieldConfigMap,
  GraphQLDirective,
  DirectiveLocation,
} from "graphql"
import type {
  FieldRegistration,
  TypeRegistration,
  InterfaceRegistration,
  EnumRegistration,
  UnionRegistration,
  InputTypeRegistration,
  DirectiveRegistration,
  DirectiveApplication,
  SubscriptionFieldRegistration,
  ObjectFieldRegistration,
} from "./types"
import {
  getSchemaName,
  schemaToFields,
  schemaToInputFields,
  toGraphQLArgsWithRegistry,
  buildReverseLookups,
  type TypeConversionContext,
} from "./type-registry"
import {
  buildField,
  buildObjectField,
  buildSubscriptionField,
  type FieldBuilderContext,
} from "./field-builders"

/**
 * Internal state for the builder
 */
interface BuilderState {
  types: Map<string, TypeRegistration>
  interfaces: Map<string, InterfaceRegistration>
  enums: Map<string, EnumRegistration>
  unions: Map<string, UnionRegistration>
  inputs: Map<string, InputTypeRegistration>
  directives: Map<string, DirectiveRegistration>
  queries: Map<string, FieldRegistration>
  mutations: Map<string, FieldRegistration>
  subscriptions: Map<string, SubscriptionFieldRegistration>
  objectFields: Map<string, Map<string, ObjectFieldRegistration>>
}

/**
 * Create a new state with one map updated
 */
function updateState<K extends keyof BuilderState>(
  state: BuilderState,
  key: K,
  value: BuilderState[K]
): BuilderState {
  return { ...state, [key]: value }
}

/**
 * GraphQL Schema Builder with type-safe service requirements (Layer-per-Request Pattern)
 *
 * The type parameter R accumulates all service requirements from resolvers.
 * Unlike the runtime-in-context approach, this pattern builds the schema without
 * executing any Effects. At request time, you provide a Layer with all required services.
 */
export class GraphQLSchemaBuilder<R = never> implements Pipeable.Pipeable {
  private constructor(private readonly state: BuilderState) {}

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
  static readonly empty = new GraphQLSchemaBuilder<never>({
    types: new Map(),
    interfaces: new Map(),
    enums: new Map(),
    unions: new Map(),
    inputs: new Map(),
    directives: new Map(),
    queries: new Map(),
    mutations: new Map(),
    subscriptions: new Map(),
    objectFields: new Map(),
  })

  /**
   * Create a new builder with updated state
   */
  private with(newState: BuilderState): GraphQLSchemaBuilder<any> {
    return new GraphQLSchemaBuilder(newState)
  }

  // ============================================================================
  // Registration Methods
  // ============================================================================

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
    const newQueries = new Map(this.state.queries)
    newQueries.set(name, config)
    return this.with(updateState(this.state, "queries", newQueries))
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
    const newMutations = new Map(this.state.mutations)
    newMutations.set(name, config)
    return this.with(updateState(this.state, "mutations", newMutations))
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
      subscribe: (args: Args) => Effect.Effect<import("effect").Stream.Stream<A, E, R2>, E, R2>
      resolve?: (value: A, args: Args) => Effect.Effect<A, E, R2>
    }
  ): GraphQLSchemaBuilder<R | R2> {
    const newSubscriptions = new Map(this.state.subscriptions)
    newSubscriptions.set(name, config)
    return this.with(updateState(this.state, "subscriptions", newSubscriptions))
  }

  /**
   * Register an object type from a schema
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

    const newTypes = new Map(this.state.types)
    newTypes.set(name, { name, schema, implements: implementsInterfaces, directives })

    let newObjectFields = this.state.objectFields
    if (fields) {
      newObjectFields = new Map(this.state.objectFields)
      const typeFields = new Map<string, ObjectFieldRegistration>()
      for (const [fieldName, fieldConfig] of Object.entries(fields)) {
        typeFields.set(fieldName, fieldConfig as ObjectFieldRegistration)
      }
      newObjectFields.set(name, typeFields)
    }

    return this.with({
      ...this.state,
      types: newTypes,
      objectFields: newObjectFields,
    })
  }

  /**
   * Register an interface type from a schema
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

    const newInterfaces = new Map(this.state.interfaces)
    newInterfaces.set(name, {
      name,
      schema,
      resolveType: resolveType ?? ((value: any) => value._tag),
    })

    return this.with(updateState(this.state, "interfaces", newInterfaces))
  }

  /**
   * Register an enum type
   */
  enumType(config: {
    name: string
    values: readonly string[]
    description?: string
  }): GraphQLSchemaBuilder<R> {
    const { name, values, description } = config
    const newEnums = new Map(this.state.enums)
    newEnums.set(name, { name, values, description })
    return this.with(updateState(this.state, "enums", newEnums))
  }

  /**
   * Register a union type
   */
  unionType(config: {
    name: string
    types: readonly string[]
    resolveType?: (value: any) => string
  }): GraphQLSchemaBuilder<R> {
    const { name, types, resolveType } = config
    const newUnions = new Map(this.state.unions)
    newUnions.set(name, {
      name,
      types,
      resolveType: resolveType ?? ((value: any) => value._tag),
    })
    return this.with(updateState(this.state, "unions", newUnions))
  }

  /**
   * Register an input type
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

    const newInputs = new Map(this.state.inputs)
    newInputs.set(name, { name, schema, description })
    return this.with(updateState(this.state, "inputs", newInputs))
  }

  /**
   * Register a directive
   */
  directive<Args = void, R2 = never>(config: {
    name: string
    description?: string
    locations: readonly DirectiveLocation[]
    args?: S.Schema<Args, any, any>
    apply?: (args: Args) => <A, E, R3>(effect: Effect.Effect<A, E, R3>) => Effect.Effect<A, E, R2 | R3>
  }): GraphQLSchemaBuilder<R | R2> {
    const newDirectives = new Map(this.state.directives)
    newDirectives.set(config.name, config as DirectiveRegistration)
    return this.with(updateState(this.state, "directives", newDirectives))
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
    const newObjectFields = new Map(this.state.objectFields)
    const typeFields = newObjectFields.get(typeName) || new Map()
    typeFields.set(fieldName, config)
    newObjectFields.set(typeName, typeFields)
    return this.with(updateState(this.state, "objectFields", newObjectFields))
  }

  // ============================================================================
  // Schema Building
  // ============================================================================

  /**
   * Build the GraphQL schema (no services required)
   */
  buildSchema(): GraphQLSchema {
    // Build all registries
    const directiveRegistry = this.buildDirectiveRegistry()
    const enumRegistry = this.buildEnumRegistry()
    const inputRegistry = this.buildInputRegistry(enumRegistry)
    const interfaceRegistry = this.buildInterfaceRegistry(enumRegistry)
    const { typeRegistry, unionRegistry } = this.buildTypeAndUnionRegistries(
      enumRegistry,
      interfaceRegistry
    )

    // Build field builder context
    const fieldCtx = this.createFieldBuilderContext(
      typeRegistry,
      interfaceRegistry,
      enumRegistry,
      unionRegistry,
      inputRegistry
    )

    // Build root type fields
    const queryFields = this.buildQueryFields(fieldCtx)
    const mutationFields = this.buildMutationFields(fieldCtx)
    const subscriptionFields = this.buildSubscriptionFields(fieldCtx)

    // Assemble schema
    return this.assembleSchema({
      directiveRegistry,
      enumRegistry,
      inputRegistry,
      interfaceRegistry,
      typeRegistry,
      unionRegistry,
      queryFields,
      mutationFields,
      subscriptionFields,
    })
  }

  private buildDirectiveRegistry(): Map<string, GraphQLDirective> {
    const registry = new Map<string, GraphQLDirective>()

    for (const [name, reg] of this.state.directives) {
      const graphqlDirective = new GraphQLDirective({
        name,
        description: reg.description,
        locations: [...reg.locations],
        args: reg.args
          ? toGraphQLArgsWithRegistry(
              reg.args,
              new Map(),
              new Map(),
              this.state.inputs,
              this.state.enums
            )
          : undefined,
      })
      registry.set(name, graphqlDirective)
    }

    return registry
  }

  private buildEnumRegistry(): Map<string, GraphQLEnumType> {
    const registry = new Map<string, GraphQLEnumType>()

    for (const [name, reg] of this.state.enums) {
      const enumValues: Record<string, { value: string }> = {}
      for (const value of reg.values) {
        enumValues[value] = { value }
      }
      registry.set(name, new GraphQLEnumType({
        name,
        values: enumValues,
        description: reg.description,
      }))
    }

    return registry
  }

  private buildInputRegistry(
    enumRegistry: Map<string, GraphQLEnumType>
  ): Map<string, GraphQLInputObjectType> {
    const registry = new Map<string, GraphQLInputObjectType>()

    for (const [name, reg] of this.state.inputs) {
      const inputType = new GraphQLInputObjectType({
        name,
        description: reg.description,
        fields: () => schemaToInputFields(
          reg.schema,
          enumRegistry,
          registry,
          this.state.inputs,
          this.state.enums
        ),
      })
      registry.set(name, inputType)
    }

    return registry
  }

  private buildInterfaceRegistry(
    enumRegistry: Map<string, GraphQLEnumType>
  ): Map<string, GraphQLInterfaceType> {
    const registry = new Map<string, GraphQLInterfaceType>()
    // We need type and union registries for interface fields, but they're built later
    // Use empty maps for now - interfaces shouldn't reference object types directly
    const typeRegistry = new Map<string, GraphQLObjectType>()
    const unionRegistry = new Map<string, GraphQLUnionType>()

    // Create shared TypeConversionContext once for all interface field builders
    const sharedCtx: TypeConversionContext = {
      types: this.state.types,
      interfaces: this.state.interfaces,
      enums: this.state.enums,
      unions: this.state.unions,
      inputs: this.state.inputs,
      typeRegistry,
      interfaceRegistry: registry,
      enumRegistry,
      unionRegistry,
      inputRegistry: new Map(),
    }
    // Pre-build reverse lookup maps once
    buildReverseLookups(sharedCtx)

    for (const [name, reg] of this.state.interfaces) {
      const interfaceType = new GraphQLInterfaceType({
        name,
        fields: () => schemaToFields(reg.schema, sharedCtx),
        resolveType: reg.resolveType,
      })
      registry.set(name, interfaceType)
    }

    return registry
  }

  private buildTypeAndUnionRegistries(
    enumRegistry: Map<string, GraphQLEnumType>,
    interfaceRegistry: Map<string, GraphQLInterfaceType>
  ): {
    typeRegistry: Map<string, GraphQLObjectType>
    unionRegistry: Map<string, GraphQLUnionType>
  } {
    const typeRegistry = new Map<string, GraphQLObjectType>()
    const unionRegistry = new Map<string, GraphQLUnionType>()

    // Create shared TypeConversionContext once and reuse for all lazy field builders
    const sharedCtx: TypeConversionContext = {
      types: this.state.types,
      interfaces: this.state.interfaces,
      enums: this.state.enums,
      unions: this.state.unions,
      inputs: this.state.inputs,
      typeRegistry,
      interfaceRegistry,
      enumRegistry,
      unionRegistry,
      inputRegistry: new Map(),
    }
    // Pre-build reverse lookup maps once
    buildReverseLookups(sharedCtx)

    // Create shared FieldBuilderContext for additional fields
    const sharedFieldCtx = this.createFieldBuilderContext(
      typeRegistry,
      interfaceRegistry,
      enumRegistry,
      unionRegistry,
      new Map()
    )

    // Build object types with lazy field builders (allows circular references)
    for (const [typeName, typeReg] of this.state.types) {
      const implementedInterfaces = typeReg.implements?.map(
        (name) => interfaceRegistry.get(name)!
      ).filter(Boolean) ?? []

      const graphqlType = new GraphQLObjectType({
        name: typeName,
        fields: () => {
          const baseFields = schemaToFields(typeReg.schema, sharedCtx)
          const additionalFields = this.state.objectFields.get(typeName)

          if (additionalFields) {
            for (const [fieldName, fieldConfig] of additionalFields) {
              baseFields[fieldName] = buildObjectField(fieldConfig, sharedFieldCtx)
            }
          }

          return baseFields
        },
        interfaces: implementedInterfaces.length > 0 ? implementedInterfaces : undefined,
      })
      typeRegistry.set(typeName, graphqlType)
    }

    // Build union types (reference object types)
    for (const [name, reg] of this.state.unions) {
      const unionType = new GraphQLUnionType({
        name,
        types: () => reg.types.map((typeName) => typeRegistry.get(typeName)!).filter(Boolean),
        resolveType: reg.resolveType,
      })
      unionRegistry.set(name, unionType)
    }

    return { typeRegistry, unionRegistry }
  }

  private createFieldBuilderContext(
    typeRegistry: Map<string, GraphQLObjectType>,
    interfaceRegistry: Map<string, GraphQLInterfaceType>,
    enumRegistry: Map<string, GraphQLEnumType>,
    unionRegistry: Map<string, GraphQLUnionType>,
    inputRegistry: Map<string, GraphQLInputObjectType>
  ): FieldBuilderContext {
    return {
      types: this.state.types,
      interfaces: this.state.interfaces,
      enums: this.state.enums,
      unions: this.state.unions,
      inputs: this.state.inputs,
      typeRegistry,
      interfaceRegistry,
      enumRegistry,
      unionRegistry,
      inputRegistry,
      directiveRegistrations: this.state.directives,
    }
  }

  private buildQueryFields(ctx: FieldBuilderContext): GraphQLFieldConfigMap<any, any> {
    const fields: GraphQLFieldConfigMap<any, any> = {}
    for (const [name, config] of this.state.queries) {
      fields[name] = buildField(config, ctx)
    }
    return fields
  }

  private buildMutationFields(ctx: FieldBuilderContext): GraphQLFieldConfigMap<any, any> {
    const fields: GraphQLFieldConfigMap<any, any> = {}
    for (const [name, config] of this.state.mutations) {
      fields[name] = buildField(config, ctx)
    }
    return fields
  }

  private buildSubscriptionFields(ctx: FieldBuilderContext): GraphQLFieldConfigMap<any, any> {
    const fields: GraphQLFieldConfigMap<any, any> = {}
    for (const [name, config] of this.state.subscriptions) {
      fields[name] = buildSubscriptionField(config, ctx)
    }
    return fields
  }

  private assembleSchema(registries: {
    directiveRegistry: Map<string, GraphQLDirective>
    enumRegistry: Map<string, GraphQLEnumType>
    inputRegistry: Map<string, GraphQLInputObjectType>
    interfaceRegistry: Map<string, GraphQLInterfaceType>
    typeRegistry: Map<string, GraphQLObjectType>
    unionRegistry: Map<string, GraphQLUnionType>
    queryFields: GraphQLFieldConfigMap<any, any>
    mutationFields: GraphQLFieldConfigMap<any, any>
    subscriptionFields: GraphQLFieldConfigMap<any, any>
  }): GraphQLSchema {
    const schemaConfig: any = {
      types: [
        ...Array.from(registries.enumRegistry.values()),
        ...Array.from(registries.inputRegistry.values()),
        ...Array.from(registries.interfaceRegistry.values()),
        ...Array.from(registries.typeRegistry.values()),
        ...Array.from(registries.unionRegistry.values()),
      ],
      directives: registries.directiveRegistry.size > 0
        ? [...Array.from(registries.directiveRegistry.values())]
        : undefined,
    }

    if (Object.keys(registries.queryFields).length > 0) {
      schemaConfig.query = new GraphQLObjectType({
        name: "Query",
        fields: registries.queryFields,
      })
    }

    if (Object.keys(registries.mutationFields).length > 0) {
      schemaConfig.mutation = new GraphQLObjectType({
        name: "Mutation",
        fields: registries.mutationFields,
      })
    }

    if (Object.keys(registries.subscriptionFields).length > 0) {
      schemaConfig.subscription = new GraphQLObjectType({
        name: "Subscription",
        fields: registries.subscriptionFields,
      })
    }

    return new GraphQLSchema(schemaConfig)
  }
}
