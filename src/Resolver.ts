import { Effect, Runtime } from "effect"
import type { GraphQLFieldResolver } from "graphql"

/**
 * Effect-based resolver type
 * R = Requirements (services/context needed)
 * E = Error types that can be thrown
 * A = Return type
 */
export type EffectResolver<Args, R, E, A> = (
  parent: unknown,
  args: Args,
  context: unknown,
  info: unknown
) => Effect.Effect<A, E, R>

/**
 * Convert an Effect resolver to a standard GraphQL resolver
 */
export const toGraphQLResolver = <Args, R, E, A>(
  effectResolver: EffectResolver<Args, R, E, A>,
  runtime: Runtime.Runtime<R>
): GraphQLFieldResolver<unknown, unknown, Args> => {
  return (parent, args, context, info) => {
    const effect = effectResolver(parent, args as Args, context, info)
    return Runtime.runPromise(runtime)(effect)
  }
}

/**
 * Helper to create a simple resolver from an Effect
 */
export const resolver = <Args, R, E, A>(
  fn: (args: Args) => Effect.Effect<A, E, R>
): EffectResolver<Args, R, E, A> => {
  return (_parent, args) => fn(args)
}

/**
 * Helper to create a resolver that accesses parent value
 */
export const fieldResolver = <Parent, Args, R, E, A>(
  fn: (parent: Parent, args: Args) => Effect.Effect<A, E, R>
): EffectResolver<Args, R, E, A> => {
  return (parent, args) => fn(parent as Parent, args)
}
