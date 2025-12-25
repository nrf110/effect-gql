import { Effect, Runtime, Stream } from "effect"
import * as S from "effect/Schema"
import { DirectiveLocation } from "graphql"
import type { FieldComplexity } from "../server/complexity"

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
  resolve: (args: Args) => Effect.Effect<A, E, R>
}

/**
 * Configuration for an object type
 */
export interface TypeRegistration {
  name: string
  schema: S.Schema<any, any, any>
  implements?: readonly string[]
  directives?: readonly DirectiveApplication[]
}

/**
 * Configuration for an interface type
 */
export interface InterfaceRegistration {
  name: string
  schema: S.Schema<any, any, any>
  resolveType: (value: any) => string
}

/**
 * Configuration for an enum type
 */
export interface EnumRegistration {
  name: string
  values: readonly string[]
  description?: string
}

/**
 * Configuration for a union type
 */
export interface UnionRegistration {
  name: string
  types: readonly string[]
  resolveType: (value: any) => string
}

/**
 * Configuration for an input type
 */
export interface InputTypeRegistration {
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
