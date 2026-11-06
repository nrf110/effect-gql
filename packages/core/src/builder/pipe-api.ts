import { Effect, Stream } from "effect"
import * as S from "effect/Schema"
import {
  DirectiveLocation,
  GraphQLResolveInfo,
  DocumentNode,
  ExecutionResult,
  GraphQLError,
} from "graphql"
import type {
  DirectiveApplication,
  MiddlewareContext,
  CacheHint,
  ObjectFieldRegistration,
  ObjectFieldsServices,
} from "./types"
import type { ExecutionArgs } from "../extensions"
import { GraphQLSchemaBuilder } from "./schema-builder"
import type { FieldComplexity } from "../server/complexity"

declare const operationServices: unique symbol

// Generic function return types erase their input requirements to unknown.
// Optional type-only metadata preserves the added services without runtime fields.
interface SchemaOperation<R> {
  <RIn>(builder: GraphQLSchemaBuilder<RIn>): GraphQLSchemaBuilder<RIn | R>
  readonly [operationServices]?: R
}

type OperationServices<Operation> = Operation extends SchemaOperation<infer R> ? R : never

/**
 * Add an object type to the schema builder (pipe-able)
 * Name is optional if schema is TaggedStruct, TaggedClass, or Schema.Class
 */
export const objectType =
  <
    A,
    Fields extends Record<
      string,
      ObjectFieldRegistration<A, any, unknown, unknown, unknown, unknown>
    > = {},
  >(config: {
    name?: string
    schema: S.Schema<A>
    description?: string
    implements?: readonly string[]
    directives?: readonly DirectiveApplication[]
    /**
     * Default cache control hint for all fields returning this type.
     * Can be overridden by field-level cacheControl.
     */
    cacheControl?: CacheHint
    fields?: Fields &
      Record<string, ObjectFieldRegistration<A, any, unknown, unknown, unknown, unknown>>
  }): SchemaOperation<ObjectFieldsServices<Fields>> =>
  <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R | ObjectFieldsServices<Fields>> =>
    builder.objectType(config)

/**
 * Add an interface type to the schema builder (pipe-able)
 * Name is optional if schema is TaggedStruct, TaggedClass, or Schema.Class
 */
export const interfaceType =
  (config: {
    name?: string
    schema: S.Schema<any>
    resolveType?: (value: any) => string
    directives?: readonly DirectiveApplication[]
  }): SchemaOperation<never> =>
  <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R> =>
    builder.interfaceType(config)

/**
 * Add an enum type to the schema builder (pipe-able)
 */
export const enumType =
  (config: {
    name: string
    values: readonly string[]
    description?: string
    directives?: readonly DirectiveApplication[]
  }): SchemaOperation<never> =>
  <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R> =>
    builder.enumType(config)

/**
 * Add a union type to the schema builder (pipe-able)
 */
export const unionType =
  (config: {
    name: string
    types: readonly string[]
    resolveType?: (value: any) => string
    directives?: readonly DirectiveApplication[]
  }): SchemaOperation<never> =>
  <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R> =>
    builder.unionType(config)

/**
 * Add an input type to the schema builder (pipe-able)
 * Name is optional if schema is TaggedStruct, TaggedClass, or Schema.Class
 */
export const inputType =
  (config: {
    name?: string
    schema: S.Schema<any>
    description?: string
    directives?: readonly DirectiveApplication[]
  }): SchemaOperation<never> =>
  <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R> =>
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
export const directive =
  <Args = void, R2 = never>(config: {
    name: string
    description?: string
    locations: readonly DirectiveLocation[]
    args?: S.Schema<Args>
    apply?: (
      args: Args
    ) => <A, E, R3>(effect: Effect.Effect<A, E, R3>) => Effect.Effect<A, E, R2 | R3>
  }): SchemaOperation<R2> =>
  <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R | R2> =>
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
export const middleware =
  <R2 = never>(config: {
    name: string
    description?: string
    match?: (info: GraphQLResolveInfo) => boolean
    apply: <A, E, R3>(
      effect: Effect.Effect<A, E, R3>,
      context: MiddlewareContext
    ) => Effect.Effect<A, E, R2 | R3>
  }): SchemaOperation<R2> =>
  <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R | R2> =>
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
export const extension =
  <R2 = never>(config: {
    name: string
    description?: string
    onParse?: (source: string, document: DocumentNode) => Effect.Effect<void, never, R2>
    onValidate?: (
      document: DocumentNode,
      errors: readonly GraphQLError[]
    ) => Effect.Effect<void, never, R2>
    onExecuteStart?: (args: ExecutionArgs) => Effect.Effect<void, never, R2>
    onExecuteEnd?: (result: ExecutionResult) => Effect.Effect<void, never, R2>
  }): SchemaOperation<R2> =>
  <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R | R2> =>
    builder.extension(config)

/**
 * Add a query field to the schema builder (pipe-able)
 */
export const query =
  <A, E, R2, Args = void, RArgs = never>(
    name: string,
    config: {
      type: S.Schema<A>
      args?: S.Decoder<Args, RArgs>
      description?: string
      directives?: readonly DirectiveApplication[]
      complexity?: FieldComplexity
      cacheControl?: CacheHint
      resolve: (args: Args) => Effect.Effect<A, E, R2>
    }
  ): SchemaOperation<R2 | RArgs> =>
  <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R | R2 | RArgs> =>
    builder.query(name, config)

/**
 * Add a mutation field to the schema builder (pipe-able)
 */
export const mutation =
  <A, E, R2, Args = void, RArgs = never>(
    name: string,
    config: {
      type: S.Schema<A>
      args?: S.Decoder<Args, RArgs>
      description?: string
      directives?: readonly DirectiveApplication[]
      complexity?: FieldComplexity
      resolve: (args: Args) => Effect.Effect<A, E, R2>
    }
  ): SchemaOperation<R2 | RArgs> =>
  <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R | R2 | RArgs> =>
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
export const subscription =
  <A, E, R2, Args = void, RArgs = never>(
    name: string,
    config: {
      type: S.Schema<A>
      args?: S.Decoder<Args, RArgs>
      description?: string
      directives?: readonly DirectiveApplication[]
      complexity?: FieldComplexity
      cacheControl?: CacheHint
      subscribe: (args: Args) => Effect.Effect<Stream.Stream<A, E, R2>, E, R2>
      resolve?: (value: A, args: Args) => Effect.Effect<A, E, R2>
    }
  ): SchemaOperation<R2 | RArgs> =>
  <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R | R2 | RArgs> =>
    builder.subscription(name, config)

/**
 * Add a field to an existing object type (pipe-able)
 */
export const field =
  <Parent, A, E, R2, Args = void, RArgs = never>(
    typeName: string,
    fieldName: string,
    config: {
      type: S.Schema<A>
      args?: S.Decoder<Args, RArgs>
      description?: string
      directives?: readonly DirectiveApplication[]
      complexity?: FieldComplexity
      cacheControl?: CacheHint
      resolve: (parent: Parent, args: Args) => Effect.Effect<A, E, R2>
    }
  ): SchemaOperation<R2 | RArgs> =>
  <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<R | R2 | RArgs> =>
    builder.field(typeName, fieldName, config)

/**
 * Compose multiple schema operations (helper for arrays)
 * Concrete inference slots instantiate custom generic callbacks at a service-free
 * builder. Conditional return-type extraction alone erases them to unknown.
 * The variadic fallback retains annotated built-in/composed operation arrays.
 */
export function compose(): SchemaOperation<never>
export function compose<R1>(
  operation1: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R1>
): SchemaOperation<R1>
export function compose<R1, R2>(
  operation1: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R1>,
  operation2: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R2>
): SchemaOperation<R1 | R2>
export function compose<R1, R2, R3>(
  operation1: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R1>,
  operation2: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R2>,
  operation3: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R3>
): SchemaOperation<R1 | R2 | R3>
export function compose<R1, R2, R3, R4>(
  operation1: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R1>,
  operation2: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R2>,
  operation3: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R3>,
  operation4: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R4>
): SchemaOperation<R1 | R2 | R3 | R4>
export function compose<R1, R2, R3, R4, R5>(
  operation1: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R1>,
  operation2: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R2>,
  operation3: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R3>,
  operation4: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R4>,
  operation5: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R5>
): SchemaOperation<R1 | R2 | R3 | R4 | R5>
export function compose<R1, R2, R3, R4, R5, R6>(
  operation1: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R1>,
  operation2: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R2>,
  operation3: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R3>,
  operation4: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R4>,
  operation5: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R5>,
  operation6: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R6>
): SchemaOperation<R1 | R2 | R3 | R4 | R5 | R6>
export function compose<R1, R2, R3, R4, R5, R6, R7>(
  operation1: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R1>,
  operation2: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R2>,
  operation3: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R3>,
  operation4: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R4>,
  operation5: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R5>,
  operation6: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R6>,
  operation7: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R7>
): SchemaOperation<R1 | R2 | R3 | R4 | R5 | R6 | R7>
export function compose<R1, R2, R3, R4, R5, R6, R7, R8>(
  operation1: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R1>,
  operation2: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R2>,
  operation3: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R3>,
  operation4: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R4>,
  operation5: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R5>,
  operation6: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R6>,
  operation7: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R7>,
  operation8: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R8>
): SchemaOperation<R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8>
export function compose<R1, R2, R3, R4, R5, R6, R7, R8, R9>(
  operation1: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R1>,
  operation2: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R2>,
  operation3: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R3>,
  operation4: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R4>,
  operation5: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R5>,
  operation6: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R6>,
  operation7: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R7>,
  operation8: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R8>,
  operation9: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R9>
): SchemaOperation<R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 | R9>
export function compose<R1, R2, R3, R4, R5, R6, R7, R8, R9, R10>(
  operation1: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R1>,
  operation2: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R2>,
  operation3: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R3>,
  operation4: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R4>,
  operation5: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R5>,
  operation6: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R6>,
  operation7: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R7>,
  operation8: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R8>,
  operation9: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R9>,
  operation10: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R10>
): SchemaOperation<R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 | R9 | R10>
export function compose<R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11>(
  operation1: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R1>,
  operation2: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R2>,
  operation3: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R3>,
  operation4: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R4>,
  operation5: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R5>,
  operation6: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R6>,
  operation7: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R7>,
  operation8: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R8>,
  operation9: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R9>,
  operation10: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R10>,
  operation11: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R11>
): SchemaOperation<R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 | R9 | R10 | R11>
export function compose<R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12>(
  operation1: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R1>,
  operation2: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R2>,
  operation3: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R3>,
  operation4: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R4>,
  operation5: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R5>,
  operation6: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R6>,
  operation7: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R7>,
  operation8: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R8>,
  operation9: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R9>,
  operation10: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R10>,
  operation11: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R11>,
  operation12: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R12>
): SchemaOperation<R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 | R9 | R10 | R11 | R12>
export function compose<R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13>(
  operation1: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R1>,
  operation2: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R2>,
  operation3: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R3>,
  operation4: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R4>,
  operation5: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R5>,
  operation6: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R6>,
  operation7: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R7>,
  operation8: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R8>,
  operation9: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R9>,
  operation10: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R10>,
  operation11: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R11>,
  operation12: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R12>,
  operation13: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R13>
): SchemaOperation<R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 | R9 | R10 | R11 | R12 | R13>
export function compose<R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R14>(
  operation1: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R1>,
  operation2: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R2>,
  operation3: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R3>,
  operation4: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R4>,
  operation5: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R5>,
  operation6: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R6>,
  operation7: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R7>,
  operation8: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R8>,
  operation9: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R9>,
  operation10: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R10>,
  operation11: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R11>,
  operation12: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R12>,
  operation13: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R13>,
  operation14: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R14>
): SchemaOperation<R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 | R9 | R10 | R11 | R12 | R13 | R14>
export function compose<R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R14, R15>(
  operation1: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R1>,
  operation2: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R2>,
  operation3: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R3>,
  operation4: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R4>,
  operation5: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R5>,
  operation6: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R6>,
  operation7: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R7>,
  operation8: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R8>,
  operation9: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R9>,
  operation10: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R10>,
  operation11: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R11>,
  operation12: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R12>,
  operation13: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R13>,
  operation14: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R14>,
  operation15: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R15>
): SchemaOperation<R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 | R9 | R10 | R11 | R12 | R13 | R14 | R15>
export function compose<R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R14, R15, R16>(
  operation1: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R1>,
  operation2: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R2>,
  operation3: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R3>,
  operation4: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R4>,
  operation5: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R5>,
  operation6: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R6>,
  operation7: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R7>,
  operation8: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R8>,
  operation9: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R9>,
  operation10: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R10>,
  operation11: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R11>,
  operation12: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R12>,
  operation13: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R13>,
  operation14: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R14>,
  operation15: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R15>,
  operation16: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R16>
): SchemaOperation<
  R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 | R9 | R10 | R11 | R12 | R13 | R14 | R15 | R16
>
export function compose<R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R14, R15, R16, R17>(
  operation1: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R1>,
  operation2: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R2>,
  operation3: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R3>,
  operation4: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R4>,
  operation5: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R5>,
  operation6: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R6>,
  operation7: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R7>,
  operation8: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R8>,
  operation9: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R9>,
  operation10: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R10>,
  operation11: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R11>,
  operation12: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R12>,
  operation13: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R13>,
  operation14: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R14>,
  operation15: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R15>,
  operation16: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R16>,
  operation17: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R17>
): SchemaOperation<
  R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 | R9 | R10 | R11 | R12 | R13 | R14 | R15 | R16 | R17
>
export function compose<
  R1,
  R2,
  R3,
  R4,
  R5,
  R6,
  R7,
  R8,
  R9,
  R10,
  R11,
  R12,
  R13,
  R14,
  R15,
  R16,
  R17,
  R18,
>(
  operation1: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R1>,
  operation2: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R2>,
  operation3: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R3>,
  operation4: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R4>,
  operation5: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R5>,
  operation6: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R6>,
  operation7: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R7>,
  operation8: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R8>,
  operation9: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R9>,
  operation10: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R10>,
  operation11: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R11>,
  operation12: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R12>,
  operation13: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R13>,
  operation14: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R14>,
  operation15: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R15>,
  operation16: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R16>,
  operation17: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R17>,
  operation18: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R18>
): SchemaOperation<
  R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 | R9 | R10 | R11 | R12 | R13 | R14 | R15 | R16 | R17 | R18
>
export function compose<
  R1,
  R2,
  R3,
  R4,
  R5,
  R6,
  R7,
  R8,
  R9,
  R10,
  R11,
  R12,
  R13,
  R14,
  R15,
  R16,
  R17,
  R18,
  R19,
>(
  operation1: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R1>,
  operation2: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R2>,
  operation3: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R3>,
  operation4: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R4>,
  operation5: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R5>,
  operation6: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R6>,
  operation7: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R7>,
  operation8: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R8>,
  operation9: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R9>,
  operation10: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R10>,
  operation11: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R11>,
  operation12: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R12>,
  operation13: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R13>,
  operation14: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R14>,
  operation15: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R15>,
  operation16: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R16>,
  operation17: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R17>,
  operation18: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R18>,
  operation19: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R19>
): SchemaOperation<
  | R1
  | R2
  | R3
  | R4
  | R5
  | R6
  | R7
  | R8
  | R9
  | R10
  | R11
  | R12
  | R13
  | R14
  | R15
  | R16
  | R17
  | R18
  | R19
>
export function compose<
  R1,
  R2,
  R3,
  R4,
  R5,
  R6,
  R7,
  R8,
  R9,
  R10,
  R11,
  R12,
  R13,
  R14,
  R15,
  R16,
  R17,
  R18,
  R19,
  R20,
>(
  operation1: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R1>,
  operation2: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R2>,
  operation3: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R3>,
  operation4: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R4>,
  operation5: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R5>,
  operation6: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R6>,
  operation7: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R7>,
  operation8: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R8>,
  operation9: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R9>,
  operation10: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R10>,
  operation11: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R11>,
  operation12: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R12>,
  operation13: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R13>,
  operation14: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R14>,
  operation15: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R15>,
  operation16: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R16>,
  operation17: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R17>,
  operation18: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R18>,
  operation19: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R19>,
  operation20: (builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R20>
): SchemaOperation<
  | R1
  | R2
  | R3
  | R4
  | R5
  | R6
  | R7
  | R8
  | R9
  | R10
  | R11
  | R12
  | R13
  | R14
  | R15
  | R16
  | R17
  | R18
  | R19
  | R20
>
export function compose<Operations extends readonly SchemaOperation<any>[]>(
  ...operations: Operations &
    (typeof operationServices extends keyof Operations[number] ? unknown : never)
): SchemaOperation<OperationServices<Operations[number]>>
export function compose<R>(
  ...operations: readonly ((builder: GraphQLSchemaBuilder<never>) => GraphQLSchemaBuilder<R>)[]
): SchemaOperation<R>
export function compose(
  ...operations: readonly ((builder: any) => GraphQLSchemaBuilder<any>)[]
): SchemaOperation<any> {
  return <R>(builder: GraphQLSchemaBuilder<R>): GraphQLSchemaBuilder<any> => {
    let result: GraphQLSchemaBuilder<any> = builder
    for (const operation of operations) result = operation(result)
    return result
  }
}
