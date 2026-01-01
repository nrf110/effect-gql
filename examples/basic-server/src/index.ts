/**
 * Basic GraphQL Server Example
 *
 * This example demonstrates how to create a simple GraphQL server with Effect GQL.
 * It includes:
 * - Basic queries with arguments
 * - A simple mutation
 * - GraphiQL playground integration
 * - Health check endpoint
 */

import { Effect, Layer } from "effect"
import * as S from "effect/Schema"
import { HttpMiddleware, HttpRouter, HttpServerResponse } from "@effect/platform"
import { GraphQLSchemaBuilder, query, mutation, makeGraphQLRouter } from "@effect-gql/core"
import { serve } from "@effect-gql/node"

// =============================================================================
// Domain Models
// =============================================================================

/**
 * A simple User type defined with Effect Schema.
 * This single definition is used for both TypeScript types AND GraphQL types.
 */
const User = S.Struct({
  id: S.String,
  name: S.String,
  email: S.String,
})

type User = S.Schema.Type<typeof User>

// =============================================================================
// In-Memory Data Store
// =============================================================================

const users: User[] = [
  { id: "1", name: "Alice", email: "alice@example.com" },
  { id: "2", name: "Bob", email: "bob@example.com" },
  { id: "3", name: "Charlie", email: "charlie@example.com" },
]

// =============================================================================
// GraphQL Schema
// =============================================================================

/**
 * Build the GraphQL schema using the pipe API.
 *
 * The pipe API provides a fluent, functional way to compose your schema.
 * Each function (query, mutation, objectType, etc.) returns a transformation
 * that is applied to the builder.
 */
const schema = GraphQLSchemaBuilder.empty
  .pipe(
    // Simple query that returns a greeting
    query("hello", {
      type: S.String,
      description: "Returns a friendly greeting",
      resolve: () => Effect.succeed("Hello from Effect GQL!"),
    }),

    // Query with arguments
    query("echo", {
      args: S.Struct({ message: S.String }),
      type: S.String,
      description: "Echoes back the provided message",
      resolve: (args) => Effect.succeed(`Echo: ${args.message}`),
    }),

    // Query that returns a list of users
    query("users", {
      type: S.Array(User),
      description: "Get all users",
      resolve: () => Effect.succeed(users),
    }),

    // Query to get a single user by ID
    query("user", {
      args: S.Struct({ id: S.String }),
      type: S.OptionFromNullOr(User),
      description: "Get a user by ID",
      resolve: (args) =>
        Effect.succeed(users.find((u) => u.id === args.id) ?? null),
    }),

    // Mutation to create a new user
    mutation("createUser", {
      args: S.Struct({
        name: S.String,
        email: S.String,
      }),
      type: User,
      description: "Create a new user",
      resolve: (args) =>
        Effect.sync(() => {
          const newUser: User = {
            id: String(users.length + 1),
            name: args.name,
            email: args.email,
          }
          users.push(newUser)
          return newUser
        }),
    })
  )
  .buildSchema()

// =============================================================================
// HTTP Router
// =============================================================================

/**
 * Create the GraphQL router with GraphiQL enabled.
 *
 * The router handles:
 * - POST /graphql - GraphQL queries and mutations
 * - GET /graphql - GraphQL queries via GET (for simple queries)
 * - GET /graphiql - Interactive GraphQL playground
 */
const graphqlRouter = makeGraphQLRouter(schema, Layer.empty, {
  path: "/graphql",
  graphiql: {
    path: "/graphiql",
    endpoint: "/graphql",
  },
})

/**
 * CORS middleware to allow cross-origin requests.
 * Required for GraphiQL to work properly in browsers.
 */
const cors = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const response = yield* app
    return response.pipe(
      HttpServerResponse.setHeader("Access-Control-Allow-Origin", "*"),
      HttpServerResponse.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
      HttpServerResponse.setHeader("Access-Control-Allow-Headers", "Content-Type")
    )
  })
)

/**
 * Build the complete application by composing routers.
 *
 * This demonstrates how Effect GQL integrates with @effect/platform's
 * HTTP routing system.
 */
const app = HttpRouter.empty.pipe(
  // Handle OPTIONS preflight requests for CORS
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

  // Health check endpoint
  HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" })),

  // Mount the GraphQL router
  HttpRouter.concat(graphqlRouter),

  // Apply CORS headers to all responses
  cors
)

// =============================================================================
// Server Startup
// =============================================================================

/**
 * Start the server using @effect-gql/node's serve function.
 *
 * The serve function:
 * - Creates a Node.js HTTP server
 * - Handles graceful shutdown
 * - Provides lifecycle hooks
 */
serve(app, Layer.empty, {
  port: 4000,
  onStart: (url: string) => {
    console.log(`🚀 Server ready at ${url}`)
    console.log(`📊 GraphQL endpoint: ${url}/graphql`)
    console.log(`🎮 GraphiQL playground: ${url}/graphiql`)
    console.log(`❤️  Health check: ${url}/health`)
  },
})
