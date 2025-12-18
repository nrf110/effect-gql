import { Effect, Context, Layer } from "effect"
import DataLoader from "dataloader"

/**
 * Ergonomic DataLoader helpers for Effect-based GraphQL
 *
 * This module provides a type-safe, declarative way to define DataLoaders
 * that integrate seamlessly with Effect's service system.
 *
 * @example
 * ```typescript
 * // Define loaders
 * const loaders = Loader.define({
 *   UserById: Loader.single<string, User>({
 *     batch: (ids) => db.getUsersByIds(ids),
 *     key: (user) => user.id,
 *   }),
 *
 *   PostsByAuthorId: Loader.grouped<string, Post>({
 *     batch: (ids) => db.getPostsForAuthors(ids),
 *     groupBy: (post) => post.authorId,
 *   }),
 * })
 *
 * // Use in resolvers
 * resolve: (parent) => loaders.load("UserById", parent.authorId)
 * ```
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for a single-value loader (one key -> one value)
 */
interface SingleLoaderDef<K, V, R> {
  readonly _tag: "single"
  readonly batch: (keys: readonly K[]) => Effect.Effect<readonly V[], Error, R>
  readonly key: (value: V) => K
}

/**
 * Configuration for a grouped loader (one key -> many values)
 */
interface GroupedLoaderDef<K, V, R> {
  readonly _tag: "grouped"
  readonly batch: (keys: readonly K[]) => Effect.Effect<readonly V[], Error, R>
  readonly groupBy: (value: V) => K
}

type LoaderDef<K, V, R> = SingleLoaderDef<K, V, R> | GroupedLoaderDef<K, V, R>

/**
 * Runtime DataLoader instances
 */
type LoaderInstances<Defs extends Record<string, LoaderDef<any, any, any>>> = {
  [Name in keyof Defs]: Defs[Name] extends SingleLoaderDef<infer K, infer V, any>
    ? DataLoader<K, V>
    : Defs[Name] extends GroupedLoaderDef<infer K, infer V, any>
      ? DataLoader<K, V[]>
      : never
}

/**
 * Extract the value type for a loader (accounting for grouped loaders)
 */
type LoaderValue<Def> = Def extends SingleLoaderDef<any, infer V, any>
  ? V
  : Def extends GroupedLoaderDef<any, infer V, any>
    ? V[]
    : never

/**
 * Extract the key type for a loader
 */
type LoaderKey<Def> = Def extends LoaderDef<infer K, any, any> ? K : never

/**
 * Extract combined requirements from all loaders
 */
type LoaderRequirements<Defs extends Record<string, LoaderDef<any, any, any>>> = {
  [K in keyof Defs]: Defs[K] extends LoaderDef<any, any, infer R> ? R : never
}[keyof Defs]

// ============================================================================
// Loader Builders
// ============================================================================

/**
 * Create a single-value loader definition.
 * One key maps to one value.
 *
 * @example
 * ```typescript
 * Loader.single<string, User>({
 *   batch: (ids) => db.getUsersByIds(ids),
 *   key: (user) => user.id,
 * })
 * ```
 */
function single<K, V, R = never>(config: {
  batch: (keys: readonly K[]) => Effect.Effect<readonly V[], Error, R>
  key: (value: V) => K
}): SingleLoaderDef<K, V, R> {
  return {
    _tag: "single",
    batch: config.batch,
    key: config.key,
  }
}

/**
 * Create a grouped loader definition.
 * One key maps to many values.
 *
 * @example
 * ```typescript
 * Loader.grouped<string, Post>({
 *   batch: (authorIds) => db.getPostsForAuthors(authorIds),
 *   groupBy: (post) => post.authorId,
 * })
 * ```
 */
function grouped<K, V, R = never>(config: {
  batch: (keys: readonly K[]) => Effect.Effect<readonly V[], Error, R>
  groupBy: (value: V) => K
}): GroupedLoaderDef<K, V, R> {
  return {
    _tag: "grouped",
    batch: config.batch,
    groupBy: config.groupBy,
  }
}

// ============================================================================
// Loader Registry
// ============================================================================

/**
 * A registry of loader definitions with methods to create instances and layers
 */
class LoaderRegistry<Defs extends Record<string, LoaderDef<any, any, any>>> {
  readonly _tag = "LoaderRegistry"

  /**
   * The Effect service tag for this loader registry
   */
  readonly Service: Context.Tag<LoaderInstances<Defs>, LoaderInstances<Defs>>

  constructor(readonly definitions: Defs) {
    this.Service = Context.GenericTag<LoaderInstances<Defs>>(
      `DataLoaders(${Object.keys(definitions).join(", ")})`
    )
  }

  /**
   * Create a Layer that provides fresh DataLoader instances.
   * Call this once per request to get request-scoped loaders.
   */
  toLayer(): Layer.Layer<LoaderInstances<Defs>, never, LoaderRequirements<Defs>> {
    const self = this
    return Layer.effect(
      this.Service,
      Effect.gen(function* () {
        const instances: Record<string, DataLoader<any, any>> = {}

        for (const [name, def] of Object.entries(self.definitions)) {
          instances[name] = yield* createDataLoader(def)
        }

        return instances as LoaderInstances<Defs>
      })
    ) as Layer.Layer<LoaderInstances<Defs>, never, LoaderRequirements<Defs>>
  }

  /**
   * Helper to use loaders in a resolver with a callback.
   */
  use<A>(
    fn: (loaders: LoaderInstances<Defs>) => Promise<A>
  ): Effect.Effect<A, Error, LoaderInstances<Defs>> {
    const self = this
    return Effect.gen(function* () {
      const loaders = yield* self.Service
      return yield* Effect.promise(() => fn(loaders))
    })
  }

  /**
   * Load a single value by key.
   * This is the most common operation in resolvers.
   */
  load<Name extends keyof Defs & string>(
    name: Name,
    key: LoaderKey<Defs[Name]>
  ): Effect.Effect<LoaderValue<Defs[Name]>, Error, LoaderInstances<Defs>> {
    const self = this
    return Effect.gen(function* () {
      const loaders = yield* self.Service
      const loader = loaders[name] as DataLoader<any, any>
      return yield* Effect.promise(() => loader.load(key))
    })
  }

  /**
   * Load multiple values by keys.
   * All keys are batched into a single request.
   */
  loadMany<Name extends keyof Defs & string>(
    name: Name,
    keys: readonly LoaderKey<Defs[Name]>[]
  ): Effect.Effect<readonly LoaderValue<Defs[Name]>[], Error, LoaderInstances<Defs>> {
    const self = this
    return Effect.gen(function* () {
      const loaders = yield* self.Service
      const loader = loaders[name] as DataLoader<any, any>
      const results = yield* Effect.promise(() => loader.loadMany(keys))
      // Convert any errors to a failure
      for (const result of results) {
        if (result instanceof Error) {
          return yield* Effect.fail(result)
        }
      }
      return results as readonly LoaderValue<Defs[Name]>[]
    })
  }
}

/**
 * Create a DataLoader from a loader definition
 */
function createDataLoader<K, V, R>(
  def: LoaderDef<K, V, R>
): Effect.Effect<DataLoader<K, any>, never, R> {
  return Effect.gen(function* () {
    // Capture context for use in batch function
    const context = yield* Effect.context<R>()

    if (def._tag === "single") {
      const loader = new DataLoader<K, V>(async (keys) => {
        const items = await Effect.runPromise(
          def.batch(keys).pipe(Effect.provide(context))
        )
        // Map items back to keys in order
        return keys.map((key) => {
          const item = items.find((i) => def.key(i) === key)
          if (!item) return new Error(`Not found: ${key}`) as any
          return item
        })
      })
      return loader
    } else {
      // Grouped loader
      const loader = new DataLoader<K, V[]>(async (keys) => {
        const items = await Effect.runPromise(
          def.batch(keys).pipe(Effect.provide(context))
        )
        // Group items by key
        const map = new Map<K, V[]>()
        for (const key of keys) {
          map.set(key, [])
        }
        for (const item of items) {
          const key = def.groupBy(item)
          const arr = map.get(key)
          if (arr) arr.push(item)
        }
        return keys.map((key) => map.get(key) ?? [])
      })
      return loader
    }
  })
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Define a set of loaders.
 *
 * @example
 * ```typescript
 * const loaders = Loader.define({
 *   UserById: Loader.single<string, User>({
 *     batch: (ids) => db.getUsersByIds(ids),
 *     key: (user) => user.id,
 *   }),
 *   PostsByAuthorId: Loader.grouped<string, Post>({
 *     batch: (ids) => db.getPostsForAuthors(ids),
 *     groupBy: (post) => post.authorId,
 *   }),
 * })
 *
 * // In resolvers:
 * loaders.load("UserById", "123")
 * loaders.loadMany("UserById", ["1", "2", "3"])
 * ```
 */
function define<Defs extends Record<string, LoaderDef<any, any, any>>>(
  definitions: Defs
): LoaderRegistry<Defs> {
  return new LoaderRegistry(definitions)
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Map an array of items to match requested keys.
 * Returns items in the same order as keys, with errors for missing items.
 */
function mapByKey<K, V>(
  keys: readonly K[],
  items: readonly V[],
  keyFn: (item: V) => K
): (V | Error)[] {
  const map = new Map<K, V>()
  for (const item of items) {
    map.set(keyFn(item), item)
  }
  return keys.map((key) => map.get(key) ?? new Error(`Not found: ${key}`))
}

/**
 * Group an array of items by a key function.
 * Returns a Map from key to array of matching items.
 */
function groupByKey<K, V>(
  keys: readonly K[],
  items: readonly V[],
  keyFn: (item: V) => K
): Map<K, V[]> {
  const map = new Map<K, V[]>()
  for (const key of keys) {
    map.set(key, [])
  }
  for (const item of items) {
    const key = keyFn(item)
    const arr = map.get(key)
    if (arr) arr.push(item)
  }
  return map
}

// ============================================================================
// Export
// ============================================================================

export const Loader = {
  define,
  single,
  grouped,
  mapByKey,
  groupByKey,
} as const

export type { LoaderRegistry, LoaderDef, LoaderInstances }
