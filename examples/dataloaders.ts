import { Effect, Context, Layer } from "effect"
import * as S from "effect/Schema"
import DataLoader from "dataloader"
import { GraphQLSchemaBuilder, execute } from "@effect-gql/core"

/**
 * Example: DataLoaders with Effect
 *
 * This demonstrates how to solve the N+1 problem using DataLoader.
 * DataLoaders batch multiple requests that occur in the same tick of the
 * event loop, which is perfect for GraphQL's promise-based resolver model.
 *
 * Key insight: GraphQL resolvers run as separate promises, so we need
 * DataLoader's promise-based batching rather than Effect's fiber-based batching.
 */

// ============================================================================
// Domain Models
// ============================================================================

const UserSchema = S.Struct({
  id: S.String,
  name: S.String,
  email: S.String,
})

type User = S.Schema.Type<typeof UserSchema>

const PostSchema = S.Struct({
  id: S.String,
  title: S.String,
  content: S.String,
  authorId: S.String,
})

type Post = S.Schema.Type<typeof PostSchema>

// ============================================================================
// Database Service (Mock)
// ============================================================================

class DatabaseService extends Context.Tag("DatabaseService")<
  DatabaseService,
  {
    readonly getUsersByIds: (ids: readonly string[]) => Effect.Effect<readonly User[]>
    readonly getPostsByAuthorIds: (authorIds: readonly string[]) => Effect.Effect<Map<string, Post[]>>
    readonly getAllPosts: () => Effect.Effect<readonly Post[]>
  }
>() {}

// Mock data
const users: User[] = [
  { id: "1", name: "Alice", email: "alice@example.com" },
  { id: "2", name: "Bob", email: "bob@example.com" },
  { id: "3", name: "Charlie", email: "charlie@example.com" },
]

const posts: Post[] = [
  { id: "p1", title: "Alice's First Post", content: "Hello from Alice", authorId: "1" },
  { id: "p2", title: "Alice's Second Post", content: "More from Alice", authorId: "1" },
  { id: "p3", title: "Bob's Post", content: "Hello from Bob", authorId: "2" },
  { id: "p4", title: "Alice's Third Post", content: "Even more from Alice", authorId: "1" },
  { id: "p5", title: "Charlie's Post", content: "Hello from Charlie", authorId: "3" },
]

const DatabaseServiceLive = Layer.succeed(DatabaseService, {
  getUsersByIds: (ids) =>
    Effect.sync(() => {
      console.log(`  [DB] Batch fetching users: [${ids.join(", ")}]`)
      return users.filter(u => ids.includes(u.id))
    }),
  getPostsByAuthorIds: (authorIds) =>
    Effect.sync(() => {
      console.log(`  [DB] Batch fetching posts for authors: [${authorIds.join(", ")}]`)
      const result = new Map<string, Post[]>()
      for (const authorId of authorIds) {
        result.set(authorId, posts.filter(p => p.authorId === authorId))
      }
      return result
    }),
  getAllPosts: () =>
    Effect.sync(() => {
      console.log("  [DB] Fetching all posts")
      return posts
    }),
})

// ============================================================================
// DataLoader Service - Request-scoped loaders
// ============================================================================

/**
 * DataLoaders service provides request-scoped data loaders.
 *
 * IMPORTANT: DataLoaders must be created fresh for each request to:
 * 1. Prevent data leaking between requests
 * 2. Ensure cache is scoped to a single request
 * 3. Batch only within the same request
 */
class DataLoaders extends Context.Tag("DataLoaders")<
  DataLoaders,
  {
    readonly userById: DataLoader<string, User>
    readonly postsByAuthorId: DataLoader<string, Post[]>
  }
>() {}

/**
 * Create DataLoaders layer from a DatabaseService.
 *
 * This creates fresh DataLoader instances that batch database calls.
 * The batch function collects all keys requested in the same tick
 * and makes a single database call.
 */
const makeDataLoaders = (db: {
  getUsersByIds: (ids: readonly string[]) => Effect.Effect<readonly User[]>
  getPostsByAuthorIds: (ids: readonly string[]) => Effect.Effect<Map<string, Post[]>>
}) => {
  // User loader - batches user fetches by ID
  const userById = new DataLoader<string, User>(async (ids) => {
    const users = await Effect.runPromise(db.getUsersByIds(ids))
    // DataLoader requires results in same order as keys
    return ids.map(id => {
      const user = users.find(u => u.id === id)
      if (!user) return new Error(`User ${id} not found`)
      return user
    })
  })

  // Posts loader - batches post fetches by author ID
  const postsByAuthorId = new DataLoader<string, Post[]>(async (authorIds) => {
    const postsMap = await Effect.runPromise(db.getPostsByAuthorIds(authorIds))
    // Return posts for each author in order
    return authorIds.map(id => postsMap.get(id) ?? [])
  })

  return { userById, postsByAuthorId }
}

// ============================================================================
// GraphQL Schema
// ============================================================================

const builder = GraphQLSchemaBuilder.empty
  // User type with posts field (uses dataloader)
  .objectType({
    name: "User",
    schema: UserSchema,
    fields: {
      posts: {
        type: S.Array(PostSchema),
        description: "Posts written by this user (batched)",
        resolve: (parent: User) =>
          Effect.gen(function*() {
            const loaders = yield* DataLoaders
            return yield* Effect.promise(() => loaders.postsByAuthorId.load(parent.id))
          }),
      },
    },
  })

  // Post type with author field (uses dataloader)
  .objectType({
    name: "Post",
    schema: PostSchema,
    fields: {
      author: {
        type: UserSchema,
        description: "The author of this post (batched)",
        resolve: (parent: Post) =>
          Effect.gen(function*() {
            const loaders = yield* DataLoaders
            return yield* Effect.promise(() => loaders.userById.load(parent.authorId))
          }),
      },
    },
  })

  // Query: Get all posts
  .query("posts", {
    type: S.Array(PostSchema),
    description: "Get all posts",
    resolve: () =>
      Effect.gen(function*() {
        const db = yield* DatabaseService
        const allPosts = yield* db.getAllPosts()
        return [...allPosts]
      }),
  })

  // Query: Get single user
  .query("user", {
    type: UserSchema,
    args: S.Struct({ id: S.String }),
    description: "Get a user by ID",
    resolve: (args: { id: string }) =>
      Effect.gen(function*() {
        const loaders = yield* DataLoaders
        return yield* Effect.promise(() => loaders.userById.load(args.id))
      }),
  })

const schema = builder.buildSchema()

console.log("✓ Schema built successfully with DataLoaders")

// ============================================================================
// Execute Example Queries
// ============================================================================

/**
 * Create a request-scoped layer with fresh DataLoaders.
 *
 * In a real server, you'd create this layer for each incoming request:
 *
 *   const requestLayer = Layer.mergeAll(
 *     DatabaseServiceLive,
 *     makeRequestDataLoaders()
 *   )
 */
const makeRequestLayer = () =>
  Effect.gen(function*() {
    const db = yield* DatabaseService
    const loaders = makeDataLoaders(db)
    return Layer.succeed(DataLoaders, loaders)
  }).pipe(
    Effect.provide(DatabaseServiceLive),
    Effect.runSync
  )

const runExample = Effect.gen(function*() {
  // Example 1: N+1 problem solved!
  // Without batching: 1 query for posts + 5 queries for authors = 6 queries
  // With batching: 1 query for posts + 1 batched query for authors = 2 queries
  console.log("\n=== Example 1: Posts with Authors (N+1 solved) ===")
  console.log("Without batching this would be 6 DB calls. Watch for batching:\n")

  const layer1 = Layer.merge(DatabaseServiceLive, makeRequestLayer())
  const result1 = yield* execute(schema, layer1)(
    `
      query {
        posts {
          id
          title
          author {
            name
            email
          }
        }
      }
    `
  )
  console.log("\nResult:")
  console.log(JSON.stringify(result1, null, 2))

  // Example 2: Users with their posts
  console.log("\n\n=== Example 2: User with Posts (bidirectional batching) ===\n")

  const layer2 = Layer.merge(DatabaseServiceLive, makeRequestLayer())
  const result2 = yield* execute(schema, layer2)(
    `
      query {
        user(id: "1") {
          name
          posts {
            title
            author {
              name
            }
          }
        }
      }
    `
  )
  console.log("\nResult:")
  console.log(JSON.stringify(result2, null, 2))

  // Example 3: Deep nesting - multiple levels of batching
  console.log("\n\n=== Example 3: Deep Nesting ===\n")

  const layer3 = Layer.merge(DatabaseServiceLive, makeRequestLayer())
  const result3 = yield* execute(schema, layer3)(
    `
      query {
        posts {
          title
          author {
            name
            posts {
              title
            }
          }
        }
      }
    `
  )
  console.log("\nResult (first 2 posts):")
  console.log(JSON.stringify(result3.data?.posts?.slice(0, 2), null, 2))
})

Effect.runPromise(runExample).catch(console.error)
