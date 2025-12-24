import { Effect, Context, Layer } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder, execute } from "@effect-gql/core"

/**
 * Example: Layer-per-Request Pattern
 *
 * This demonstrates the more flexible approach where the schema is built once,
 * then each request provides its own layer with all required services.
 * This enables request-scoped dependencies like auth context.
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
    readonly createUser: (name: string, email: string) => Effect.Effect<User, Error>
    readonly getPostsForUser: (userId: string) => Effect.Effect<Post[], Error>
  }
>() {}

class LoggerService extends Context.Tag("LoggerService")<
  LoggerService,
  {
    readonly info: (message: string) => Effect.Effect<void, never, RequestContext>
  }
>() {}

// Request-scoped service example
class RequestContext extends Context.Tag("RequestContext")<
  RequestContext,
  {
    readonly requestId: string
    readonly timestamp: Date
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
  createUser: (name: string, email: string) =>
    Effect.sync(() => {
      const user: User = { id: String(users.length + 1), name, email }
      users.push(user)
      return user
    }),
  getPostsForUser: (userId: string) =>
    Effect.succeed(posts.filter(p => p.authorId === userId)),
})

const LoggerServiceLive = Layer.succeed(LoggerService, {
  info: (message: string) =>
    Effect.gen(function*() {
      // Can access request context!
      const ctx = yield* RequestContext
      console.log(`[${ctx.requestId}] [INFO] ${message}`)
    }),
})

// ============================================================================
// GraphQL Schema Builder
// ============================================================================

const builder = GraphQLSchemaBuilder.empty
  // User type with colocated posts field
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
    },
  })

  // Post type
  .objectType({ name: "Post", schema: PostSchema })

  // Query: Get single user
  .query("user", {
    type: UserSchema,
    args: S.Struct({
      id: S.String,
    }),
    description: "Get a user by ID",
    resolve: (args) =>
      Effect.gen(function*() {
        const db = yield* DatabaseService
        const logger = yield* LoggerService
        yield* logger.info(`Fetching user ${args.id}`)
        return yield* db.getUser(args.id)
      }),
  })

  // Query: Get all users
  .query("users", {
    type: S.Array(UserSchema),
    description: "Get all users",
    resolve: () =>
      Effect.gen(function*() {
        const db = yield* DatabaseService
        return yield* db.getUsers()
      }),
  })

  // Mutation: Create user
  .mutation("createUser", {
    type: UserSchema,
    args: S.Struct({
      name: S.String,
      email: S.String,
    }),
    description: "Create a new user",
    resolve: (args) =>
      Effect.gen(function*() {
        const db = yield* DatabaseService
        const logger = yield* LoggerService
        yield* logger.info(`Creating user ${args.name}`)
        return yield* db.createUser(args.name, args.email)
      }),
  })

// ============================================================================
// Build Schema (No services needed yet!)
// ============================================================================

const schema = builder.buildSchema()

console.log("✓ Schema built successfully (no services required)")

// ============================================================================
// Execute Queries with Different Layers Per Request
// ============================================================================

const runExample = Effect.gen(function*() {
  // Request 1 - with request context
  const request1Layer = Layer.mergeAll(
    DatabaseServiceLive,
    LoggerServiceLive,
    Layer.succeed(RequestContext, {
      requestId: "req-001",
      timestamp: new Date()
    })
  )

  console.log("\n=== Request 1: Get user ===")
  const result1 = yield* execute(schema, request1Layer)(
    `
      query {
        user(id: "1") {
          id
          name
          email
          posts(limit: 1) {
            id
            title
          }
        }
      }
    `
  )
  console.log(JSON.stringify(result1, null, 2))

  // Request 2 - different request context
  const request2Layer = Layer.mergeAll(
    DatabaseServiceLive,
    LoggerServiceLive,
    Layer.succeed(RequestContext, {
      requestId: "req-002",
      timestamp: new Date()
    })
  )

  console.log("\n=== Request 2: Get all users ===")
  const result2 = yield* execute(schema, request2Layer)(
    `
      query {
        users {
          id
          name
          posts {
            title
          }
        }
      }
    `
  )
  console.log(JSON.stringify(result2, null, 2))

  // Request 3 - mutation
  const request3Layer = Layer.mergeAll(
    DatabaseServiceLive,
    LoggerServiceLive,
    Layer.succeed(RequestContext, {
      requestId: "req-003",
      timestamp: new Date()
    })
  )

  console.log("\n=== Request 3: Create user ===")
  const result3 = yield* execute(schema, request3Layer)(
    `
      mutation {
        createUser(name: "Charlie", email: "charlie@example.com") {
          id
          name
          email
        }
      }
    `
  )
  console.log(JSON.stringify(result3, null, 2))
})

// Run the example
Effect.runPromise(runExample).catch(console.error)
