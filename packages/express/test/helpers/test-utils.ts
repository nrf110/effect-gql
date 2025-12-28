import { Effect, Layer, Stream } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder, makeGraphQLRouter } from "@effect-gql/core"
import { DirectiveLocation, GraphQLSchema } from "graphql"
import express, { Express } from "express"
import { createServer, Server } from "node:http"
import { toMiddleware } from "../../src/middleware"
import { attachWebSocket } from "../../src/ws"
import { createClient } from "graphql-ws"
import { WebSocket } from "ws"

/**
 * Create a test schema with various GraphQL features:
 * - Simple queries
 * - Queries with arguments
 * - Mutations
 * - Nested object types with computed fields
 * - Subscriptions
 * - Directives
 */
export const createTestSchema = () => {
  const UserSchema = S.Struct({
    id: S.String,
    name: S.String,
  })

  const PostSchema = S.Struct({
    id: S.String,
    title: S.String,
    authorId: S.String,
  })

  return (
    GraphQLSchemaBuilder.empty
      // Simple query
      .query("hello", {
        type: S.String,
        resolve: () => Effect.succeed("world"),
      })
      // Query with arguments
      .query("echo", {
        type: S.String,
        args: S.Struct({ message: S.String }),
        resolve: (args) => Effect.succeed(args.message),
      })
      // Mutation
      .mutation("createUser", {
        type: UserSchema,
        args: S.Struct({ name: S.String }),
        resolve: (args) => Effect.succeed({ id: "1", name: args.name }),
      })
      // Object types for nested queries
      .objectType({ name: "User", schema: UserSchema })
      .objectType({ name: "Post", schema: PostSchema })
      // Computed field on User type
      .field("User", "posts", {
        type: S.Array(PostSchema),
        resolve: (user: { id: string; name: string }) =>
          Effect.succeed([
            { id: "1", title: "First Post", authorId: user.id },
            { id: "2", title: "Second Post", authorId: user.id },
          ]),
      })
      // Query that returns a User (for nested query testing)
      .query("user", {
        type: UserSchema,
        args: S.Struct({ id: S.String }),
        resolve: (args) => Effect.succeed({ id: args.id, name: "Test User" }),
      })
      // Subscription
      .subscription("countdown", {
        type: S.Int,
        args: S.Struct({ from: S.Int }),
        subscribe: (args) =>
          Effect.succeed(
            Stream.fromIterable(Array.from({ length: args.from }, (_, i) => args.from - i))
          ),
      })
      // Directive
      .directive({
        name: "upper",
        description: "Transforms string result to uppercase",
        locations: [DirectiveLocation.FIELD_DEFINITION],
        apply:
          () =>
          <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.map(effect, (v) => (typeof v === "string" ? v.toUpperCase() : v) as A),
      })
      // Query that uses the directive
      .query("greeting", {
        type: S.String,
        directives: [{ name: "upper" }],
        resolve: () => Effect.succeed("hello"),
      })
      .buildSchema()
  )
}

/**
 * Start an Express test server with the GraphQL middleware.
 * Returns the port, app, and a cleanup function.
 */
export const startTestServer = async (
  port: number = 0
): Promise<{ port: number; app: Express; stop: () => Promise<void> }> => {
  const app = express()
  app.use(express.json())

  const schema = createTestSchema()
  const router = makeGraphQLRouter(schema, Layer.empty, { graphiql: true })
  app.use(toMiddleware(router, Layer.empty))

  return new Promise((resolve) => {
    const server: Server = app.listen(port, () => {
      const addr = server.address() as { port: number }
      resolve({
        port: addr.port,
        app,
        stop: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => {
              if (err) rej(err)
              else res()
            })
          }),
      })
    })
  })
}

/**
 * Execute a GraphQL query against a running server.
 */
export const executeQuery = async (
  port: number,
  query: string,
  variables?: Record<string, unknown>
): Promise<{ data?: unknown; errors?: unknown[] }> => {
  const response = await fetch(`http://localhost:${port}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  })
  return response.json() as Promise<{ data?: unknown; errors?: unknown[] }>
}

/**
 * Fetch the GraphiQL page.
 */
export const getGraphiQL = async (port: number): Promise<{ status: number; body: string }> => {
  const response = await fetch(`http://localhost:${port}/graphiql`, {
    method: "GET",
  })
  return {
    status: response.status,
    body: await response.text(),
  }
}

/**
 * Start an Express test server with WebSocket subscription support.
 * Returns the port, app, schema, and a cleanup function.
 */
export const startTestServerWithWS = async (
  port: number = 0
): Promise<{
  port: number
  app: Express
  schema: GraphQLSchema
  stop: () => Promise<void>
}> => {
  const app = express()
  app.use(express.json())

  const schema = createTestSchema()
  const router = makeGraphQLRouter(schema, Layer.empty, { graphiql: true })
  app.use(toMiddleware(router, Layer.empty))

  const server = createServer(app)

  // Attach WebSocket support
  const ws = attachWebSocket(server, schema, Layer.empty, {
    path: "/graphql",
  })

  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address() as { port: number }
      resolve({
        port: addr.port,
        app,
        schema,
        stop: async () => {
          await ws.close()
          return new Promise<void>((res, rej) => {
            server.close((err) => {
              if (err) rej(err)
              else res()
            })
          })
        },
      })
    })
  })
}

/**
 * Execute a GraphQL subscription and collect all results.
 */
export const executeSubscription = async <T = unknown>(
  port: number,
  query: string,
  variables?: Record<string, unknown>
): Promise<T[]> => {
  const client = createClient({
    url: `ws://localhost:${port}/graphql`,
    webSocketImpl: WebSocket,
  })

  const results: T[] = []

  return new Promise((resolve, reject) => {
    client.subscribe<T>(
      { query, variables },
      {
        next: (data) => {
          if (data.data) {
            results.push(data.data)
          }
        },
        error: (error) => {
          client.dispose()
          reject(error)
        },
        complete: () => {
          client.dispose()
          resolve(results)
        },
      }
    )
  })
}
