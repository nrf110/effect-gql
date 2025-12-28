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
  MiddlewareRegistration,
  MiddlewareContext,
  CacheHint,
} from "./types"
import type { GraphQLExtension, ExecutionArgs } from "../extensions"
import type {
  GraphQLResolveInfo,
  DocumentNode,
  ExecutionResult,
  GraphQLError as GQLError,
} from "graphql"
import type { FieldComplexity, FieldComplexityMap } from "../server/complexity"
import type { CacheHintMap } from "../server/cache-control"
import {
  getSchemaName,
  schemaToFields,
  schemaToInputFields,
  toGraphQLArgsWithRegistry,
  buildReverseLookups,
  buildInputTypeLookupCache,
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
  middlewares: readonly MiddlewareRegistration[] // Array to preserve registration order
  extensions: readonly GraphQLExtension<any>[] // Array to preserve registration order
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
  pipe<A, B, C, D, E>(
    this: A,
    ab: (a: A) => B,
    bc: (b: B) => C,
    cd: (c: C) => D,
    de: (d: D) => E
  ): E
  pipe<A, B, C, D, E, F>(
    this: A,
    ab: (a: A) => B,
    bc: (b: B) => C,
    cd: (c: C) => D,
    de: (d: D) => E,
    ef: (e: E) => F
  ): F
  pipe<A, B, C, D, E, F, G>(
    this: A,
    ab: (a: A) => B,
    bc: (b: B) => C,
    cd: (c: C) => D,
    de: (d: D) => E,
    ef: (e: E) => F,
    fg: (f: F) => G
  ): G
  pipe<A, B, C, D, E, F, G, H>(
    this: A,
    ab: (a: A) => B,
    bc: (b: B) => C,
    cd: (c: C) => D,
    de: (d: D) => E,
    ef: (e: E) => F,
    fg: (f: F) => G,
    gh: (g: G) => H
  ): H
  pipe<A, B, C, D, E, F, G, H, I>(
    this: A,
    ab: (a: A) => B,
    bc: (b: B) => C,
    cd: (c: C) => D,
    de: (d: D) => E,
    ef: (e: E) => F,
    fg: (f: F) => G,
    gh: (g: G) => H,
    hi: (h: H) => I
  ): I
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
    middlewares: [],
    extensions: [],
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
      /**
       * Complexity cost of this field for query complexity limiting.
       * Can be a static number or a function that receives the resolved arguments.
       */
      complexity?: FieldComplexity
      /**
       * Cache control hint for this field.
       * Used to compute HTTP Cache-Control headers for the response.
       */
      cacheControl?: CacheHint
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
      /**
       * Complexity cost of this field for query complexity limiting.
       * Can be a static number or a function that receives the resolved arguments.
       */
      complexity?: FieldComplexity
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
      /**
       * Complexity cost of this subscription for query complexity limiting.
       * Can be a static number or a function that receives the resolved arguments.
       */
      complexity?: FieldComplexity
      /**
       * Cache control hint for this subscription.
       * Note: Subscriptions are typically not cached, but this can be used for initial response hints.
       */
      cacheControl?: CacheHint
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
    /**
     * Default cache control hint for all fields returning this type.
     * Can be overridden by field-level cacheControl.
     */
    cacheControl?: CacheHint
    fields?: Record<
      string,
      {
        type: S.Schema<any, any, any>
        args?: S.Schema<any, any, any>
        description?: string
        directives?: readonly DirectiveApplication[]
        /**
         * Complexity cost of this field for query complexity limiting.
         */
        complexity?: FieldComplexity
        /**
         * Cache control hint for this field.
         */
        cacheControl?: CacheHint
        resolve: (parent: A, args: any) => Effect.Effect<any, any, any>
      }
    >
  }): GraphQLSchemaBuilder<R | R2> {
    const { schema, implements: implementsInterfaces, directives, cacheControl, fields } = config
    const name = config.name ?? getSchemaName(schema)
    if (!name) {
      throw new Error(
        "objectType requires a name. Either provide one explicitly or use a TaggedStruct/TaggedClass/Schema.Class"
      )
    }

    const newTypes = new Map(this.state.types)
    newTypes.set(name, { name, schema, implements: implementsInterfaces, directives, cacheControl })

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
    directives?: readonly DirectiveApplication[]
  }): GraphQLSchemaBuilder<R> {
    const { schema, resolveType, directives } = config
    const name = config.name ?? getSchemaName(schema)
    if (!name) {
      throw new Error(
        "interfaceType requires a name. Either provide one explicitly or use a TaggedStruct/TaggedClass/Schema.Class"
      )
    }

    const newInterfaces = new Map(this.state.interfaces)
    newInterfaces.set(name, {
      name,
      schema,
      resolveType: resolveType ?? ((value: any) => value._tag),
      directives,
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
    directives?: readonly DirectiveApplication[]
  }): GraphQLSchemaBuilder<R> {
    const { name, values, description, directives } = config
    const newEnums = new Map(this.state.enums)
    newEnums.set(name, { name, values, description, directives })
    return this.with(updateState(this.state, "enums", newEnums))
  }

  /**
   * Register a union type
   */
  unionType(config: {
    name: string
    types: readonly string[]
    resolveType?: (value: any) => string
    directives?: readonly DirectiveApplication[]
  }): GraphQLSchemaBuilder<R> {
    const { name, types, resolveType, directives } = config
    const newUnions = new Map(this.state.unions)
    newUnions.set(name, {
      name,
      types,
      resolveType: resolveType ?? ((value: any) => value._tag),
      directives,
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
    directives?: readonly DirectiveApplication[]
  }): GraphQLSchemaBuilder<R> {
    const { schema, description, directives } = config
    const name = config.name ?? getSchemaName(schema)
    if (!name) {
      throw new Error(
        "inputType requires a name. Either provide one explicitly or use a TaggedStruct/TaggedClass/Schema.Class"
      )
    }

    const newInputs = new Map(this.state.inputs)
    newInputs.set(name, { name, schema, description, directives })
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
    apply?: (
      args: Args
    ) => <A, E, R3>(effect: Effect.Effect<A, E, R3>) => Effect.Effect<A, E, R2 | R3>
  }): GraphQLSchemaBuilder<R | R2> {
    const newDirectives = new Map(this.state.directives)
    newDirectives.set(config.name, config as DirectiveRegistration)
    return this.with(updateState(this.state, "directives", newDirectives))
  }

  /**
   * Register a middleware
   *
   * Middleware wraps all resolvers (or those matching a pattern) and executes
   * in an "onion" model - first registered middleware is the outermost layer.
   *
   * @param config.name - Middleware name (for debugging/logging)
   * @param config.description - Optional description
   * @param config.match - Optional predicate to filter which fields this applies to
   * @param config.apply - Function that transforms the resolver Effect
   *
   * @example
   * ```typescript
   * builder.middleware({
   *   name: "logging",
   *   apply: (effect, ctx) => Effect.gen(function*() {
   *     yield* Effect.logInfo(`Resolving ${ctx.info.fieldName}`)
   *     const start = Date.now()
   *     const result = yield* effect
   *     yield* Effect.logInfo(`Resolved in ${Date.now() - start}ms`)
   *     return result
   *   })
   * })
   * ```
   */
  middleware<R2 = never>(config: {
    name: string
    description?: string
    match?: (info: GraphQLResolveInfo) => boolean
    apply: <A, E, R3>(
      effect: Effect.Effect<A, E, R3>,
      context: MiddlewareContext
    ) => Effect.Effect<A, E, R2 | R3>
  }): GraphQLSchemaBuilder<R | R2> {
    const newMiddlewares = [...this.state.middlewares, config as MiddlewareRegistration]
    return this.with({ ...this.state, middlewares: newMiddlewares })
  }

  /**
   * Register an extension
   *
   * Extensions provide lifecycle hooks that run at each phase of request processing
   * (parse, validate, execute) and can contribute data to the response's extensions field.
   *
   * @param config.name - Extension name (for debugging/logging)
   * @param config.description - Optional description
   * @param config.onParse - Called after query parsing
   * @param config.onValidate - Called after validation
   * @param config.onExecuteStart - Called before execution begins
   * @param config.onExecuteEnd - Called after execution completes
   *
   * @example
   * ```typescript
   * builder.extension({
   *   name: "tracing",
   *   onExecuteStart: () => Effect.gen(function*() {
   *     const ext = yield* ExtensionsService
   *     yield* ext.set("tracing", { startTime: Date.now() })
   *   }),
   *   onExecuteEnd: () => Effect.gen(function*() {
   *     const ext = yield* ExtensionsService
   *     yield* ext.merge("tracing", { endTime: Date.now() })
   *   }),
   * })
   * ```
   */
  extension<R2 = never>(config: {
    name: string
    description?: string
    onParse?: (source: string, document: DocumentNode) => Effect.Effect<void, never, R2>
    onValidate?: (
      document: DocumentNode,
      errors: readonly GQLError[]
    ) => Effect.Effect<void, never, R2>
    onExecuteStart?: (args: ExecutionArgs) => Effect.Effect<void, never, R2>
    onExecuteEnd?: (result: ExecutionResult) => Effect.Effect<void, never, R2>
  }): GraphQLSchemaBuilder<R | R2> {
    const newExtensions = [...this.state.extensions, config as GraphQLExtension<R2>]
    return this.with({ ...this.state, extensions: newExtensions })
  }

  /**
   * Get the registered extensions for use by the execution layer
   */
  getExtensions(): readonly GraphQLExtension<any>[] {
    return this.state.extensions
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
      /**
       * Complexity cost of this field for query complexity limiting.
       * Can be a static number or a function that receives the resolved arguments.
       */
      complexity?: FieldComplexity
      /**
       * Cache control hint for this field.
       * Used to compute HTTP Cache-Control headers for the response.
       */
      cacheControl?: CacheHint
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
   * Get the field complexity map for use in complexity validation.
   * Maps "TypeName.fieldName" to the complexity value or function.
   */
  getFieldComplexities(): FieldComplexityMap {
    const complexities: FieldComplexityMap = new Map()

    // Query fields
    for (const [name, config] of this.state.queries) {
      if (config.complexity !== undefined) {
        complexities.set(`Query.${name}`, config.complexity)
      }
    }

    // Mutation fields
    for (const [name, config] of this.state.mutations) {
      if (config.complexity !== undefined) {
        complexities.set(`Mutation.${name}`, config.complexity)
      }
    }

    // Subscription fields
    for (const [name, config] of this.state.subscriptions) {
      if (config.complexity !== undefined) {
        complexities.set(`Subscription.${name}`, config.complexity)
      }
    }

    // Object type fields
    for (const [typeName, fields] of this.state.objectFields) {
      for (const [fieldName, config] of fields) {
        if (config.complexity !== undefined) {
          complexities.set(`${typeName}.${fieldName}`, config.complexity)
        }
      }
    }

    return complexities
  }

  /**
   * Get the cache hint map for use in cache control calculation.
   * Maps "TypeName.fieldName" to the cache hint for field-level hints,
   * or "TypeName" to the cache hint for type-level hints.
   */
  getCacheHints(): CacheHintMap {
    const hints: CacheHintMap = new Map()

    // Type-level hints
    for (const [typeName, typeReg] of this.state.types) {
      if (typeReg.cacheControl !== undefined) {
        hints.set(typeName, typeReg.cacheControl)
      }
    }

    // Query fields
    for (const [name, config] of this.state.queries) {
      if (config.cacheControl !== undefined) {
        hints.set(`Query.${name}`, config.cacheControl)
      }
    }

    // Subscription fields
    for (const [name, config] of this.state.subscriptions) {
      if (config.cacheControl !== undefined) {
        hints.set(`Subscription.${name}`, config.cacheControl)
      }
    }

    // Object type fields
    for (const [typeName, fields] of this.state.objectFields) {
      for (const [fieldName, config] of fields) {
        if (config.cacheControl !== undefined) {
          hints.set(`${typeName}.${fieldName}`, config.cacheControl)
        }
      }
    }

    return hints
  }

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

    // Build cache once for O(1) lookups across all directives
    const cache = buildInputTypeLookupCache(this.state.inputs, this.state.enums)

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
              this.state.enums,
              cache
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
      registry.set(
        name,
        new GraphQLEnumType({
          name,
          values: enumValues,
          description: reg.description,
          extensions: reg.directives ? { directives: reg.directives } : undefined,
        })
      )
    }

    return registry
  }

  private buildInputRegistry(
    enumRegistry: Map<string, GraphQLEnumType>
  ): Map<string, GraphQLInputObjectType> {
    const registry = new Map<string, GraphQLInputObjectType>()

    // Build cache once for O(1) lookups across all input types
    const cache = buildInputTypeLookupCache(this.state.inputs, this.state.enums)

    for (const [name, reg] of this.state.inputs) {
      const inputType = new GraphQLInputObjectType({
        name,
        description: reg.description,
        fields: () =>
          schemaToInputFields(
            reg.schema,
            enumRegistry,
            registry,
            this.state.inputs,
            this.state.enums,
            cache
          ),
        extensions: reg.directives ? { directives: reg.directives } : undefined,
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
        extensions: reg.directives ? { directives: reg.directives } : undefined,
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
      const implementedInterfaces =
        typeReg.implements?.map((name) => interfaceRegistry.get(name)!).filter(Boolean) ?? []

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
        extensions: typeReg.directives ? { directives: typeReg.directives } : undefined,
      })
      typeRegistry.set(typeName, graphqlType)
    }

    // Build union types (reference object types)
    for (const [name, reg] of this.state.unions) {
      const unionType = new GraphQLUnionType({
        name,
        types: () => reg.types.map((typeName) => typeRegistry.get(typeName)!).filter(Boolean),
        resolveType: reg.resolveType,
        extensions: reg.directives ? { directives: reg.directives } : undefined,
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
    // Build cache once for O(1) input type lookups across all fields
    const inputTypeLookupCache = buildInputTypeLookupCache(this.state.inputs, this.state.enums)

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
      middlewares: this.state.middlewares,
      inputTypeLookupCache,
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
      directives:
        registries.directiveRegistry.size > 0
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
