import { Effect, Context, Layer } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder, execute } from "@effect-gql/core"

/**
 * Example: Colocated Fields
 *
 * Demonstrates how to define computed/relational fields inline with objectType
 * for better code organization.
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
// Services
// ============================================================================

class DatabaseService extends Context.Tag("DatabaseService")<
  DatabaseService,
  {
    readonly getUser: (id: string) => Effect.Effect<User, Error>
    readonly getUsers: () => Effect.Effect<User[], Error>
    readonly getPostsForUser: (userId: string) => Effect.Effect<Post[], Error>
    readonly getAuthor: (authorId: string) => Effect.Effect<User, Error>
  }
>() {}

class LoggerService extends Context.Tag("LoggerService")<
  LoggerService,
  {
    readonly info: (message: string) => Effect.Effect<void>
  }
>() {}

// ============================================================================
// Service Implementations (Mock)
// ============================================================================

const users: User[] = [
  { id: "1", name: "Alice", email: "alice@example.com" },
  { id: "2", name: "Bob", email: "bob@example.com" },
]

const posts: Post[] = [
  { id: "1", title: "First Post", content: "Hello world", authorId: "1" },
  { id: "2", title: "Second Post", content: "More content", authorId: "1" },
  { id: "3", title: "Bob's Post", content: "Bob's content", authorId: "2" },
]

const DatabaseServiceLive = Layer.succeed(DatabaseService, {
  getUser: (id: string) =>
    Effect.sync(() => {
      const user = users.find(u => u.id === id)
      if (!user) throw new Error(`User ${id} not found`)
      return user
    }),
  getUsers: () => Effect.succeed(users),
  getPostsForUser: (userId: string) =>
    Effect.succeed(posts.filter(p => p.authorId === userId)),
  getAuthor: (authorId: string) =>
    Effect.sync(() => {
      const author = users.find(u => u.id === authorId)
      if (!author) throw new Error(`Author ${authorId} not found`)
      return author
    }),
})

const LoggerServiceLive = Layer.succeed(LoggerService, {
  info: (message: string) =>
    Effect.sync(() => console.log(`[INFO] ${message}`)),
})

// ============================================================================
// GraphQL Schema Builder - COLOCATED FIELDS
// ============================================================================

const builder = GraphQLSchemaBuilder.empty
  // User type with its posts field defined inline
  .objectType({
    name: "User",
    schema: UserSchema,
    fields: {
      posts: {
        type: S.Array(PostSchema),
        args: S.Struct({
          limit: S.optional(S.Number),
        }),
        description: "Get posts written by this user",
        resolve: (parent: User, args: { limit?: number }) =>
          Effect.gen(function*() {
            const db = yield* DatabaseService
            const logger = yield* LoggerService
            yield* logger.info(`Fetching posts for user ${parent.id}`)
            const posts = yield* db.getPostsForUser(parent.id)
            return args.limit ? posts.slice(0, args.limit) : posts
          }),
      },
      // Can define multiple fields
      displayName: {
        type: S.String,
        description: "Formatted display name",
        resolve: (parent: User) =>
          Effect.succeed(`${parent.name} <${parent.email}>`),
      },
    },
  })

  // Post type with its author field defined inline
  .objectType({
    name: "Post",
    schema: PostSchema,
    fields: {
      author: {
        type: UserSchema,
        description: "The author of this post",
        resolve: (parent: Post) =>
          Effect.gen(function*() {
            const db = yield* DatabaseService
            return yield* db.getAuthor(parent.authorId)
          }),
      },
    },
  })

  // Queries
  .query("user", {
    type: UserSchema,
    args: S.Struct({ id: S.String }),
    description: "Get a user by ID",
    resolve: (args: { id: string }) =>
      Effect.gen(function*() {
        const db = yield* DatabaseService
        return yield* db.getUser(args.id)
      }),
  })

  .query("users", {
    type: S.Array(UserSchema),
    description: "Get all users",
    resolve: () =>
      Effect.gen(function*() {
        const db = yield* DatabaseService
        return yield* db.getUsers()
      }),
  })

// ============================================================================
// Build and Execute
// ============================================================================

const schema = builder.buildSchema()

console.log("✓ Schema built successfully with colocated fields")

const layer = Layer.mergeAll(DatabaseServiceLive, LoggerServiceLive)

const runExample = Effect.gen(function*() {
  console.log("\n=== Query: User with posts ===")
  const result1 = yield* execute(schema, layer)(
    `
      query {
        user(id: "1") {
          id
          name
          email
          displayName
          posts(limit: 2) {
            id
            title
            author {
              name
            }
          }
        }
      }
    `
  )
  console.log(JSON.stringify(result1, null, 2))

  console.log("\n=== Query: All users with their posts ===")
  const result2 = yield* execute(schema, layer)(
    `
      query {
        users {
          name
          displayName
          posts {
            title
          }
        }
      }
    `
  )
  console.log(JSON.stringify(result2, null, 2))
})

Effect.runPromise(runExample).catch(console.error)
