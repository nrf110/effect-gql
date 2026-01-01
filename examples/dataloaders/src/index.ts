/**
 * DataLoader Example - Solving the N+1 Problem
 *
 * This example demonstrates how to use Effect GQL's DataLoader integration
 * to efficiently batch and cache database queries.
 *
 * The N+1 Problem:
 * When fetching a list of posts with their authors, a naive implementation
 * would make 1 query for posts + N queries for each author = N+1 queries.
 *
 * With DataLoader:
 * All author lookups within the same request are batched into a single query,
 * reducing N+1 queries down to just 2 queries.
 */

import { Effect, Context, Layer } from "effect"
import * as S from "effect/Schema"
import { HttpRouter, HttpServerResponse } from "@effect/platform"
import {
  GraphQLSchemaBuilder,
  query,
  objectType,
  field,
  makeGraphQLRouter,
  Loader,
} from "@effect-gql/core"
import { serve } from "@effect-gql/node"

// =============================================================================
// Domain Models
// =============================================================================

const User = S.Struct({
  id: S.String,
  name: S.String,
  email: S.String,
})
type User = S.Schema.Type<typeof User>

const Post = S.Struct({
  id: S.String,
  title: S.String,
  content: S.String,
  authorId: S.String,
})
type Post = S.Schema.Type<typeof Post>

// =============================================================================
// Mock Database
// =============================================================================

const users: User[] = [
  { id: "1", name: "Alice", email: "alice@example.com" },
  { id: "2", name: "Bob", email: "bob@example.com" },
  { id: "3", name: "Charlie", email: "charlie@example.com" },
]

const posts: Post[] = [
  { id: "p1", title: "Alice's First Post", content: "Hello from Alice!", authorId: "1" },
  { id: "p2", title: "Alice's Second Post", content: "More thoughts from Alice", authorId: "1" },
  { id: "p3", title: "Bob's Post", content: "Hello from Bob!", authorId: "2" },
  { id: "p4", title: "Alice's Third Post", content: "Even more from Alice", authorId: "1" },
  { id: "p5", title: "Charlie's Post", content: "Hello from Charlie!", authorId: "3" },
]

// =============================================================================
// Database Service
// =============================================================================

/**
 * Database service that simulates batch database queries.
 * In a real application, this would be your database client.
 */
class DatabaseService extends Context.Tag("DatabaseService")<
  DatabaseService,
  {
    readonly getUsersByIds: (ids: readonly string[]) => Effect.Effect<readonly User[]>
    readonly getPostsByAuthorIds: (ids: readonly string[]) => Effect.Effect<readonly Post[]>
    readonly getAllPosts: () => Effect.Effect<readonly Post[]>
  }
>() {}

const DatabaseServiceLive = Layer.succeed(DatabaseService, {
  getUsersByIds: (ids) =>
    Effect.sync(() => {
      console.log(`📦 [DB] Batch fetching users: [${ids.join(", ")}]`)
      return users.filter((u) => ids.includes(u.id))
    }),

  getPostsByAuthorIds: (ids) =>
    Effect.sync(() => {
      console.log(`📦 [DB] Batch fetching posts for authors: [${ids.join(", ")}]`)
      return posts.filter((p) => ids.includes(p.authorId))
    }),

  getAllPosts: () =>
    Effect.sync(() => {
      console.log("📦 [DB] Fetching all posts")
      return posts
    }),
})

// =============================================================================
// DataLoader Definitions
// =============================================================================

/**
 * Define loaders using Effect GQL's Loader API.
 *
 * The Loader API provides:
 * - Type-safe loader definitions
 * - Automatic request-scoped caching
 * - Integration with Effect's service system
 *
 * Two types of loaders:
 * - `Loader.single`: One key → one value (e.g., user by ID)
 * - `Loader.grouped`: One key → many values (e.g., posts by author ID)
 */
const loaders = Loader.define({
  /**
   * UserById: Fetches a single user by their ID.
   * Multiple calls with different IDs in the same request are batched.
   */
  UserById: Loader.single<string, User, DatabaseService>({
    batch: (ids) =>
      Effect.gen(function* () {
        const db = yield* DatabaseService
        return yield* db.getUsersByIds(ids)
      }),
    key: (user) => user.id,
  }),

  /**
   * PostsByAuthorId: Fetches all posts for an author.
   * The `grouped` loader automatically groups results by the key function.
   */
  PostsByAuthorId: Loader.grouped<string, Post, DatabaseService>({
    batch: (authorIds) =>
      Effect.gen(function* () {
        const db = yield* DatabaseService
        return yield* db.getPostsByAuthorIds(authorIds)
      }),
    groupBy: (post) => post.authorId,
  }),
})

// =============================================================================
// GraphQL Schema
// =============================================================================

const schema = GraphQLSchemaBuilder.empty
  .pipe(
    // Register the User type with a computed 'posts' field
    objectType({
      name: "User",
      schema: User,
    }),

    // Add computed field for user's posts
    field("User", "posts", {
      type: S.Array(Post),
      description: "All posts written by this user",
      resolve: (parent: User) => loaders.load("PostsByAuthorId", parent.id),
    }),

    // Register the Post type with a computed 'author' field
    objectType({
      name: "Post",
      schema: Post,
    }),

    // Add computed field for post's author
    field("Post", "author", {
      type: User,
      description: "The author of this post",
      resolve: (parent: Post) => loaders.load("UserById", parent.authorId),
    }),

    // Query: Get all posts
    query("posts", {
      type: S.Array(Post),
      description: "Get all posts",
      resolve: () =>
        Effect.gen(function* () {
          const db = yield* DatabaseService
          const allPosts = yield* db.getAllPosts()
          return [...allPosts]
        }),
    }),

    // Query: Get a single user
    query("user", {
      args: S.Struct({ id: S.String }),
      type: User,
      description: "Get a user by ID",
      resolve: (args) => loaders.load("UserById", args.id),
    }),

    // Query: Get all users
    query("users", {
      type: S.Array(User),
      description: "Get all users",
      resolve: () => Effect.succeed(users),
    })
  )
  .buildSchema()

// =============================================================================
// Application Layer
// =============================================================================

/**
 * The loader layer is request-scoped, meaning each GraphQL request
 * gets fresh DataLoader instances. This ensures:
 * 1. No data leaking between requests
 * 2. Cache is scoped to a single request
 * 3. Batching only occurs within the same request
 *
 * The loaders.toLayer() requires DatabaseService, so we provide it
 * using Layer.provideMerge to make both available to resolvers.
 */
const LoaderLayer = Layer.provide(loaders.toLayer(), DatabaseServiceLive)
const AppLayer = Layer.mergeAll(DatabaseServiceLive, LoaderLayer)

// =============================================================================
// HTTP Router
// =============================================================================

const graphqlRouter = makeGraphQLRouter(schema, AppLayer, {
  path: "/graphql",
  graphiql: {
    path: "/graphiql",
    endpoint: "/graphql",
  },
})

const router = HttpRouter.empty.pipe(
  HttpRouter.options(
    "/graphql",
    HttpServerResponse.empty().pipe(
      HttpServerResponse.setStatus(204),
      HttpServerResponse.setHeader("Access-Control-Allow-Origin", "*"),
      HttpServerResponse.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
      HttpServerResponse.setHeader("Access-Control-Allow-Headers", "Content-Type"),
      Effect.orDie
    )
  ),
  HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" })),
  HttpRouter.concat(graphqlRouter)
)

// =============================================================================
// Server Startup
// =============================================================================

serve(router, Layer.empty, {
  port: 4001,
  onStart: (url: string) => {
    console.log(`🚀 DataLoader Example Server ready at ${url}`)
    console.log(`📊 GraphQL endpoint: ${url}/graphql`)
    console.log(`🎮 GraphiQL playground: ${url}/graphiql`)
    console.log("")
    console.log("Try this query to see batching in action:")
    console.log(`
  query {
    posts {
      title
      author {
        name
      }
    }
  }
`)
    console.log("Watch the console - you'll see only 2 DB calls instead of 6!")
  },
})
