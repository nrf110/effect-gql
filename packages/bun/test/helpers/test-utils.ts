import { Effect, Layer, Stream } from "effect"
import * as S from "effect/Schema"
import { HttpApp } from "@effect/platform"
import {
  GraphQLSchemaBuilder,
  makeGraphQLRouter,
  makeGraphQLWSHandler,
  type EffectWebSocket,
  WebSocketError,
  type CloseEvent,
} from "@effect-gql/core"
import { DirectiveLocation, GraphQLSchema } from "graphql"
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http"
import { createClient } from "graphql-ws"
import { WebSocket, WebSocketServer } from "ws"
import { Queue, Deferred, Fiber } from "effect"

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
 * Start a test server that serves the GraphQL endpoint.
 *
 * Note: This uses Node.js http server for testing purposes since vitest
 * runs on Node.js. For true Bun runtime testing, use `bun test` instead.
 *
 * Returns the port and a cleanup function.
 */
export const startTestServer = async (port: number = 0) => {
  const schema = createTestSchema()
  const router = makeGraphQLRouter(schema, Layer.empty, { graphiql: true })
  const { handler } = HttpApp.toWebHandlerLayer(router, Layer.empty)

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
  })

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
 * Convert a Node.js WebSocket to EffectWebSocket for testing.
 */
const toEffectWebSocket = (ws: WebSocket): EffectWebSocket => {
  const messagesEffect = Effect.gen(function* () {
    const queue = yield* Queue.unbounded<string>()
    const closed = yield* Deferred.make<CloseEvent, WebSocketError>()

    ws.on("message", (data) => {
      const message = data.toString()
      Effect.runPromise(Queue.offer(queue, message)).catch(() => {})
    })

    ws.on("error", (error) => {
      Effect.runPromise(Deferred.fail(closed, new WebSocketError({ cause: error }))).catch(() => {})
    })

    ws.on("close", (code, reason) => {
      Effect.runPromise(
        Queue.shutdown(queue).pipe(
          Effect.andThen(Deferred.succeed(closed, { code, reason: reason.toString() }))
        )
      ).catch(() => {})
    })

    return { queue, closed }
  })

  const messages: Stream.Stream<string, WebSocketError> = Stream.unwrap(
    messagesEffect.pipe(
      Effect.map(({ queue }) => Stream.fromQueue(queue).pipe(Stream.catchAll(() => Stream.empty)))
    )
  )

  return {
    protocol: ws.protocol || "graphql-transport-ws",
    send: (data: string) =>
      Effect.async<void, WebSocketError>((resume) => {
        ws.send(data, (error) => {
          if (error) {
            resume(Effect.fail(new WebSocketError({ cause: error })))
          } else {
            resume(Effect.succeed(undefined))
          }
        })
      }),
    close: (code?: number, reason?: string) =>
      Effect.sync(() => {
        ws.close(code ?? 1000, reason ?? "")
      }),
    messages,
    closed: Effect.async<CloseEvent, WebSocketError>((resume) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resume(Effect.succeed({ code: 1000, reason: "" }))
        return
      }
      const onClose = (code: number, reason: Buffer) => {
        cleanup()
        resume(Effect.succeed({ code, reason: reason.toString() }))
      }
      const onError = (error: Error) => {
        cleanup()
        resume(Effect.fail(new WebSocketError({ cause: error })))
      }
      const cleanup = () => {
        ws.removeListener("close", onClose)
        ws.removeListener("error", onError)
      }
      ws.on("close", onClose)
      ws.on("error", onError)
      return Effect.sync(cleanup)
    }),
  }
}

/**
 * Start a test server with WebSocket subscription support.
 *
 * Note: Uses Node.js WebSocket (ws) for testing since vitest runs on Node.
 */
export const startTestServerWithWS = async (port: number = 0) => {
  const schema = createTestSchema()
  const router = makeGraphQLRouter(schema, Layer.empty, { graphiql: true })
  const { handler } = HttpApp.toWebHandlerLayer(router, Layer.empty)

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(chunk as Buffer)
      }
      const body = Buffer.concat(chunks).toString()

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

      const webResponse = await handler(webRequest)
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
  })

  // Create WebSocket server
  const wss = new WebSocketServer({ noServer: true })
  const wsHandler = makeGraphQLWSHandler(schema, Layer.empty)

  wss.on("connection", (ws) => {
    const effectSocket = toEffectWebSocket(ws)
    Effect.runPromise(wsHandler(effectSocket)).catch((error) => {
      console.error("WebSocket handler error:", error)
    })
  })

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`)
    if (url.pathname !== "/graphql") {
      socket.destroy()
      return
    }

    const protocol = request.headers["sec-websocket-protocol"]
    if (!protocol?.includes("graphql-transport-ws")) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n")
      socket.destroy()
      return
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request)
    })
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
          for (const client of wss.clients) {
            client.close(1001, "Server shutting down")
          }
          wss.close()
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
