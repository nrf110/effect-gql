import { Effect, Layer, Stream } from "effect"
import * as S from "effect/Schema"
import { HttpApp } from "@effect/platform"
import { GraphQLSchemaBuilder, makeGraphQLRouter } from "@effect-graphql/core"
import { DirectiveLocation, GraphQLSchema } from "graphql"
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http"
import { createClient, Client } from "graphql-ws"
import WebSocket from "ws"
import { createGraphQLWSServer } from "../../src/ws"

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

  return GraphQLSchemaBuilder.empty
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
          Stream.fromIterable(
            Array.from({ length: args.from }, (_, i) => args.from - i)
          )
        ),
    })
    // Directive
    .directive({
      name: "upper",
      description: "Transforms string result to uppercase",
      locations: [DirectiveLocation.FIELD_DEFINITION],
      apply: () => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.map(effect, (v) =>
          (typeof v === "string" ? v.toUpperCase() : v) as A
        ),
    })
    // Query that uses the directive
    .query("greeting", {
      type: S.String,
      directives: [{ name: "upper" }],
      resolve: () => Effect.succeed("hello"),
    })
    .buildSchema()
}

/**
 * Start a test server that serves the GraphQL endpoint.
 * Returns the port and a cleanup function.
 */
export const startTestServer = async (port: number = 0) => {
  const schema = createTestSchema()
  const router = makeGraphQLRouter(schema, Layer.empty, { graphiql: true })
  const { handler } = HttpApp.toWebHandlerLayer(router, Layer.empty)

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      try {
        // Collect request body
        const chunks: Buffer[] = []
        for await (const chunk of req) {
          chunks.push(chunk as Buffer)
        }
        const body = Buffer.concat(chunks).toString()

        // Convert Node.js request to web standard Request
        const url = `http://localhost${req.url}`
        const headers = new Headers()
        for (const [key, value] of Object.entries(req.headers)) {
          if (value) {
            if (Array.isArray(value)) {
              value.forEach((v) => headers.append(key, v))
            } else {
              headers.set(key, value)
            }
          }
        }

        const webRequest = new Request(url, {
          method: req.method,
          headers,
          body: ["GET", "HEAD"].includes(req.method!) ? undefined : body,
        })

        // Process through Effect handler
        const webResponse = await handler(webRequest)

        // Write response
        res.statusCode = webResponse.status
        webResponse.headers.forEach((value, key) => {
          res.setHeader(key, value)
        })
        const responseBody = await webResponse.text()
        res.end(responseBody)
      } catch (error) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String(error) }))
      }
    }
  )

  return new Promise<{ port: number; stop: () => Promise<void> }>((resolve) => {
    server.listen(port, () => {
      const addr = server.address() as { port: number }
      resolve({
        port: addr.port,
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
export const getGraphiQL = async (
  port: number
): Promise<{ status: number; body: string }> => {
  const response = await fetch(`http://localhost:${port}/graphiql`, {
    method: "GET",
  })
  return {
    status: response.status,
    body: await response.text(),
  }
}

/**
 * Start a test server with WebSocket subscription support.
 * Returns the port, schema, and cleanup functions.
 */
export const startTestServerWithWS = async (port: number = 0) => {
  const schema = createTestSchema()
  const router = makeGraphQLRouter(schema, Layer.empty, { graphiql: true })
  const { handler } = HttpApp.toWebHandlerLayer(router, Layer.empty)

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      try {
        // Collect request body
        const chunks: Buffer[] = []
        for await (const chunk of req) {
          chunks.push(chunk as Buffer)
        }
        const body = Buffer.concat(chunks).toString()

        // Convert Node.js request to web standard Request
        const url = `http://localhost${req.url}`
        const headers = new Headers()
        for (const [key, value] of Object.entries(req.headers)) {
          if (value) {
            if (Array.isArray(value)) {
              value.forEach((v) => headers.append(key, v))
            } else {
              headers.set(key, value)
            }
          }
        }

        const webRequest = new Request(url, {
          method: req.method,
          headers,
          body: ["GET", "HEAD"].includes(req.method!) ? undefined : body,
        })

        // Process through Effect handler
        const webResponse = await handler(webRequest)

        // Write response
        res.statusCode = webResponse.status
        webResponse.headers.forEach((value, key) => {
          res.setHeader(key, value)
        })
        const responseBody = await webResponse.text()
        res.end(responseBody)
      } catch (error) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String(error) }))
      }
    }
  )

  // Create WebSocket server for subscriptions
  const { handleUpgrade, close: closeWS } = createGraphQLWSServer(
    schema,
    Layer.empty,
    { path: "/graphql" }
  )

  // Attach WebSocket upgrade handler
  server.on("upgrade", (request, socket, head) => {
    handleUpgrade(request, socket, head)
  })

  return new Promise<{
    port: number
    schema: GraphQLSchema
    stop: () => Promise<void>
  }>((resolve) => {
    server.listen(port, () => {
      const addr = server.address() as { port: number }
      resolve({
        port: addr.port,
        schema,
        stop: async () => {
          await closeWS()
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
