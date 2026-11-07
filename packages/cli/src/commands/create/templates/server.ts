/**
 * Server template generation for each server type
 */

import type { TemplateContext } from "../types"

/**
 * Generate Node.js server template
 */
const generateNodeServer = (ctx: TemplateContext): string => `/**
 * ${ctx.name} - GraphQL Server
 *
 * A GraphQL server built with Effect GQL and Node.js.
 */

import { Effect, Layer } from "effect"
import * as S from "effect/Schema"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { GraphQLSchemaBuilder, query, mutation, makeGraphQLRouter } from "@effect-gql/core"
import { serve } from "@effect-gql/node"

// =============================================================================
// Domain Models
// =============================================================================

/**
 * Define your types with Effect Schema.
 * This single definition is used for both TypeScript types AND GraphQL types.
 */
const User = S.Struct({
  id: S.String,
  name: S.String,
  email: S.String,
})

type User = S.Schema.Type<typeof User>

// =============================================================================
// In-Memory Data Store (replace with your database)
// =============================================================================

const users: User[] = [
  { id: "1", name: "Alice", email: "alice@example.com" },
  { id: "2", name: "Bob", email: "bob@example.com" },
]

// =============================================================================
// GraphQL Schema
// =============================================================================

const schema = GraphQLSchemaBuilder.empty
  .pipe(
    // Simple query
    query("hello", {
      type: S.String,
      description: "Returns a friendly greeting",
      resolve: () => Effect.succeed("Hello from ${ctx.name}!"),
    }),

    // Query with arguments
    query("user", {
      args: S.Struct({ id: S.String }),
      type: S.NullOr(User),
      description: "Get a user by ID",
      resolve: (args) => Effect.succeed(users.find((u) => u.id === args.id) ?? null),
    }),

    // Query that returns a list
    query("users", {
      type: S.Array(User),
      description: "Get all users",
      resolve: () => Effect.succeed(users),
    }),

    // Mutation
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

const graphqlRouter = makeGraphQLRouter(schema, Layer.empty, {
  path: "/graphql",
  graphiql: {
    path: "/graphiql",
    endpoint: "/graphql",
  },
})

const router = Layer.merge(
  HttpRouter.add("GET", "/health", HttpServerResponse.json({ status: "ok" }).pipe(Effect.orDie)),
  graphqlRouter
)

// =============================================================================
// Server Startup
// =============================================================================

serve(router, Layer.empty, {
  port: 4000,
  onStart: (url: string) => {
    console.log(\`Server ready at \${url}\`)
    console.log(\`GraphQL endpoint: \${url}/graphql\`)
    console.log(\`GraphiQL playground: \${url}/graphiql\`)
    console.log(\`Health check: \${url}/health\`)
  },
})
`

/**
 * Generate Bun server template
 */
const generateBunServer = (ctx: TemplateContext): string => `/**
 * ${ctx.name} - GraphQL Server
 *
 * A GraphQL server built with Effect GQL and Bun.
 */

import { Effect, Layer } from "effect"
import * as S from "effect/Schema"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { GraphQLSchemaBuilder, query, mutation, makeGraphQLRouter } from "@effect-gql/core"
import { serve } from "@effect-gql/bun"

// =============================================================================
// Domain Models
// =============================================================================

const User = S.Struct({
  id: S.String,
  name: S.String,
  email: S.String,
})

type User = S.Schema.Type<typeof User>

// =============================================================================
// In-Memory Data Store (replace with your database)
// =============================================================================

const users: User[] = [
  { id: "1", name: "Alice", email: "alice@example.com" },
  { id: "2", name: "Bob", email: "bob@example.com" },
]

// =============================================================================
// GraphQL Schema
// =============================================================================

const schema = GraphQLSchemaBuilder.empty
  .pipe(
    query("hello", {
      type: S.String,
      description: "Returns a friendly greeting",
      resolve: () => Effect.succeed("Hello from ${ctx.name}!"),
    }),

    query("user", {
      args: S.Struct({ id: S.String }),
      type: S.NullOr(User),
      description: "Get a user by ID",
      resolve: (args) => Effect.succeed(users.find((u) => u.id === args.id) ?? null),
    }),

    query("users", {
      type: S.Array(User),
      description: "Get all users",
      resolve: () => Effect.succeed(users),
    }),

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

const graphqlRouter = makeGraphQLRouter(schema, Layer.empty, {
  path: "/graphql",
  graphiql: {
    path: "/graphiql",
    endpoint: "/graphql",
  },
})

const router = Layer.merge(
  HttpRouter.add("GET", "/health", HttpServerResponse.json({ status: "ok" }).pipe(Effect.orDie)),
  graphqlRouter
)

// =============================================================================
// Server Startup
// =============================================================================

serve(router, Layer.empty, {
  port: 4000,
  onStart: (url: string) => {
    console.log(\`Server ready at \${url}\`)
    console.log(\`GraphQL endpoint: \${url}/graphql\`)
    console.log(\`GraphiQL playground: \${url}/graphiql\`)
    console.log(\`Health check: \${url}/health\`)
  },
})
`

/**
 * Generate Express server template
 */
const generateExpressServer = (ctx: TemplateContext): string => `/**
 * ${ctx.name} - GraphQL Server
 *
 * A GraphQL server built with Effect GQL and Express.
 */

import express from "express"
import { Effect, Layer } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder, query, mutation, makeGraphQLRouter } from "@effect-gql/core"
import { toMiddleware } from "@effect-gql/express"

// =============================================================================
// Domain Models
// =============================================================================

const User = S.Struct({
  id: S.String,
  name: S.String,
  email: S.String,
})

type User = S.Schema.Type<typeof User>

// =============================================================================
// In-Memory Data Store (replace with your database)
// =============================================================================

const users: User[] = [
  { id: "1", name: "Alice", email: "alice@example.com" },
  { id: "2", name: "Bob", email: "bob@example.com" },
]

// =============================================================================
// GraphQL Schema
// =============================================================================

const schema = GraphQLSchemaBuilder.empty
  .pipe(
    query("hello", {
      type: S.String,
      description: "Returns a friendly greeting",
      resolve: () => Effect.succeed("Hello from ${ctx.name}!"),
    }),

    query("user", {
      args: S.Struct({ id: S.String }),
      type: S.NullOr(User),
      description: "Get a user by ID",
      resolve: (args) => Effect.succeed(users.find((u) => u.id === args.id) ?? null),
    }),

    query("users", {
      type: S.Array(User),
      description: "Get all users",
      resolve: () => Effect.succeed(users),
    }),

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
// GraphQL Router
// =============================================================================

const graphqlRouter = makeGraphQLRouter(schema, Layer.empty, {
  path: "/graphql",
  graphiql: {
    path: "/graphiql",
    endpoint: "/graphql",
  },
})

// =============================================================================
// Express App
// =============================================================================

const app = express()
app.use(express.json())

// Health check
app.get("/health", (_, res) => {
  res.json({ status: "ok" })
})

// Mount GraphQL middleware
app.use(toMiddleware(graphqlRouter, Layer.empty))

// =============================================================================
// Server Startup
// =============================================================================

const port = process.env.PORT || 4000

app.listen(port, () => {
  console.log(\`Server ready at http://localhost:\${port}\`)
  console.log(\`GraphQL endpoint: http://localhost:\${port}/graphql\`)
  console.log(\`GraphiQL playground: http://localhost:\${port}/graphiql\`)
  console.log(\`Health check: http://localhost:\${port}/health\`)
})
`

/**
 * Generate Web handler template (for Cloudflare Workers, Deno, etc.)
 */
const generateWebHandler = (ctx: TemplateContext): string => `/**
 * ${ctx.name} - GraphQL Server
 *
 * A GraphQL server built with Effect GQL using Web standard APIs.
 * Compatible with Cloudflare Workers, Deno, and other WASM runtimes.
 */

import { Effect, Layer } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder, query, mutation, makeGraphQLRouter } from "@effect-gql/core"
import { toHandler } from "@effect-gql/web"

// =============================================================================
// Domain Models
// =============================================================================

const User = S.Struct({
  id: S.String,
  name: S.String,
  email: S.String,
})

type User = S.Schema.Type<typeof User>

// =============================================================================
// In-Memory Data Store (replace with your database)
// =============================================================================

const users: User[] = [
  { id: "1", name: "Alice", email: "alice@example.com" },
  { id: "2", name: "Bob", email: "bob@example.com" },
]

// =============================================================================
// GraphQL Schema
// =============================================================================

const schema = GraphQLSchemaBuilder.empty
  .pipe(
    query("hello", {
      type: S.String,
      description: "Returns a friendly greeting",
      resolve: () => Effect.succeed("Hello from ${ctx.name}!"),
    }),

    query("user", {
      args: S.Struct({ id: S.String }),
      type: S.NullOr(User),
      description: "Get a user by ID",
      resolve: (args) => Effect.succeed(users.find((u) => u.id === args.id) ?? null),
    }),

    query("users", {
      type: S.Array(User),
      description: "Get all users",
      resolve: () => Effect.succeed(users),
    }),

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
// GraphQL Router
// =============================================================================

const graphqlRouter = makeGraphQLRouter(schema, Layer.empty, {
  path: "/graphql",
  graphiql: {
    path: "/graphiql",
    endpoint: "/graphql",
  },
})

// =============================================================================
// Web Handler
// =============================================================================

const { handler } = toHandler(graphqlRouter, Layer.empty)

/**
 * Export for Cloudflare Workers
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // Health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      })
    }

    return handler(request)
  },
}

/**
 * For local development with Deno or other runtimes, you can use:
 *
 * Deno.serve((request) => {
 *   const url = new URL(request.url)
 *   if (url.pathname === "/health") {
 *     return new Response(JSON.stringify({ status: "ok" }), {
 *       headers: { "Content-Type": "application/json" },
 *     })
 *   }
 *   return handler(request)
 * })
 */
`

/**
 * Generate the server template based on server type
 */
export const generateServerTemplate = (ctx: TemplateContext): string => {
  switch (ctx.serverType) {
    case "node":
      return generateNodeServer(ctx)
    case "bun":
      return generateBunServer(ctx)
    case "express":
      return generateExpressServer(ctx)
    case "web":
      return generateWebHandler(ctx)
  }
}
