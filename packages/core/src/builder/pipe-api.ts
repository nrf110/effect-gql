import { Effect, Stream } from "effect"
import * as S from "effect/Schema"
import { DirectiveLocation, GraphQLResolveInfo, DocumentNode, ExecutionResult, GraphQLError } from "graphql"
import type { DirectiveApplication, MiddlewareContext } from "./types"
import type { ExecutionArgs } from "../extensions"
import { GraphQLSchemaBuilder } from "./schema-builder"

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
 * Register a middleware (pipe-able)
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
 * GraphQLSchemaBuilder.empty.pipe(
 *   middleware({
 *     name: "logging",
 *     apply: (effect, ctx) => Effect.gen(function*() {
 *       yield* Effect.logInfo(`Resolving ${ctx.info.fieldName}`)
 *       return yield* effect
 *     })
 *   }),
 *   middleware({
 *     name: "adminOnly",
 *     match: (info) => info.fieldName.startsWith("admin"),
 *     apply: (effect) => Effect.gen(function*() {
 *       const auth = yield* AuthService
 *       yield* auth.requireAdmin()
 *       return yield* effect
 *     })
 *   })
 * )
 * ```
 */
export const middleware = <R2 = never>(config: {
  name: string
  description?: string
  match?: (info: GraphQLResolveInfo) => boolean
  apply: <A, E, R3>(
    effect: Effect.Effect<A, E, R3>,
    context: MiddlewareContext
  ) => Effect.Effect<A, E, R2 | R3>
}) => <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R | R2> =>
  builder.middleware(config)

/**
 * Register an extension (pipe-able)
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
 * GraphQLSchemaBuilder.empty.pipe(
 *   extension({
 *     name: "tracing",
 *     onExecuteStart: () => Effect.gen(function*() {
 *       const ext = yield* ExtensionsService
 *       yield* ext.set("tracing", { startTime: Date.now() })
 *     }),
 *     onExecuteEnd: () => Effect.gen(function*() {
 *       const ext = yield* ExtensionsService
 *       yield* ext.merge("tracing", { endTime: Date.now() })
 *     }),
 *   })
 * )
 * ```
 */
export const extension = <R2 = never>(config: {
  name: string
  description?: string
  onParse?: (source: string, document: DocumentNode) => Effect.Effect<void, never, R2>
  onValidate?: (document: DocumentNode, errors: readonly GraphQLError[]) => Effect.Effect<void, never, R2>
  onExecuteStart?: (args: ExecutionArgs) => Effect.Effect<void, never, R2>
  onExecuteEnd?: (result: ExecutionResult) => Effect.Effect<void, never, R2>
}) => <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R | R2> =>
  builder.extension(config)

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
