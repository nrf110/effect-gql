import { Effect, Context, Layer, Ref, Option, HashMap } from "effect"

/**
 * A type-safe context system for passing values through the resolver hierarchy.
 *
 * Unlike simple property bags, this provides:
 * - Type-safe slots that know their value type
 * - Clear errors when required context is missing
 * - Request-scoped storage that works across nested resolvers
 *
 * @example
 * ```typescript
 * // Define a context slot
 * const AuthPrincipal = ResolverContext.make<User>("AuthPrincipal")
 *
 * // Provide in a directive
 * .directive({
 *   name: "auth",
 *   apply: () => (effect) => Effect.gen(function*() {
 *     const user = yield* validateJwt()
 *     yield* ResolverContext.set(AuthPrincipal, user)
 *     return yield* effect
 *   }),
 * })
 *
 * // Access in any nested resolver
 * .field("User", "posts", {
 *   resolve: (parent) => Effect.gen(function*() {
 *     const user = yield* ResolverContext.get(AuthPrincipal)
 *     // ...
 *   }),
 * })
 * ```
 */

/**
 * Error thrown when trying to access a context value that hasn't been set
 */
export class MissingResolverContextError extends Error {
  readonly _tag = "MissingResolverContextError"

  constructor(readonly contextName: string) {
    super(
      `Resolver context "${contextName}" was not provided. Ensure a parent resolver or directive provides this context.`
    )
    this.name = "MissingResolverContextError"
  }
}

/**
 * A typed context slot that can hold a value of type A
 */
export interface ResolverContextSlot<A> {
  readonly _tag: "ResolverContextSlot"
  readonly name: string
  readonly _A: A // Phantom type for type inference
}

/**
 * Internal storage for resolver context values.
 * This is a request-scoped service that holds all context values.
 */
export interface ResolverContextStore {
  readonly ref: Ref.Ref<HashMap.HashMap<string, unknown>>
  readonly scoped?: { readonly name: string; readonly parent: ResolverContextStore }
}

export const ResolverContextStore = Context.Service<ResolverContextStore>(
  "effect-gql/ResolverContextStore"
)

const storeForSlot = (store: ResolverContextStore, name: string): ResolverContextStore => {
  while (store.scoped && store.scoped.name !== name) {
    store = store.scoped.parent
  }
  return store
}

/**
 * Create a Layer that provides the ResolverContextStore.
 * This should be included in the request layer.
 */
export const makeStoreLayer = (): Effect.Effect<Layer.Layer<ResolverContextStore>> =>
  Effect.map(Ref.make(HashMap.empty<string, unknown>()), (ref) =>
    Layer.succeed(ResolverContextStore, { ref })
  )

/**
 * Create a Layer that provides an empty ResolverContextStore.
 * Convenience function for creating a fresh store layer.
 */
export const storeLayer: Layer.Layer<ResolverContextStore> = Layer.effect(
  ResolverContextStore,
  Effect.map(Ref.make(HashMap.empty<string, unknown>()), (ref) => ({ ref }))
)

/**
 * Create a new resolver context slot.
 *
 * The name is used for error messages when the context is accessed but not set.
 *
 * @example
 * ```typescript
 * const AuthPrincipal = ResolverContext.make<User>("AuthPrincipal")
 * const TenantId = ResolverContext.make<string>("TenantId")
 * ```
 */
export const make = <A>(name: string): ResolverContextSlot<A> => ({
  _tag: "ResolverContextSlot",
  name,
  _A: undefined as unknown as A,
})

/**
 * Get a value from the resolver context.
 *
 * Fails with MissingResolverContextError if the context was not set
 * by a parent resolver or directive.
 *
 * @example
 * ```typescript
 * const effect = Effect.gen(function*() {
 *   const user = yield* ResolverContext.get(AuthPrincipal)
 *   // user is typed as User
 * })
 * ```
 */
export const get = <A>(
  slot: ResolverContextSlot<A>
): Effect.Effect<A, MissingResolverContextError, ResolverContextStore> =>
  Effect.flatMap(ResolverContextStore, (store) =>
    Effect.flatMap(Ref.get(storeForSlot(store, slot.name).ref), (map) => {
      const value = HashMap.get(map, slot.name)
      return Option.match(value, {
        onNone: () => Effect.fail(new MissingResolverContextError(slot.name)),
        onSome: (v) => Effect.succeed(v as A),
      })
    })
  )

/**
 * Get a value from the resolver context as an Option.
 *
 * Returns None if the context was not set, instead of failing.
 * Useful when context is optional.
 */
export const getOption = <A>(
  slot: ResolverContextSlot<A>
): Effect.Effect<Option.Option<A>, never, ResolverContextStore> =>
  Effect.flatMap(ResolverContextStore, (store) =>
    Effect.map(
      Ref.get(storeForSlot(store, slot.name).ref),
      (map) => HashMap.get(map, slot.name) as Option.Option<A>
    )
  )

/**
 * Set a value in the resolver context.
 *
 * The value will be available to all subsequent resolver calls in this request.
 * This mutates the request-scoped store, so nested resolvers will see the value.
 *
 * @example
 * ```typescript
 * // In a directive
 * const withAuth = (effect) => Effect.gen(function*() {
 *   const user = yield* validateJwt()
 *   yield* ResolverContext.set(AuthPrincipal, user)
 *   return yield* effect
 * })
 * ```
 */
export const set = <A>(
  slot: ResolverContextSlot<A>,
  value: A
): Effect.Effect<void, never, ResolverContextStore> =>
  Effect.flatMap(ResolverContextStore, (store) =>
    Ref.update(storeForSlot(store, slot.name).ref, (map) => HashMap.set(map, slot.name, value))
  )

/**
 * Set multiple context values at once.
 */
export const setMany = (
  values: ReadonlyArray<readonly [ResolverContextSlot<any>, any]>
): Effect.Effect<void, never, ResolverContextStore> =>
  Effect.flatMap(ResolverContextStore, (store) =>
    store.scoped
      ? Effect.gen(function* () {
          for (const [slot, value] of values) {
            yield* Ref.update(storeForSlot(store, slot.name).ref, (map) =>
              HashMap.set(map, slot.name, value)
            )
          }
        })
      : Ref.update(store.ref, (map) => {
          let result = map
          for (const [slot, value] of values) {
            result = HashMap.set(result, slot.name, value)
          }
          return result
        })
  )

/**
 * Check if a context slot has a value set.
 */
export const has = <A>(
  slot: ResolverContextSlot<A>
): Effect.Effect<boolean, never, ResolverContextStore> =>
  Effect.flatMap(ResolverContextStore, (store) =>
    Effect.map(Ref.get(storeForSlot(store, slot.name).ref), (map) => HashMap.has(map, slot.name))
  )

/**
 * Get a value or return a default if not set.
 */
export const getOrElse = <A>(
  slot: ResolverContextSlot<A>,
  orElse: () => A
): Effect.Effect<A, never, ResolverContextStore> =>
  Effect.flatMap(ResolverContextStore, (store) =>
    Effect.map(Ref.get(storeForSlot(store, slot.name).ref), (map) =>
      Option.getOrElse(HashMap.get(map, slot.name) as Option.Option<A>, orElse)
    )
  )

/**
 * Run an effect with a temporary value isolated from parent and sibling scopes.
 * Other slots remain shared with the request; nested effects inherit this override.
 */
export const scoped =
  <A>(slot: ResolverContextSlot<A>, value: A) =>
  <B, E, R>(effect: Effect.Effect<B, E, R>): Effect.Effect<B, E, R | ResolverContextStore> =>
    Effect.gen(function* () {
      const store = yield* ResolverContextStore
      const ref = yield* Ref.make<HashMap.HashMap<string, unknown>>(
        HashMap.make([slot.name, value])
      )
      return yield* Effect.provideService(effect, ResolverContextStore, {
        ref,
        scoped: { name: slot.name, parent: store },
      })
    })

/**
 * Namespace for ResolverContext functions
 */
export const ResolverContext = {
  make,
  get,
  getOption,
  set,
  setMany,
  has,
  getOrElse,
  scoped,
  storeLayer,
  makeStoreLayer,
  Store: ResolverContextStore,
  MissingResolverContextError,
} as const
