import { Context, Effect, Layer, Stream, Queue, Ref } from "effect"

// ============================================================================
// Mock Database Service
// ============================================================================

export interface MockDatabase {
  readonly getUser: (id: string) => Effect.Effect<{ id: string; name: string } | null>
  readonly getUsers: (
    ids: readonly string[]
  ) => Effect.Effect<readonly { id: string; name: string }[]>
  readonly createUser: (data: { name: string }) => Effect.Effect<{ id: string; name: string }>
  readonly updateUser: (
    id: string,
    data: { name?: string }
  ) => Effect.Effect<{ id: string; name: string } | null>
  readonly deleteUser: (id: string) => Effect.Effect<boolean>
}

export class MockDatabaseService extends Context.Tag("MockDatabase")<
  MockDatabaseService,
  MockDatabase
>() {}

/**
 * Create a mock database layer with initial data
 */
export const createMockDatabaseLayer = (
  initialData: Map<string, { id: string; name: string }> = new Map()
): Layer.Layer<MockDatabaseService> => {
  const data = new Map(initialData)
  let nextId = initialData.size + 1

  return Layer.succeed(MockDatabaseService, {
    getUser: (id) => Effect.succeed(data.get(id) ?? null),
    getUsers: (ids) =>
      Effect.succeed(
        ids
          .map((id) => data.get(id))
          .filter((u): u is { id: string; name: string } => u !== undefined)
      ),
    createUser: (input) =>
      Effect.sync(() => {
        const user = { id: String(nextId++), name: input.name }
        data.set(user.id, user)
        return user
      }),
    updateUser: (id, input) =>
      Effect.sync(() => {
        const existing = data.get(id)
        if (!existing) return null
        const updated = { ...existing, ...input }
        data.set(id, updated)
        return updated
      }),
    deleteUser: (id) =>
      Effect.sync(() => {
        if (!data.has(id)) return false
        data.delete(id)
        return true
      }),
  })
}

// ============================================================================
// Mock Auth Service
// ============================================================================

export interface MockAuth {
  readonly getCurrentUser: () => Effect.Effect<{ id: string; role: string } | null>
  readonly checkRole: (requiredRole: string) => Effect.Effect<void, AuthError>
}

export class AuthError {
  readonly _tag = "AuthError"
  constructor(readonly message: string) {}
}

export class MockAuthService extends Context.Tag("MockAuth")<MockAuthService, MockAuth>() {}

/**
 * Create a mock auth layer with a specific user
 */
export const createMockAuthLayer = (
  currentUser: { id: string; role: string } | null
): Layer.Layer<MockAuthService> =>
  Layer.succeed(MockAuthService, {
    getCurrentUser: () => Effect.succeed(currentUser),
    checkRole: (requiredRole) =>
      Effect.gen(function* () {
        if (!currentUser) {
          return yield* Effect.fail(new AuthError("Not authenticated"))
        }
        if (currentUser.role !== requiredRole) {
          return yield* Effect.fail(
            new AuthError(`Required role: ${requiredRole}, current role: ${currentUser.role}`)
          )
        }
      }),
  })

// ============================================================================
// Mock Logger Service
// ============================================================================

export interface MockLogger {
  readonly log: (message: string) => Effect.Effect<void>
  readonly getLogs: () => Effect.Effect<readonly string[]>
  readonly clear: () => Effect.Effect<void>
}

export class MockLoggerService extends Context.Tag("MockLogger")<MockLoggerService, MockLogger>() {}

/**
 * Create a mock logger layer that captures logs
 */
export const createMockLoggerLayer = (): Layer.Layer<MockLoggerService> =>
  Layer.effect(
    MockLoggerService,
    Effect.gen(function* () {
      const logs = yield* Ref.make<readonly string[]>([])

      return {
        log: (message: string) => Ref.update(logs, (current) => [...current, message]),
        getLogs: () => Ref.get(logs),
        clear: () => Ref.set(logs, []),
      }
    })
  )

// ============================================================================
// Mock PubSub Service (for subscriptions)
// ============================================================================

export interface MockPubSub<T> {
  readonly publish: (topic: string, value: T) => Effect.Effect<void>
  readonly subscribe: (topic: string) => Effect.Effect<Stream.Stream<T>>
}

export class MockPubSubService extends Context.Tag("MockPubSub")<
  MockPubSubService,
  MockPubSub<unknown>
>() {}

/**
 * Create a mock pubsub layer for testing subscriptions
 */
export const createMockPubSubLayer = <T>(): Layer.Layer<MockPubSubService> =>
  Layer.effect(
    MockPubSubService,
    Effect.gen(function* () {
      const queues = yield* Ref.make<Map<string, Queue.Queue<T>>>(new Map())

      const getOrCreateQueue = (topic: string): Effect.Effect<Queue.Queue<T>> =>
        Effect.gen(function* () {
          const currentQueues = yield* Ref.get(queues)
          const existing = currentQueues.get(topic)
          if (existing) return existing

          const newQueue = yield* Queue.unbounded<T>()
          yield* Ref.update(queues, (m) => {
            const copy = new Map(m)
            copy.set(topic, newQueue)
            return copy
          })
          return newQueue
        })

      return {
        publish: (topic: string, value: T) =>
          Effect.gen(function* () {
            const queue = yield* getOrCreateQueue(topic)
            yield* Queue.offer(queue, value)
          }),
        subscribe: (topic: string) =>
          Effect.gen(function* () {
            const queue = yield* getOrCreateQueue(topic)
            return Stream.fromQueue(queue)
          }),
      } as MockPubSub<unknown>
    })
  )

// ============================================================================
// Composite Test Layer
// ============================================================================

/**
 * Create a combined test layer with common services
 */
export const createTestServicesLayer = (options?: {
  users?: Map<string, { id: string; name: string }>
  currentUser?: { id: string; role: string } | null
}): Layer.Layer<MockDatabaseService | MockAuthService | MockLoggerService> =>
  Layer.mergeAll(
    createMockDatabaseLayer(options?.users),
    createMockAuthLayer(options?.currentUser ?? null),
    createMockLoggerLayer()
  )
