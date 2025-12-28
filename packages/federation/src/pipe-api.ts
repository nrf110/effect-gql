import { Effect } from "effect"
import * as S from "effect/Schema"
import type { DirectiveApplication } from "@effect-gql/core"
import { FederatedSchemaBuilder } from "./federated-builder"
import type { EntityRegistration } from "./types"

// ============================================================================
// Entity Registration
// ============================================================================

/**
 * Register an entity type with @key directive(s) and reference resolver.
 *
 * @example
 * ```typescript
 * FederatedSchemaBuilder.empty.pipe(
 *   entity({
 *     name: "User",
 *     schema: UserSchema,
 *     keys: [key({ fields: "id" })],
 *     resolveReference: (ref) => UserService.findById(ref.id),
 *   }),
 * )
 * ```
 */
export const entity =
  <A, R>(config: EntityRegistration<A, R>) =>
  <R2>(builder: FederatedSchemaBuilder<R2>): FederatedSchemaBuilder<R | R2> =>
    builder.entity(config)

// ============================================================================
// Query/Mutation/Subscription
// ============================================================================

/**
 * Add a query field
 */
export const query =
  <A, E, R, Args = void>(
    name: string,
    config: {
      type: S.Schema<A, any, any>
      args?: S.Schema<Args, any, any>
      description?: string
      directives?: readonly DirectiveApplication[]
      resolve: (args: Args) => Effect.Effect<A, E, R>
    }
  ) =>
  <R2>(builder: FederatedSchemaBuilder<R2>): FederatedSchemaBuilder<R | R2> =>
    builder.query(name, config)

/**
 * Add a mutation field
 */
export const mutation =
  <A, E, R, Args = void>(
    name: string,
    config: {
      type: S.Schema<A, any, any>
      args?: S.Schema<Args, any, any>
      description?: string
      directives?: readonly DirectiveApplication[]
      resolve: (args: Args) => Effect.Effect<A, E, R>
    }
  ) =>
  <R2>(builder: FederatedSchemaBuilder<R2>): FederatedSchemaBuilder<R | R2> =>
    builder.mutation(name, config)

/**
 * Add a subscription field
 */
export const subscription =
  <A, E, R, Args = void>(
    name: string,
    config: {
      type: S.Schema<A, any, any>
      args?: S.Schema<Args, any, any>
      description?: string
      directives?: readonly DirectiveApplication[]
      subscribe: (args: Args) => Effect.Effect<import("effect").Stream.Stream<A, E, R>, E, R>
      resolve?: (value: A, args: Args) => Effect.Effect<A, E, R>
    }
  ) =>
  <R2>(builder: FederatedSchemaBuilder<R2>): FederatedSchemaBuilder<R | R2> =>
    builder.subscription(name, config)

// ============================================================================
// Type Registration
// ============================================================================

/**
 * Register an object type (non-entity)
 */
export const objectType =
  <A>(config: {
    name?: string
    schema: S.Schema<A, any, any>
    implements?: readonly string[]
    directives?: readonly DirectiveApplication[]
  }) =>
  <R>(builder: FederatedSchemaBuilder<R>): FederatedSchemaBuilder<R> =>
    builder.objectType(config)

/**
 * Register an interface type
 */
export const interfaceType =
  (config: {
    name?: string
    schema: S.Schema<any, any, any>
    resolveType?: (value: any) => string
    directives?: readonly DirectiveApplication[]
  }) =>
  <R>(builder: FederatedSchemaBuilder<R>): FederatedSchemaBuilder<R> =>
    builder.interfaceType(config)

/**
 * Register an enum type
 */
export const enumType =
  (config: {
    name: string
    values: readonly string[]
    description?: string
    directives?: readonly DirectiveApplication[]
  }) =>
  <R>(builder: FederatedSchemaBuilder<R>): FederatedSchemaBuilder<R> =>
    builder.enumType(config)

/**
 * Register a union type
 */
export const unionType =
  (config: {
    name: string
    types: readonly string[]
    resolveType?: (value: any) => string
    directives?: readonly DirectiveApplication[]
  }) =>
  <R>(builder: FederatedSchemaBuilder<R>): FederatedSchemaBuilder<R> =>
    builder.unionType(config)

/**
 * Register an input type
 */
export const inputType =
  (config: {
    name?: string
    schema: S.Schema<any, any, any>
    description?: string
    directives?: readonly DirectiveApplication[]
  }) =>
  <R>(builder: FederatedSchemaBuilder<R>): FederatedSchemaBuilder<R> =>
    builder.inputType(config)

/**
 * Add a computed/relational field to an object type
 */
export const field =
  <Parent, A, E, R, Args = void>(
    typeName: string,
    fieldName: string,
    config: {
      type: S.Schema<A, any, any>
      args?: S.Schema<Args, any, any>
      description?: string
      directives?: readonly DirectiveApplication[]
      resolve: (parent: Parent, args: Args) => Effect.Effect<A, E, R>
    }
  ) =>
  <R2>(builder: FederatedSchemaBuilder<R2>): FederatedSchemaBuilder<R | R2> =>
    builder.field(typeName, fieldName, config)

// ============================================================================
// Field-Level Federation Directive Helpers
// ============================================================================

/**
 * Create a field configuration with @external directive
 */
export const externalField = <A>(config: {
  type: S.Schema<A, any, any>
  description?: string
}): {
  type: S.Schema<A, any, any>
  description?: string
  directives: readonly DirectiveApplication[]
  resolve: (parent: any) => Effect.Effect<A, never, never>
} => ({
  type: config.type,
  description: config.description,
  directives: [{ name: "external" }],
  resolve: (parent: any) => Effect.succeed(parent),
})

/**
 * Create a field configuration with @requires directive
 */
export const requiresField = <A, E, R, Parent = any>(config: {
  type: S.Schema<A, any, any>
  fields: string
  description?: string
  resolve: (parent: Parent) => Effect.Effect<A, E, R>
}): {
  type: S.Schema<A, any, any>
  description?: string
  directives: readonly DirectiveApplication[]
  resolve: (parent: Parent) => Effect.Effect<A, E, R>
} => ({
  type: config.type,
  description: config.description,
  directives: [{ name: "requires", args: { fields: config.fields } }],
  resolve: config.resolve,
})

/**
 * Create a field configuration with @provides directive
 */
export const providesField = <A, E, R, Parent = any>(config: {
  type: S.Schema<A, any, any>
  fields: string
  description?: string
  resolve: (parent: Parent) => Effect.Effect<A, E, R>
}): {
  type: S.Schema<A, any, any>
  description?: string
  directives: readonly DirectiveApplication[]
  resolve: (parent: Parent) => Effect.Effect<A, E, R>
} => ({
  type: config.type,
  description: config.description,
  directives: [{ name: "provides", args: { fields: config.fields } }],
  resolve: config.resolve,
})

/**
 * Create a field configuration with @override directive
 */
export const overrideField = <A, E, R, Parent = any>(config: {
  type: S.Schema<A, any, any>
  from: string
  label?: string
  description?: string
  resolve: (parent: Parent) => Effect.Effect<A, E, R>
}): {
  type: S.Schema<A, any, any>
  description?: string
  directives: readonly DirectiveApplication[]
  resolve: (parent: Parent) => Effect.Effect<A, E, R>
} => ({
  type: config.type,
  description: config.description,
  directives: [
    {
      name: "override",
      args: {
        from: config.from,
        ...(config.label !== undefined ? { label: config.label } : {}),
      },
    },
  ],
  resolve: config.resolve,
})
