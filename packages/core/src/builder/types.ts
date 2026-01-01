import { Effect, Runtime, Stream } from "effect"
import * as S from "effect/Schema"
import { DirectiveLocation, GraphQLResolveInfo } from "graphql"
import type { FieldComplexity } from "../server/complexity"

/**
 * Cache control scope determines whether a cached response can be shared.
 * - PUBLIC: Response can be cached by CDNs and shared across users
 * - PRIVATE: Response is user-specific and should only be cached in browsers
 */
export type CacheControlScope = "PUBLIC" | "PRIVATE"

/**
 * Cache control hint for a type or field.
 * Used to compute the overall cache policy for a GraphQL response.
 */
export interface CacheHint {
  /**
   * Maximum age in seconds that this field's value can be cached.
   * The response's maxAge will be the minimum of all field maxAges.
   */
  readonly maxAge?: number

  /**
   * Whether the cached value is user-specific (PRIVATE) or shared (PUBLIC).
   * If any field is PRIVATE, the entire response is PRIVATE.
   */
  readonly scope?: CacheControlScope

  /**
   * When true, this field inherits its maxAge from the parent field
   * instead of using the default (which is 0 for root fields).
   * Cannot be used together with maxAge.
   */
  readonly inheritMaxAge?: boolean
}

/**
 * Configuration for a query or mutation field
 */
export interface FieldRegistration<Args = any, A = any, E = any, R = any> {
  type: S.Schema<A, any, any>
  args?: S.Schema<Args, any, any>
  description?: string
  directives?: readonly DirectiveApplication[]
  /**
   * Complexity cost of this field.
   * Can be a static number or a function that receives the resolved arguments.
   * Used for query complexity limiting.
   *
   * @example
   * // Static cost
   * complexity: 5
   *
   * // Dynamic cost based on pagination
   * complexity: (args) => args.limit * 2
   */
  complexity?: FieldComplexity
  /**
   * Cache control hint for this field.
   * Used to compute HTTP Cache-Control headers for the response.
   *
   * @example
   * // Cache for 1 hour
   * cacheControl: { maxAge: 3600 }
   *
   * // User-specific data, don't cache in CDN
   * cacheControl: { maxAge: 60, scope: "PRIVATE" }
   */
  cacheControl?: CacheHint
  resolve: (args: Args) => Effect.Effect<A, E, R>
}

/**
 * Configuration for an object type
 */
export interface TypeRegistration {
  name: string
  schema: S.Schema<any, any, any>
  description?: string
  implements?: readonly string[]
  directives?: readonly DirectiveApplication[]
  /**
   * Default cache control hint for all fields returning this type.
   * Can be overridden by field-level cacheControl.
   *
   * @example
   * // All User fields cacheable for 1 hour by default
   * cacheControl: { maxAge: 3600 }
   */
  cacheControl?: CacheHint
}

/**
 * Configuration for an interface type
 */
export interface InterfaceRegistration {
  name: string
  schema: S.Schema<any, any, any>
  resolveType: (value: any) => string
  directives?: readonly DirectiveApplication[]
}

/**
 * Configuration for an enum type
 */
export interface EnumRegistration {
  name: string
  values: readonly string[]
  description?: string
  directives?: readonly DirectiveApplication[]
}

/**
 * Configuration for a union type
 */
export interface UnionRegistration {
  name: string
  types: readonly string[]
  resolveType: (value: any) => string
  directives?: readonly DirectiveApplication[]
}

/**
 * Configuration for an input type
 */
export interface InputTypeRegistration {
  name: string
  schema: S.Schema<any, any, any>
  description?: string
  directives?: readonly DirectiveApplication[]
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
export interface DirectiveRegistration<Args = any, R = never> {
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
 * Context passed to middleware apply functions
 * Contains the resolver's parent value, arguments, and GraphQL resolve info
 */
export interface MiddlewareContext<Parent = any, Args = any> {
  readonly parent: Parent
  readonly args: Args
  readonly info: GraphQLResolveInfo
}

/**
 * Configuration for middleware registration
 *
 * Middleware wraps all resolvers (or those matching a pattern) and executes
 * in an "onion" model - first registered middleware is the outermost layer.
 *
 * Unlike directives which are applied per-field explicitly, middleware is
 * applied globally or via pattern matching.
 *
 * @example
 * ```typescript
 * // Logging middleware - applies to all fields
 * middleware({
 *   name: "logging",
 *   apply: (effect, ctx) => Effect.gen(function*() {
 *     yield* Effect.logInfo(`Resolving ${ctx.info.fieldName}`)
 *     return yield* effect
 *   })
 * })
 *
 * // Admin-only middleware - pattern matched
 * middleware({
 *   name: "adminOnly",
 *   match: (info) => info.fieldName.startsWith("admin"),
 *   apply: (effect) => Effect.gen(function*() {
 *     const auth = yield* AuthService
 *     yield* auth.requireAdmin()
 *     return yield* effect
 *   })
 * })
 * ```
 */
export interface MiddlewareRegistration<R = never> {
  readonly name: string
  readonly description?: string

  /**
   * Optional predicate to filter which fields this middleware applies to.
   * If undefined, middleware applies to all fields.
   * Receives the GraphQL resolve info for the field being resolved.
   */
  readonly match?: (info: GraphQLResolveInfo) => boolean

  /**
   * Transform the resolver Effect.
   * Receives the resolver effect and full context (parent, args, info).
   * Returns the transformed effect.
   *
   * Middleware executes in "onion" order - first registered is outermost.
   */
  readonly apply: <A, E, R2>(
    effect: Effect.Effect<A, E, R2>,
    context: MiddlewareContext
  ) => Effect.Effect<A, E, R | R2>
}

/**
 * Configuration for a subscription field
 * Returns a Stream that yields values over time
 */
export interface SubscriptionFieldRegistration<Args = any, A = any, E = any, R = any> {
  type: S.Schema<A, any, any>
  args?: S.Schema<Args, any, any>
  description?: string
  directives?: readonly DirectiveApplication[]
  /**
   * Complexity cost of this subscription.
   * Can be a static number or a function that receives the resolved arguments.
   * Used for query complexity limiting.
   */
  complexity?: FieldComplexity
  /**
   * Cache control hint for this subscription.
   * Note: Subscriptions are real-time and typically not cached,
   * but this can be used for initial data hints.
   */
  cacheControl?: CacheHint
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
export interface ObjectFieldRegistration<Parent = any, Args = any, A = any, E = any, R = any> {
  type: S.Schema<A, any, any>
  args?: S.Schema<Args, any, any>
  description?: string
  directives?: readonly DirectiveApplication[]
  /**
   * Complexity cost of this field.
   * Can be a static number or a function that receives the resolved arguments.
   * Used for query complexity limiting.
   *
   * @example
   * // Relation field with pagination
   * complexity: (args) => (args.limit ?? 10) * 2
   */
  complexity?: FieldComplexity
  /**
   * Cache control hint for this field.
   * Used to compute HTTP Cache-Control headers for the response.
   *
   * @example
   * // Expensive computation, cache for 5 minutes
   * cacheControl: { maxAge: 300 }
   *
   * // Inherit cache policy from parent type
   * cacheControl: { inheritMaxAge: true }
   */
  cacheControl?: CacheHint
  resolve: (parent: Parent, args: Args) => Effect.Effect<A, E, R>
}

/**
 * GraphQL context that contains the Effect runtime
 */
export interface GraphQLEffectContext<R> {
  runtime: Runtime.Runtime<R>
}

/**
 * Type registries used during schema building
 */
export interface TypeRegistries {
  types: Map<string, import("graphql").GraphQLObjectType>
  interfaces: Map<string, import("graphql").GraphQLInterfaceType>
  enums: Map<string, import("graphql").GraphQLEnumType>
  unions: Map<string, import("graphql").GraphQLUnionType>
  inputs: Map<string, import("graphql").GraphQLInputObjectType>
  directives: Map<string, import("graphql").GraphQLDirective>
}
