import { describe, it, expect, vi, beforeEach } from "vitest"
import { Effect, Layer, Context } from "effect"
import { Loader } from "../../src/loader"

// ==========================================================================
// Test data types
// ==========================================================================

interface User {
  id: string
  name: string
}

interface Post {
  id: string
  authorId: string
  title: string
}

// ==========================================================================
// Test fixtures
// ==========================================================================

const testUsers: User[] = [
  { id: "1", name: "Alice" },
  { id: "2", name: "Bob" },
  { id: "3", name: "Charlie" },
]

const testPosts: Post[] = [
  { id: "p1", authorId: "1", title: "Alice Post 1" },
  { id: "p2", authorId: "1", title: "Alice Post 2" },
  { id: "p3", authorId: "2", title: "Bob Post 1" },
]

// ==========================================================================
// Loader.single tests
// ==========================================================================

describe("Loader.single", () => {
  it("should create a single loader definition with correct tag", () => {
    const def = Loader.single<string, User>({
      batch: (ids) => Effect.succeed(testUsers.filter((u) => ids.includes(u.id))),
      key: (user) => user.id,
    })

    expect(def._tag).toBe("single")
    expect(def.key).toBeDefined()
    expect(def.batch).toBeDefined()
  })

  it("should store the batch function", () => {
    const batchFn = (ids: readonly string[]) =>
      Effect.succeed(testUsers.filter((u) => ids.includes(u.id)))

    const def = Loader.single<string, User>({
      batch: batchFn,
      key: (user) => user.id,
    })

    expect(def.batch).toBe(batchFn)
  })

  it("should store the key function", () => {
    const keyFn = (user: User) => user.id

    const def = Loader.single<string, User>({
      batch: () => Effect.succeed([]),
      key: keyFn,
    })

    expect(def.key).toBe(keyFn)
  })
})

// ==========================================================================
// Loader.grouped tests
// ==========================================================================

describe("Loader.grouped", () => {
  it("should create a grouped loader definition with correct tag", () => {
    const def = Loader.grouped<string, Post>({
      batch: (ids) => Effect.succeed(testPosts.filter((p) => ids.includes(p.authorId))),
      groupBy: (post) => post.authorId,
    })

    expect(def._tag).toBe("grouped")
    expect(def.groupBy).toBeDefined()
    expect(def.batch).toBeDefined()
  })

  it("should store the batch function", () => {
    const batchFn = (ids: readonly string[]) =>
      Effect.succeed(testPosts.filter((p) => ids.includes(p.authorId)))

    const def = Loader.grouped<string, Post>({
      batch: batchFn,
      groupBy: (post) => post.authorId,
    })

    expect(def.batch).toBe(batchFn)
  })

  it("should store the groupBy function", () => {
    const groupByFn = (post: Post) => post.authorId

    const def = Loader.grouped<string, Post>({
      batch: () => Effect.succeed([]),
      groupBy: groupByFn,
    })

    expect(def.groupBy).toBe(groupByFn)
  })
})

// ==========================================================================
// Loader.define tests
// ==========================================================================

describe("Loader.define", () => {
  it("should create a LoaderRegistry with definitions", () => {
    const registry = Loader.define({
      UserById: Loader.single<string, User>({
        batch: () => Effect.succeed([]),
        key: (u) => u.id,
      }),
    })

    expect(registry._tag).toBe("LoaderRegistry")
    expect(registry.definitions).toBeDefined()
    expect(registry.definitions.UserById).toBeDefined()
  })

  it("should create a Service tag", () => {
    const registry = Loader.define({
      UserById: Loader.single<string, User>({
        batch: () => Effect.succeed([]),
        key: (u) => u.id,
      }),
    })

    expect(registry.Service).toBeDefined()
  })

  it("should support multiple loader definitions", () => {
    const registry = Loader.define({
      UserById: Loader.single<string, User>({
        batch: () => Effect.succeed([]),
        key: (u) => u.id,
      }),
      PostsByAuthorId: Loader.grouped<string, Post>({
        batch: () => Effect.succeed([]),
        groupBy: (p) => p.authorId,
      }),
    })

    expect(registry.definitions.UserById).toBeDefined()
    expect(registry.definitions.PostsByAuthorId).toBeDefined()
  })

  it("should support empty definitions", () => {
    const registry = Loader.define({})

    expect(registry._tag).toBe("LoaderRegistry")
    expect(Object.keys(registry.definitions)).toHaveLength(0)
  })
})

// ==========================================================================
// LoaderRegistry.toLayer tests
// ==========================================================================

describe("LoaderRegistry.toLayer", () => {
  it("should create a Layer that provides DataLoader instances", async () => {
    const registry = Loader.define({
      UserById: Loader.single<string, User>({
        batch: (ids) => Effect.succeed(testUsers.filter((u) => ids.includes(u.id))),
        key: (u) => u.id,
      }),
    })

    const layer = registry.toLayer()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const loaders = yield* registry.Service
        return loaders.UserById
      }).pipe(Effect.provide(layer))
    )

    expect(result).toBeDefined()
    expect(typeof result.load).toBe("function")
  })

  it("should create separate DataLoader for each definition", async () => {
    const registry = Loader.define({
      UserById: Loader.single<string, User>({
        batch: () => Effect.succeed(testUsers),
        key: (u) => u.id,
      }),
      PostsByAuthorId: Loader.grouped<string, Post>({
        batch: () => Effect.succeed(testPosts),
        groupBy: (p) => p.authorId,
      }),
    })

    const layer = registry.toLayer()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const loaders = yield* registry.Service
        return {
          hasUserLoader: !!loaders.UserById,
          hasPostLoader: !!loaders.PostsByAuthorId,
        }
      }).pipe(Effect.provide(layer))
    )

    expect(result.hasUserLoader).toBe(true)
    expect(result.hasPostLoader).toBe(true)
  })
})

// ==========================================================================
// LoaderRegistry.load tests (single loaders)
// ==========================================================================

describe("LoaderRegistry.load (single)", () => {
  it("should load a single value by key", async () => {
    const registry = Loader.define({
      UserById: Loader.single<string, User>({
        batch: (ids) => Effect.succeed(testUsers.filter((u) => ids.includes(u.id))),
        key: (u) => u.id,
      }),
    })

    const result = await Effect.runPromise(
      registry.load("UserById", "1").pipe(Effect.provide(registry.toLayer()))
    )

    expect(result).toEqual({ id: "1", name: "Alice" })
  })

  it("should batch multiple load calls", async () => {
    const batchSpy = vi.fn((ids: readonly string[]) =>
      Effect.succeed(testUsers.filter((u) => ids.includes(u.id)))
    )

    const registry = Loader.define({
      UserById: Loader.single<string, User>({
        batch: batchSpy,
        key: (u) => u.id,
      }),
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const loaders = yield* registry.Service
        // Load concurrently - should batch into one call
        const [user1, user2] = yield* Effect.promise(() =>
          Promise.all([loaders.UserById.load("1"), loaders.UserById.load("2")])
        )
        return { user1, user2 }
      }).pipe(Effect.provide(registry.toLayer()))
    )

    expect(result.user1).toEqual({ id: "1", name: "Alice" })
    expect(result.user2).toEqual({ id: "2", name: "Bob" })
    // DataLoader batches requests in the same tick
    expect(batchSpy).toHaveBeenCalledTimes(1)
  })

  it("should cache repeated loads for same key", async () => {
    const batchSpy = vi.fn((ids: readonly string[]) =>
      Effect.succeed(testUsers.filter((u) => ids.includes(u.id)))
    )

    const registry = Loader.define({
      UserById: Loader.single<string, User>({
        batch: batchSpy,
        key: (u) => u.id,
      }),
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const loaders = yield* registry.Service
        // Load same key twice
        const user1 = yield* Effect.promise(() => loaders.UserById.load("1"))
        const user2 = yield* Effect.promise(() => loaders.UserById.load("1"))
        return { user1, user2 }
      }).pipe(Effect.provide(registry.toLayer()))
    )

    expect(result.user1).toEqual(result.user2)
    expect(batchSpy).toHaveBeenCalledTimes(1)
  })

  it("should return error for missing key", async () => {
    const registry = Loader.define({
      UserById: Loader.single<string, User>({
        batch: (ids) => Effect.succeed(testUsers.filter((u) => ids.includes(u.id))),
        key: (u) => u.id,
      }),
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const loaders = yield* registry.Service
        return yield* Effect.tryPromise(() => loaders.UserById.load("nonexistent"))
          .pipe(
            Effect.map(() => ({ error: null })),
            Effect.catchAll((e) => Effect.succeed({ error: e }))
          )
      }).pipe(Effect.provide(registry.toLayer()))
    )

    expect(result.error).toBeDefined()
    // The error may be wrapped by Effect.tryPromise
    expect(result.error).not.toBeNull()
  })
})

// ==========================================================================
// LoaderRegistry.load tests (grouped loaders)
// ==========================================================================

describe("LoaderRegistry.load (grouped)", () => {
  it("should load grouped values by key", async () => {
    const registry = Loader.define({
      PostsByAuthorId: Loader.grouped<string, Post>({
        batch: (ids) => Effect.succeed(testPosts.filter((p) => ids.includes(p.authorId))),
        groupBy: (p) => p.authorId,
      }),
    })

    const result = await Effect.runPromise(
      registry.load("PostsByAuthorId", "1").pipe(Effect.provide(registry.toLayer()))
    )

    expect(result).toHaveLength(2)
    expect(result.map((p) => p.title)).toEqual(["Alice Post 1", "Alice Post 2"])
  })

  it("should return empty array for author with no posts", async () => {
    const registry = Loader.define({
      PostsByAuthorId: Loader.grouped<string, Post>({
        batch: (ids) => Effect.succeed(testPosts.filter((p) => ids.includes(p.authorId))),
        groupBy: (p) => p.authorId,
      }),
    })

    const result = await Effect.runPromise(
      registry.load("PostsByAuthorId", "3").pipe(Effect.provide(registry.toLayer()))
    )

    expect(result).toEqual([])
  })

  it("should batch multiple grouped load calls", async () => {
    const batchSpy = vi.fn((ids: readonly string[]) =>
      Effect.succeed(testPosts.filter((p) => ids.includes(p.authorId)))
    )

    const registry = Loader.define({
      PostsByAuthorId: Loader.grouped<string, Post>({
        batch: batchSpy,
        groupBy: (p) => p.authorId,
      }),
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const loaders = yield* registry.Service
        const [posts1, posts2] = yield* Effect.promise(() =>
          Promise.all([
            loaders.PostsByAuthorId.load("1"),
            loaders.PostsByAuthorId.load("2"),
          ])
        )
        return { posts1, posts2 }
      }).pipe(Effect.provide(registry.toLayer()))
    )

    expect(result.posts1).toHaveLength(2)
    expect(result.posts2).toHaveLength(1)
    expect(batchSpy).toHaveBeenCalledTimes(1)
  })
})

// ==========================================================================
// LoaderRegistry.loadMany tests
// ==========================================================================

describe("LoaderRegistry.loadMany", () => {
  it("should load multiple values at once", async () => {
    const registry = Loader.define({
      UserById: Loader.single<string, User>({
        batch: (ids) => Effect.succeed(testUsers.filter((u) => ids.includes(u.id))),
        key: (u) => u.id,
      }),
    })

    const result = await Effect.runPromise(
      registry.loadMany("UserById", ["1", "2"]).pipe(Effect.provide(registry.toLayer()))
    )

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ id: "1", name: "Alice" })
    expect(result[1]).toEqual({ id: "2", name: "Bob" })
  })

  it("should fail if any key results in error", async () => {
    const registry = Loader.define({
      UserById: Loader.single<string, User>({
        batch: (ids) => Effect.succeed(testUsers.filter((u) => ids.includes(u.id))),
        key: (u) => u.id,
      }),
    })

    const result = await Effect.runPromise(
      registry
        .loadMany("UserById", ["1", "nonexistent"])
        .pipe(
          Effect.catchAll((e) => Effect.succeed({ error: e })),
          Effect.provide(registry.toLayer())
        )
    )

    expect(result).toHaveProperty("error")
  })

  it("should handle empty keys array", async () => {
    const registry = Loader.define({
      UserById: Loader.single<string, User>({
        batch: (ids) => Effect.succeed(testUsers.filter((u) => ids.includes(u.id))),
        key: (u) => u.id,
      }),
    })

    const result = await Effect.runPromise(
      registry.loadMany("UserById", []).pipe(Effect.provide(registry.toLayer()))
    )

    expect(result).toEqual([])
  })
})

// ==========================================================================
// LoaderRegistry.use tests
// ==========================================================================

describe("LoaderRegistry.use", () => {
  it("should provide loaders to callback", async () => {
    const registry = Loader.define({
      UserById: Loader.single<string, User>({
        batch: (ids) => Effect.succeed(testUsers.filter((u) => ids.includes(u.id))),
        key: (u) => u.id,
      }),
    })

    const result = await Effect.runPromise(
      registry
        .use(async (loaders) => {
          const user = await loaders.UserById.load("1")
          return user.name
        })
        .pipe(Effect.provide(registry.toLayer()))
    )

    expect(result).toBe("Alice")
  })

  it("should support async operations in callback", async () => {
    const registry = Loader.define({
      UserById: Loader.single<string, User>({
        batch: (ids) => Effect.succeed(testUsers.filter((u) => ids.includes(u.id))),
        key: (u) => u.id,
      }),
    })

    const result = await Effect.runPromise(
      registry
        .use(async (loaders) => {
          const user1 = await loaders.UserById.load("1")
          const user2 = await loaders.UserById.load("2")
          return [user1.name, user2.name]
        })
        .pipe(Effect.provide(registry.toLayer()))
    )

    expect(result).toEqual(["Alice", "Bob"])
  })
})

// ==========================================================================
// Loader.mapByKey tests
// ==========================================================================

describe("Loader.mapByKey", () => {
  it("should map items to keys in correct order", () => {
    const items = [
      { id: "2", name: "Bob" },
      { id: "1", name: "Alice" },
    ]

    const result = Loader.mapByKey(["1", "2", "3"], items, (item) => item.id)

    expect(result[0]).toEqual({ id: "1", name: "Alice" })
    expect(result[1]).toEqual({ id: "2", name: "Bob" })
    expect(result[2]).toBeInstanceOf(Error)
  })

  it("should return errors for missing keys", () => {
    const items = [{ id: "1", name: "Alice" }]

    const result = Loader.mapByKey(["1", "missing"], items, (item) => item.id)

    expect(result[0]).toEqual({ id: "1", name: "Alice" })
    expect(result[1]).toBeInstanceOf(Error)
    expect((result[1] as Error).message).toContain("Not found: missing")
  })

  it("should handle empty keys array", () => {
    const items = [{ id: "1", name: "Alice" }]

    const result = Loader.mapByKey([], items, (item) => item.id)

    expect(result).toEqual([])
  })

  it("should handle empty items array", () => {
    const result = Loader.mapByKey(["1", "2"], [], (item: { id: string }) => item.id)

    expect(result[0]).toBeInstanceOf(Error)
    expect(result[1]).toBeInstanceOf(Error)
  })

  it("should use last item for duplicate keys", () => {
    const items = [
      { id: "1", name: "First" },
      { id: "1", name: "Second" },
    ]

    const result = Loader.mapByKey(["1"], items, (item) => item.id)

    expect(result[0]).toEqual({ id: "1", name: "Second" })
  })
})

// ==========================================================================
// Loader.groupByKey tests
// ==========================================================================

describe("Loader.groupByKey", () => {
  it("should group items by key", () => {
    const items = [
      { id: "p1", authorId: "1" },
      { id: "p2", authorId: "1" },
      { id: "p3", authorId: "2" },
    ]

    const result = Loader.groupByKey(["1", "2"], items, (item) => item.authorId)

    expect(result.get("1")).toHaveLength(2)
    expect(result.get("2")).toHaveLength(1)
  })

  it("should return empty arrays for keys with no items", () => {
    const items = [{ id: "p1", authorId: "1" }]

    const result = Loader.groupByKey(["1", "2"], items, (item) => item.authorId)

    expect(result.get("1")).toHaveLength(1)
    expect(result.get("2")).toEqual([])
  })

  it("should handle empty keys array", () => {
    const items = [{ id: "p1", authorId: "1" }]

    const result = Loader.groupByKey([], items, (item) => item.authorId)

    expect(result.size).toBe(0)
  })

  it("should handle empty items array", () => {
    const result = Loader.groupByKey(["1", "2"], [], (item: { authorId: string }) => item.authorId)

    expect(result.get("1")).toEqual([])
    expect(result.get("2")).toEqual([])
  })

  it("should ignore items with unmatched keys", () => {
    const items = [
      { id: "p1", authorId: "1" },
      { id: "p2", authorId: "3" }, // Not in requested keys
    ]

    const result = Loader.groupByKey(["1", "2"], items, (item) => item.authorId)

    expect(result.get("1")).toHaveLength(1)
    expect(result.get("2")).toEqual([])
    expect(result.has("3")).toBe(false)
  })
})

// ==========================================================================
// Service integration tests
// ==========================================================================

describe("Service integration", () => {
  interface DatabaseService {
    getUsersByIds: (ids: readonly string[]) => Effect.Effect<readonly User[], Error>
  }

  const DatabaseService = Context.GenericTag<DatabaseService>("DatabaseService")

  it("should integrate with Effect services", async () => {
    const registry = Loader.define({
      UserById: Loader.single<string, User, DatabaseService>({
        batch: (ids) =>
          Effect.gen(function* () {
            const db = yield* DatabaseService
            return yield* db.getUsersByIds(ids)
          }),
        key: (u) => u.id,
      }),
    })

    const dbLayer = Layer.succeed(DatabaseService, {
      getUsersByIds: (ids) =>
        Effect.succeed(testUsers.filter((u) => ids.includes(u.id))),
    })

    const result = await Effect.runPromise(
      registry.load("UserById", "1").pipe(
        Effect.provide(registry.toLayer()),
        Effect.provide(dbLayer)
      )
    )

    expect(result).toEqual({ id: "1", name: "Alice" })
  })

  it("should propagate service errors", async () => {
    const registry = Loader.define({
      UserById: Loader.single<string, User, DatabaseService>({
        batch: (ids) =>
          Effect.gen(function* () {
            const db = yield* DatabaseService
            return yield* db.getUsersByIds(ids)
          }),
        key: (u) => u.id,
      }),
    })

    const failingDbLayer = Layer.succeed(DatabaseService, {
      getUsersByIds: () => Effect.fail(new Error("Database connection failed")),
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const loaders = yield* registry.Service
        return yield* Effect.tryPromise(() => loaders.UserById.load("1"))
          .pipe(
            Effect.map(() => ({ error: null })),
            Effect.catchAll((e) => Effect.succeed({ error: e }))
          )
      }).pipe(Effect.provide(registry.toLayer()), Effect.provide(failingDbLayer))
    )

    expect(result.error).toBeDefined()
  })
})

// ==========================================================================
// Fresh instances per layer
// ==========================================================================

describe("Fresh instances per layer", () => {
  it("should create fresh loader instances for each layer", async () => {
    const batchSpy = vi.fn((ids: readonly string[]) =>
      Effect.succeed(testUsers.filter((u) => ids.includes(u.id)))
    )

    const registry = Loader.define({
      UserById: Loader.single<string, User>({
        batch: batchSpy,
        key: (u) => u.id,
      }),
    })

    // First request
    await Effect.runPromise(
      registry.load("UserById", "1").pipe(Effect.provide(registry.toLayer()))
    )

    // Second request with new layer - should not use cache from first
    await Effect.runPromise(
      registry.load("UserById", "1").pipe(Effect.provide(registry.toLayer()))
    )

    // Each toLayer() call creates fresh DataLoader instances
    expect(batchSpy).toHaveBeenCalledTimes(2)
  })
})
