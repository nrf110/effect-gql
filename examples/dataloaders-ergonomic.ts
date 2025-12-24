import { Effect, Context, Layer } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder, execute, Loader } from "@effect-gql/core"

/**
 * Example: Ergonomic DataLoaders API
 *
 * This demonstrates the cleaner, more declarative way to define DataLoaders
 * using the Loader helpers.
 *
 * Compare this to dataloaders.ts to see the reduction in boilerplate.
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
// Database Service
// ============================================================================

class DatabaseService extends Context.Tag("DatabaseService")<
  DatabaseService,
  {
    readonly getUsersByIds: (ids: readonly string[]) => Effect.Effect<readonly User[]>
    readonly getPostsForAuthors: (authorIds: readonly string[]) => Effect.Effect<readonly Post[]>
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
      return users.filter((u) => ids.includes(u.id))
    }),
  getPostsForAuthors: (authorIds) =>
    Effect.sync(() => {
      console.log(`  [DB] Batch fetching posts for authors: [${authorIds.join(", ")}]`)
      return posts.filter((p) => authorIds.includes(p.authorId))
    }),
  getAllPosts: () =>
    Effect.sync(() => {
      console.log("  [DB] Fetching all posts")
      return posts
    }),
})

// ============================================================================
// Define Loaders - The Clean Way!
// ============================================================================

/**
 * Define all loaders declaratively in one place.
 *
 * - Loader.single: one key -> one value (e.g., user by ID)
 * - Loader.grouped: one key -> many values (e.g., posts by author)
 */
const loaders = Loader.define({
  // Single-value loader: one key -> one user
  UserById: Loader.single<string, User, DatabaseService>({
    batch: (ids) =>
      Effect.gen(function* () {
        const db = yield* DatabaseService
        return yield* db.getUsersByIds(ids)
      }),
    key: (user) => user.id,
  }),

  // Grouped loader: one key -> many posts
  PostsByAuthorId: Loader.grouped<string, Post, DatabaseService>({
    batch: (authorIds) =>
      Effect.gen(function* () {
        const db = yield* DatabaseService
        return yield* db.getPostsForAuthors(authorIds)
      }),
    groupBy: (post) => post.authorId,
  }),
})

// ============================================================================
// GraphQL Schema
// ============================================================================

const builder = GraphQLSchemaBuilder.empty
  .objectType({
    name: "User",
    schema: UserSchema,
    fields: {
      posts: {
        type: S.Array(PostSchema),
        description: "Posts written by this user",
        resolve: (parent: User) =>
          // Clean one-liner!
          loaders.load("PostsByAuthorId", parent.id),
      },
    },
  })

  .objectType({
    name: "Post",
    schema: PostSchema,
    fields: {
      author: {
        type: UserSchema,
        description: "The author of this post",
        resolve: (parent: Post) =>
          // Just specify loader name and key
          loaders.load("UserById", parent.authorId),
      },
    },
  })

  .query("posts", {
    type: S.Array(PostSchema),
    description: "Get all posts",
    resolve: () =>
      Effect.gen(function* () {
        const db = yield* DatabaseService
        const allPosts = yield* db.getAllPosts()
        return [...allPosts]
      }),
  })

  .query("user", {
    type: UserSchema,
    args: S.Struct({ id: S.String }),
    description: "Get a user by ID",
    resolve: (args: { id: string }) =>
      loaders.load("UserById", args.id),
  })


const schema = builder.buildSchema()

console.log("✓ Schema built successfully with ergonomic DataLoaders")

// ============================================================================
// Execute Queries
// ============================================================================

/**
 * Create a request-scoped layer with fresh loaders.
 *
 * The loaders layer depends on DatabaseService, so we:
 * 1. Provide DatabaseServiceLive to loaders.toLayer()
 * 2. Merge with DatabaseServiceLive for use by resolvers
 */
const makeRequestLayer = () =>
  Layer.merge(
    DatabaseServiceLive,
    loaders.toLayer().pipe(Layer.provide(DatabaseServiceLive))
  )

const runExample = Effect.gen(function* () {
  console.log("\n=== Example 1: Posts with Authors (N+1 solved) ===")
  console.log("Watch the batching - only 2 DB calls for 5 posts:\n")

  const result1 = yield* execute(schema, makeRequestLayer())(
    `
      query {
        posts {
          title
          author {
            name
          }
        }
      }
    `
  )
  console.log("\nResult:")
  console.log(JSON.stringify(result1.data?.posts?.slice(0, 3), null, 2))
  console.log("  ... and 2 more posts")

  console.log("\n\n=== Example 2: Single User with Posts ===")
  console.log("Efficient batching for nested data:\n")

  const result2 = yield* execute(schema, makeRequestLayer())(
    `
      query {
        user(id: "1") {
          name
          email
          posts {
            title
          }
        }
      }
    `
  )
  console.log("\nResult:")
  console.log(JSON.stringify(result2, null, 2))

  console.log("\n\n=== Example 3: Complex Nested Query ===")
  console.log("User -> Posts -> Author with efficient batching:\n")

  const result3 = yield* execute(schema, makeRequestLayer())(
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
  console.log(JSON.stringify(result3, null, 2))
})

Effect.runPromise(runExample).catch(console.error)
