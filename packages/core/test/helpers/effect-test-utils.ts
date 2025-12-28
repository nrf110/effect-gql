import { Effect, Layer, Runtime, Context, Exit } from "effect"

/**
 * Run an Effect synchronously for tests (simple cases with no requirements)
 */
export const runSync = <A>(effect: Effect.Effect<A, never, never>): A => Effect.runSync(effect)

/**
 * Run an Effect as Promise for async tests
 */
export const runPromise = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(effect)

/**
 * Run an Effect and return the Exit for assertion
 */
export const runExit = <A, E>(effect: Effect.Effect<A, E, never>): Exit.Exit<A, E> =>
  Effect.runSyncExit(effect)

/**
 * Run an Effect with a test layer
 */
export const runWithLayer = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R, never, never>
): Promise<A> => Effect.runPromise(Effect.provide(effect, layer))

/**
 * Run an Effect with a test layer synchronously
 */
export const runSyncWithLayer = <A, R>(
  effect: Effect.Effect<A, never, R>,
  layer: Layer.Layer<R, never, never>
): A => Effect.runSync(Effect.provide(effect, layer))

/**
 * Create a mock service layer
 */
export const mockService = <I, S extends I>(
  tag: Context.Tag<I, S>,
  implementation: S
): Layer.Layer<I, never, never> => Layer.succeed(tag, implementation)

/**
 * Create a test runtime with services
 */
export const createTestRuntime = <R>(
  layer: Layer.Layer<R, never, never>
): Effect.Effect<Runtime.Runtime<R>, never, never> => Effect.scoped(Layer.toRuntime(layer))

/**
 * Helper to test async iterator behavior (for subscriptions)
 */
export const collectAsyncIterator = async <A>(
  iterator: AsyncIterator<A>,
  maxItems = 100
): Promise<A[]> => {
  const results: A[] = []
  for (let i = 0; i < maxItems; i++) {
    const { done, value } = await iterator.next()
    if (done) break
    results.push(value)
  }
  return results
}

/**
 * Assert that an Effect fails with a specific error tag
 */
export const assertFailsWithTag = <E extends { _tag: string }>(
  effect: Effect.Effect<unknown, E, never>,
  expectedTag: E["_tag"]
): Promise<void> =>
  Effect.runPromise(
    effect.pipe(
      Effect.matchEffect({
        onFailure: (error) => {
          if (error._tag === expectedTag) {
            return Effect.void
          }
          return Effect.die(
            new Error(`Expected error tag "${expectedTag}" but got "${error._tag}"`)
          )
        },
        onSuccess: () =>
          Effect.die(new Error(`Expected effect to fail with "${expectedTag}" but it succeeded`)),
      })
    )
  )

/**
 * Assert that an Effect succeeds with a specific value
 */
export const assertSucceedsWith = <A>(
  effect: Effect.Effect<A, unknown, never>,
  expected: A
): Promise<void> =>
  Effect.runPromise(
    effect.pipe(
      Effect.map((actual) => {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`)
        }
      })
    )
  )
