import { Effect, Layer } from "effect"
import { HttpApp, HttpRouter, HttpServer } from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { createServer, Server } from "node:http"
import type { GraphQLSchema } from "graphql"
import type { GraphQLWSOptions } from "@effect-gql/core"

/**
 * Configuration for WebSocket subscriptions
 */
export interface SubscriptionsConfig<R> extends GraphQLWSOptions<R> {
  /**
   * The GraphQL schema (required for subscriptions).
   * Must be the same schema used to create the router.
   */
  readonly schema: GraphQLSchema
  /**
   * Path for WebSocket connections.
   * @default "/graphql"
   */
  readonly path?: string
}

/**
 * Options for the Node.js GraphQL server
 */
export interface ServeOptions<R = never> {
  /** Port to listen on (default: 4000) */
  readonly port?: number
  /** Hostname to bind to (default: "0.0.0.0") */
  readonly host?: string
  /** Callback when server starts */
  readonly onStart?: (url: string) => void
  /**
   * Enable WebSocket subscriptions.
   * When provided, the server will handle WebSocket upgrade requests
   * for GraphQL subscriptions using the graphql-ws protocol.
   */
  readonly subscriptions?: SubscriptionsConfig<R>
}

/**
 * Start a Node.js HTTP server with the given router.
 *
 * This is the main entry point for running a GraphQL server on Node.js.
 * It handles all the Effect runtime setup and server lifecycle.
 *
 * @param router - The HttpRouter to serve (typically from makeGraphQLRouter or toRouter)
 * @param layer - Layer providing the router's service dependencies
 * @param options - Server configuration options
 *
 * @example
 * ```typescript
 * import { makeGraphQLRouter } from "@effect-gql/core"
 * import { serve } from "@effect-gql/node"
 *
 * const schema = GraphQLSchemaBuilder.empty
 *   .query("hello", { type: S.String, resolve: () => Effect.succeed("world") })
 *   .buildSchema()
 *
 * const router = makeGraphQLRouter(schema, Layer.empty, { graphiql: true })
 *
 * // Without subscriptions
 * serve(router, serviceLayer, {
 *   port: 4000,
 *   onStart: (url) => console.log(`Server running at ${url}`)
 * })
 *
 * // With subscriptions
 * serve(router, serviceLayer, {
 *   port: 4000,
 *   subscriptions: { schema },
 *   onStart: (url) => console.log(`Server running at ${url}`)
 * })
 * ```
 */
export const serve = <E, R, RE>(
  router: HttpRouter.HttpRouter<E, R>,
  layer: Layer.Layer<R, RE>,
  options: ServeOptions<R> = {}
): void => {
  const { port = 4000, host = "0.0.0.0", onStart, subscriptions } = options

  if (subscriptions) {
    // With WebSocket subscriptions - we need to manage the HTTP server ourselves
    serveWithSubscriptions(router, layer, port, host, subscriptions, onStart)
  } else {
    // Without subscriptions - use the standard Effect approach
    const app = router.pipe(
      Effect.catchAllCause((cause) => Effect.die(cause)),
      HttpServer.serve()
    )

    const serverLayer = NodeHttpServer.layer(() => createServer(), { port })
    const fullLayer = Layer.merge(serverLayer, layer)

    if (onStart) {
      onStart(`http://${host === "0.0.0.0" ? "localhost" : host}:${port}`)
    }

    NodeRuntime.runMain(
      Layer.launch(Layer.provide(app, fullLayer))
    )
  }
}

/**
 * Internal implementation for serving with WebSocket subscriptions.
 * Uses a custom HTTP server setup to enable WebSocket upgrade handling.
 */
function serveWithSubscriptions<E, R, RE>(
  router: HttpRouter.HttpRouter<E, R>,
  layer: Layer.Layer<R, RE>,
  port: number,
  host: string,
  subscriptions: SubscriptionsConfig<R>,
  onStart?: (url: string) => void
): void {
  // Dynamically import ws module to keep it optional
  const importWs = Effect.tryPromise({
    try: () => import("./ws"),
    catch: (error) => error as Error
  })

  Effect.runPromise(
    importWs.pipe(
      Effect.catchAll((error) =>
        Effect.logError("Failed to load WebSocket support", error).pipe(
          Effect.andThen(Effect.logError("Make sure 'ws' package is installed: npm install ws")),
          Effect.andThen(Effect.sync(() => process.exit(1))),
          Effect.andThen(Effect.fail(error))
        )
      )
    )
  ).then(({ createGraphQLWSServer }) => {
    // Create the web handler from the Effect router
    const { handler } = HttpApp.toWebHandlerLayer(router, layer)

    // Create the HTTP server
    const httpServer = createServer(async (req, res) => {
      try {
        // Collect request body
        const chunks: Buffer[] = []
        for await (const chunk of req) {
          chunks.push(chunk as Buffer)
        }
        const body = Buffer.concat(chunks).toString()

        // Convert Node.js request to web standard Request
        // Use URL constructor for safe URL parsing (avoids injection via req.url)
        const baseUrl = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`
        const url = new URL(req.url || "/", baseUrl).href
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

    // Create WebSocket server for subscriptions
    const { handleUpgrade, close: closeWS } = createGraphQLWSServer(
      subscriptions.schema,
      layer as Layer.Layer<R>,
      {
        path: subscriptions.path,
        complexity: subscriptions.complexity,
        fieldComplexities: subscriptions.fieldComplexities,
        onConnect: subscriptions.onConnect,
        onDisconnect: subscriptions.onDisconnect,
        onSubscribe: subscriptions.onSubscribe,
        onComplete: subscriptions.onComplete,
        onError: subscriptions.onError,
      }
    )

    // Attach WebSocket upgrade handler
    httpServer.on("upgrade", (request, socket, head) => {
      handleUpgrade(request, socket, head)
    })

    // Handle shutdown
    process.on("SIGINT", async () => {
      await closeWS()
      httpServer.close()
      process.exit(0)
    })

    process.on("SIGTERM", async () => {
      await closeWS()
      httpServer.close()
      process.exit(0)
    })

    // Start listening
    httpServer.listen(port, host, () => {
      if (onStart) {
        onStart(`http://${host === "0.0.0.0" ? "localhost" : host}:${port}`)
      }
    })
  })
}
