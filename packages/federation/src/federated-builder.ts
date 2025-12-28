import { Effect, Pipeable } from "effect"
import * as S from "effect/Schema"
import {
  GraphQLSchemaBuilder,
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLList,
  GraphQLNonNull,
  printSchema,
  type DirectiveApplication,
} from "@effect-gql/core"
import { AnyScalar, FieldSetScalar } from "./scalars"
import {
  createEntityUnion,
  createEntitiesResolver,
  createServiceType,
  createServiceResolver,
} from "./entities"
import type { EntityRegistration, FederatedSchemaConfig, FederatedSchemaResult } from "./types"
import { toDirectiveApplication } from "./types"

/**
 * Internal state for the federated builder
 */
interface FederatedBuilderState<R> {
  /** Underlying core builder */
  coreBuilder: GraphQLSchemaBuilder<R>
  /** Registered entities */
  entities: Map<string, EntityRegistration<any, any>>
  /** Federation version */
  version: string
}

/**
 * Federation-aware schema builder that extends the core GraphQLSchemaBuilder
 * with Apollo Federation 2.x support.
 *
 * @example
 * ```typescript
 * const schema = FederatedSchemaBuilder.empty
 *   .pipe(
 *     entity({
 *       name: "User",
 *       schema: UserSchema,
 *       keys: [key({ fields: "id" })],
 *       resolveReference: (ref) => UserService.findById(ref.id),
 *     }),
 *     query("me", {
 *       type: UserSchema,
 *       resolve: () => UserService.getCurrentUser(),
 *     }),
 *   )
 *   .buildFederatedSchema()
 * ```
 */
export class FederatedSchemaBuilder<R = never> implements Pipeable.Pipeable {
  private constructor(private readonly state: FederatedBuilderState<R>) {}

  /**
   * Pipeable interface implementation
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
  pipe() {
    return Pipeable.pipeArguments(this, arguments)
  }

  /**
   * Create an empty federated schema builder
   */
  static empty = new FederatedSchemaBuilder<never>({
    coreBuilder: GraphQLSchemaBuilder.empty,
    entities: new Map(),
    version: "2.3",
  })

  /**
   * Create a builder with custom configuration
   */
  static create(config: FederatedSchemaConfig = {}) {
    return new FederatedSchemaBuilder<never>({
      coreBuilder: GraphQLSchemaBuilder.empty,
      entities: new Map(),
      version: config.version ?? "2.3",
    })
  }

  /**
   * Create a new builder with updated state
   */
  private with<R2>(updates: Partial<FederatedBuilderState<R2>>): FederatedSchemaBuilder<R | R2> {
    return new FederatedSchemaBuilder({
      ...this.state,
      ...updates,
    } as FederatedBuilderState<R | R2>)
  }

  /**
   * Get the underlying core builder for advanced usage
   */
  get coreBuilder(): GraphQLSchemaBuilder<R> {
    return this.state.coreBuilder
  }

  // ============================================================================
  // Entity Registration
  // ============================================================================

  /**
   * Register an entity type with @key directive(s) and reference resolver.
   *
   * Entities are the core building block of Apollo Federation. They represent
   * types that can be resolved across subgraph boundaries using their key fields.
   *
   * @example
   * ```typescript
   * builder.entity({
   *   name: "User",
   *   schema: UserSchema,
   *   keys: [key({ fields: "id" })],
   *   resolveReference: (ref) => UserService.findById(ref.id),
   * })
   * ```
   */
  entity<A, R2>(config: EntityRegistration<A, R2>): FederatedSchemaBuilder<R | R2> {
    const { name, schema, keys, directives } = config

    // Build directive applications for the object type
    const typeDirectives: DirectiveApplication[] = [
      // Add @key directives
      ...keys.map(
        (k): DirectiveApplication => ({
          name: "key",
          args: {
            fields: k.fields,
            ...(k.resolvable !== undefined ? { resolvable: k.resolvable } : {}),
          },
        })
      ),
      // Add additional directives
      ...(directives?.map(toDirectiveApplication) ?? []),
    ]

    // Register the entity as an object type with directives
    const newCoreBuilder = this.state.coreBuilder.objectType({
      name,
      schema,
      directives: typeDirectives,
    })

    // Add to entities map
    const newEntities = new Map(this.state.entities)
    newEntities.set(name, config)

    return this.with({
      coreBuilder: newCoreBuilder as GraphQLSchemaBuilder<any>,
      entities: newEntities,
    })
  }

  // ============================================================================
  // Delegate to Core Builder
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
  ): FederatedSchemaBuilder<R | R2> {
    return this.with({
      coreBuilder: this.state.coreBuilder.query(name, config) as GraphQLSchemaBuilder<any>,
    })
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
  ): FederatedSchemaBuilder<R | R2> {
    return this.with({
      coreBuilder: this.state.coreBuilder.mutation(name, config) as GraphQLSchemaBuilder<any>,
    })
  }

  /**
   * Add a subscription field
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
  ): FederatedSchemaBuilder<R | R2> {
    return this.with({
      coreBuilder: this.state.coreBuilder.subscription(name, config) as GraphQLSchemaBuilder<any>,
    })
  }

  /**
   * Register an object type (non-entity)
   */
  objectType<A, R2 = never>(config: {
    name?: string
    schema: S.Schema<A, any, any>
    implements?: readonly string[]
    directives?: readonly DirectiveApplication[]
  }): FederatedSchemaBuilder<R | R2> {
    return this.with({
      coreBuilder: this.state.coreBuilder.objectType(config) as GraphQLSchemaBuilder<any>,
    })
  }

  /**
   * Register an interface type
   */
  interfaceType(config: {
    name?: string
    schema: S.Schema<any, any, any>
    resolveType?: (value: any) => string
    directives?: readonly DirectiveApplication[]
  }): FederatedSchemaBuilder<R> {
    return this.with({
      coreBuilder: this.state.coreBuilder.interfaceType(config),
    })
  }

  /**
   * Register an enum type
   */
  enumType(config: {
    name: string
    values: readonly string[]
    description?: string
    directives?: readonly DirectiveApplication[]
  }): FederatedSchemaBuilder<R> {
    return this.with({
      coreBuilder: this.state.coreBuilder.enumType(config),
    })
  }

  /**
   * Register a union type
   */
  unionType(config: {
    name: string
    types: readonly string[]
    resolveType?: (value: any) => string
    directives?: readonly DirectiveApplication[]
  }): FederatedSchemaBuilder<R> {
    return this.with({
      coreBuilder: this.state.coreBuilder.unionType(config),
    })
  }

  /**
   * Register an input type
   */
  inputType(config: {
    name?: string
    schema: S.Schema<any, any, any>
    description?: string
    directives?: readonly DirectiveApplication[]
  }): FederatedSchemaBuilder<R> {
    return this.with({
      coreBuilder: this.state.coreBuilder.inputType(config),
    })
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
  ): FederatedSchemaBuilder<R | R2> {
    return this.with({
      coreBuilder: this.state.coreBuilder.field(
        typeName,
        fieldName,
        config
      ) as GraphQLSchemaBuilder<any>,
    })
  }

  // ============================================================================
  // Schema Building
  // ============================================================================

  /**
   * Build the federated GraphQL schema with _entities and _service queries.
   *
   * Returns both the executable schema and the Federation-compliant SDL.
   */
  buildFederatedSchema(): FederatedSchemaResult {
    // Add a dummy query if no queries exist to ensure schema builds properly
    // This ensures all registered types are included in the schema
    let builderForSchema = this.state.coreBuilder

    // Check if we need a placeholder query by attempting to build
    // We need at least one query for GraphQL schema to be valid
    const needsPlaceholder = !this.hasQueryFields()

    if (needsPlaceholder) {
      builderForSchema = builderForSchema.query("_placeholder", {
        type: S.String,
        resolve: () => Effect.succeed("placeholder"),
      }) as GraphQLSchemaBuilder<any>
    }

    // Build the base schema with all types included
    const baseSchema = builderForSchema.buildSchema()

    // Get the type registry from the base schema
    const typeRegistry = new Map<string, GraphQLObjectType>()
    const typeMap = baseSchema.getTypeMap()

    for (const [name, type] of Object.entries(typeMap)) {
      // Use constructor name check instead of instanceof to handle multiple graphql instances
      const isObjectType = type.constructor.name === "GraphQLObjectType"
      if (isObjectType && !name.startsWith("__")) {
        typeRegistry.set(name, type as GraphQLObjectType)
      }
    }

    // Create federation types
    const entityUnion =
      this.state.entities.size > 0 ? createEntityUnion(this.state.entities, typeRegistry) : null
    const serviceType = createServiceType()

    // Build federation query fields
    const federationQueryFields: Record<string, any> = {}

    if (entityUnion) {
      federationQueryFields._entities = {
        type: new GraphQLNonNull(new GraphQLList(entityUnion)),
        args: {
          representations: {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(AnyScalar))),
          },
        },
        resolve: createEntitiesResolver(this.state.entities),
      }
    }

    // Generate SDL before adding _service (to avoid circular reference)
    const sdl = this.generateFederatedSDL(baseSchema, needsPlaceholder)

    federationQueryFields._service = {
      type: new GraphQLNonNull(serviceType),
      resolve: createServiceResolver(sdl),
    }

    // Build the final schema by extending the base Query type
    const baseQueryType = baseSchema.getQueryType()
    const baseQueryFields = baseQueryType?.getFields() ?? {}

    const queryType = new GraphQLObjectType({
      name: "Query",
      fields: () => {
        const fields: Record<string, any> = {}

        // Copy base query fields (excluding placeholder)
        for (const [name, field] of Object.entries(baseQueryFields)) {
          if (name === "_placeholder") continue
          fields[name] = {
            type: field.type,
            args: field.args.reduce(
              (acc, arg) => {
                acc[arg.name] = {
                  type: arg.type,
                  description: arg.description,
                  defaultValue: arg.defaultValue,
                }
                return acc
              },
              {} as Record<string, any>
            ),
            description: field.description,
            resolve: field.resolve,
            extensions: field.extensions,
          }
        }

        // Add federation fields
        Object.assign(fields, federationQueryFields)

        return fields
      },
    })

    // Collect all types for the schema
    const types: any[] = [AnyScalar, FieldSetScalar, serviceType]

    if (entityUnion) {
      types.push(entityUnion)
    }

    // Add all types from base schema except Query
    for (const [name, type] of Object.entries(typeMap)) {
      if (!name.startsWith("__") && name !== "Query") {
        types.push(type)
      }
    }

    const schema = new GraphQLSchema({
      query: queryType,
      mutation: baseSchema.getMutationType() ?? undefined,
      subscription: baseSchema.getSubscriptionType() ?? undefined,
      types,
    })

    return { schema, sdl }
  }

  /**
   * Check if the core builder has any query fields registered
   */
  private hasQueryFields(): boolean {
    // We need to check if there are any queries registered
    // Since we can't access private state, we try building and check
    try {
      const schema = this.state.coreBuilder.buildSchema()
      const queryType = schema.getQueryType()
      return queryType !== null && queryType !== undefined
    } catch {
      return false
    }
  }

  /**
   * Build a standard (non-federated) schema.
   * Useful for testing or running without a gateway.
   */
  buildSchema(): GraphQLSchema {
    return this.state.coreBuilder.buildSchema()
  }

  // ============================================================================
  // SDL Generation
  // ============================================================================

  /**
   * Generate Federation-compliant SDL with directive annotations.
   */
  private generateFederatedSDL(schema: GraphQLSchema, excludePlaceholder: boolean = false): string {
    // Start with federation schema extension
    const lines: string[] = [
      `extend schema @link(url: "https://specs.apollo.dev/federation/v${this.state.version}", import: ["@key", "@shareable", "@external", "@requires", "@provides", "@override", "@inaccessible", "@interfaceObject", "@tag"])`,
      "",
    ]

    // Print the base schema SDL
    let baseSDL = printSchema(schema)

    // Remove placeholder query if it was added
    if (excludePlaceholder) {
      baseSDL = baseSDL.replace(/\s*_placeholder:\s*String\n?/g, "")
    }

    // Process the SDL to add directive annotations
    const annotatedSDL = this.annotateSDLWithDirectives(baseSDL, schema)

    lines.push(annotatedSDL)

    return lines.join("\n")
  }

  /**
   * Annotate SDL types with their federation directives from extensions.
   */
  private annotateSDLWithDirectives(sdl: string, schema: GraphQLSchema): string {
    const typeMap = schema.getTypeMap()
    let result = sdl

    for (const [typeName, type] of Object.entries(typeMap)) {
      if (typeName.startsWith("__")) continue

      const directives = (type.extensions as any)?.directives as DirectiveApplication[] | undefined
      if (!directives || directives.length === 0) continue

      const directiveStr = directives.map(formatDirective).join(" ")

      // Match type definition and add directives
      const typePattern = new RegExp(
        `(type\\s+${typeName}(?:\\s+implements\\s+[^{]+)?)(\\s*\\{)`,
        "g"
      )
      result = result.replace(typePattern, `$1 ${directiveStr}$2`)

      const interfacePattern = new RegExp(`(interface\\s+${typeName})(\\s*\\{)`, "g")
      result = result.replace(interfacePattern, `$1 ${directiveStr}$2`)

      const enumPattern = new RegExp(`(enum\\s+${typeName})(\\s*\\{)`, "g")
      result = result.replace(enumPattern, `$1 ${directiveStr}$2`)

      const unionPattern = new RegExp(`(union\\s+${typeName})(\\s*=)`, "g")
      result = result.replace(unionPattern, `$1 ${directiveStr}$2`)

      const inputPattern = new RegExp(`(input\\s+${typeName})(\\s*\\{)`, "g")
      result = result.replace(inputPattern, `$1 ${directiveStr}$2`)
    }

    // Also annotate fields with directives
    for (const [typeName, type] of Object.entries(typeMap)) {
      if (typeName.startsWith("__")) continue
      if (!(type instanceof GraphQLObjectType)) continue

      const fields = type.getFields()
      for (const [fieldName, field] of Object.entries(fields)) {
        const fieldDirectives = (field.extensions as any)?.directives as
          | DirectiveApplication[]
          | undefined
        if (!fieldDirectives || fieldDirectives.length === 0) continue

        const directiveStr = fieldDirectives.map(formatDirective).join(" ")

        // Only replace within the context of this type
        const typeBlockPattern = new RegExp(
          `(type\\s+${typeName}[^{]*\\{[\\s\\S]*?)(${fieldName}(?:\\([^)]*\\))?:\\s*[^\\n]+?)([\\n}])`,
          "g"
        )
        result = result.replace(typeBlockPattern, `$1$2 ${directiveStr}$3`)
      }
    }

    return result
  }
}

/**
 * Format a DirectiveApplication as SDL string
 */
function formatDirective(directive: DirectiveApplication): string {
  if (!directive.args || Object.keys(directive.args).length === 0) {
    return `@${directive.name}`
  }

  const args = Object.entries(directive.args)
    .map(([key, value]) => {
      if (typeof value === "string") {
        return `${key}: "${value}"`
      }
      return `${key}: ${JSON.stringify(value)}`
    })
    .join(", ")

  return `@${directive.name}(${args})`
}
