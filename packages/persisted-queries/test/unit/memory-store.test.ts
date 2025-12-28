import { describe, it, expect } from "vitest"
import { Effect, Option } from "effect"
import { makeMemoryStore, makeSafelistStore } from "../../src/memory-store"
import { PersistedQueryStore } from "../../src/store"

describe("makeMemoryStore", () => {
  it("should store and retrieve queries", async () => {
    const program = Effect.gen(function* () {
      const store = yield* PersistedQueryStore

      // Store a query
      yield* store.set("hash1", "query { hello }")

      // Retrieve it
      const result = yield* store.get("hash1")
      return result
    })

    const result = await Effect.runPromise(Effect.provide(program, makeMemoryStore()))

    expect(Option.isSome(result)).toBe(true)
    expect(Option.getOrNull(result)).toBe("query { hello }")
  })

  it("should return None for unknown hashes", async () => {
    const program = Effect.gen(function* () {
      const store = yield* PersistedQueryStore
      return yield* store.get("unknown-hash")
    })

    const result = await Effect.runPromise(Effect.provide(program, makeMemoryStore()))

    expect(Option.isNone(result)).toBe(true)
  })

  it("should report existence with has()", async () => {
    const program = Effect.gen(function* () {
      const store = yield* PersistedQueryStore

      yield* store.set("hash1", "query { hello }")

      const exists = yield* store.has("hash1")
      const notExists = yield* store.has("unknown")

      return { exists, notExists }
    })

    const result = await Effect.runPromise(Effect.provide(program, makeMemoryStore()))

    expect(result.exists).toBe(true)
    expect(result.notExists).toBe(false)
  })

  it("should evict LRU entries when max size exceeded", async () => {
    const program = Effect.gen(function* () {
      const store = yield* PersistedQueryStore

      // Fill the store to capacity (maxSize = 3)
      yield* store.set("hash1", "query1")
      yield* store.set("hash2", "query2")
      yield* store.set("hash3", "query3")

      // Access hash1 to make it recently used
      yield* store.get("hash1")

      // Add another entry, which should evict hash2 (LRU)
      yield* store.set("hash4", "query4")

      const hash1 = yield* store.get("hash1")
      const hash2 = yield* store.get("hash2")
      const hash3 = yield* store.get("hash3")
      const hash4 = yield* store.get("hash4")

      return { hash1, hash2, hash3, hash4 }
    })

    const result = await Effect.runPromise(Effect.provide(program, makeMemoryStore({ maxSize: 3 })))

    // hash1 was accessed, so it's recent
    expect(Option.isSome(result.hash1)).toBe(true)
    // hash2 was LRU, should be evicted
    expect(Option.isNone(result.hash2)).toBe(true)
    // hash3 and hash4 should exist
    expect(Option.isSome(result.hash3)).toBe(true)
    expect(Option.isSome(result.hash4)).toBe(true)
  })

  it("should update last accessed time on get", async () => {
    const program = Effect.gen(function* () {
      const store = yield* PersistedQueryStore

      // Add entries in order
      yield* store.set("hash1", "query1")
      yield* store.set("hash2", "query2")
      yield* store.set("hash3", "query3")

      // Access hash1 to refresh it
      yield* store.get("hash1")

      // Add new entry, should evict hash2 (oldest non-accessed)
      yield* store.set("hash4", "query4")

      const hash1Exists = yield* store.has("hash1")
      const hash2Exists = yield* store.has("hash2")

      return { hash1Exists, hash2Exists }
    })

    const result = await Effect.runPromise(Effect.provide(program, makeMemoryStore({ maxSize: 3 })))

    expect(result.hash1Exists).toBe(true)
    expect(result.hash2Exists).toBe(false)
  })
})

describe("makeSafelistStore", () => {
  const safelistQueries = {
    hash1: "query GetUser { user { id } }",
    hash2: "query GetPosts { posts { title } }",
  }

  it("should retrieve pre-registered queries", async () => {
    const program = Effect.gen(function* () {
      const store = yield* PersistedQueryStore
      return yield* store.get("hash1")
    })

    const result = await Effect.runPromise(
      Effect.provide(program, makeSafelistStore(safelistQueries))
    )

    expect(Option.isSome(result)).toBe(true)
    expect(Option.getOrNull(result)).toBe("query GetUser { user { id } }")
  })

  it("should return None for non-safelisted queries", async () => {
    const program = Effect.gen(function* () {
      const store = yield* PersistedQueryStore
      return yield* store.get("unknown-hash")
    })

    const result = await Effect.runPromise(
      Effect.provide(program, makeSafelistStore(safelistQueries))
    )

    expect(Option.isNone(result)).toBe(true)
  })

  it("should ignore set() calls (no-op)", async () => {
    const program = Effect.gen(function* () {
      const store = yield* PersistedQueryStore

      // Try to add a new query
      yield* store.set("new-hash", "query { newQuery }")

      // It should not be stored
      return yield* store.get("new-hash")
    })

    const result = await Effect.runPromise(
      Effect.provide(program, makeSafelistStore(safelistQueries))
    )

    expect(Option.isNone(result)).toBe(true)
  })

  it("should report existence with has()", async () => {
    const program = Effect.gen(function* () {
      const store = yield* PersistedQueryStore

      const exists = yield* store.has("hash1")
      const notExists = yield* store.has("unknown")

      return { exists, notExists }
    })

    const result = await Effect.runPromise(
      Effect.provide(program, makeSafelistStore(safelistQueries))
    )

    expect(result.exists).toBe(true)
    expect(result.notExists).toBe(false)
  })
})
