import { Effect, Layer } from "effect"
import { HttpApp, HttpRouter, HttpServer } from "@effect/platform"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
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
 * Options for the Bun GraphQL server
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
 * Start a Bun HTTP server with the given router.
 *
 * This is the main entry point for running a GraphQL server on Bun.
 * It handles all the Effect runtime setup and server lifecycle.
 *
 * @param router - The HttpRouter to serve (typically from makeGraphQLRouter or toRouter)
 * @param layer - Layer providing the router's service dependencies
 * @param options - Server configuration options
 *
 * @example
 * ```typescript
 * import { makeGraphQLRouter } from "@effect-gql/core"
 * import { serve } from "@effect-gql/bun"
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
    // With WebSocket subscriptions - use Bun.serve() directly
    serveWithSubscriptions(router, layer, port, host, subscriptions, onStart)
  } else {
    // Without subscriptions - use the standard Effect approach
    const app = router.pipe(
      Effect.catchAllCause((cause) => Effect.die(cause)),
      HttpServer.serve()
    )

    const serverLayer = BunHttpServer.layer({ port })
    const fullLayer = Layer.merge(serverLayer, layer)

    if (onStart) {
      onStart(`http://${host === "0.0.0.0" ? "localhost" : host}:${port}`)
    }

    BunRuntime.runMain(Layer.launch(Layer.provide(app, fullLayer)))
  }
}

/**
 * Internal implementation for serving with WebSocket subscriptions.
 * Uses Bun.serve() directly to enable WebSocket support.
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
    catch: (error) => error as Error,
  })

  Effect.runPromise(
    importWs.pipe(
      Effect.catchAll((error) =>
        Effect.logError("Failed to load WebSocket support", error).pipe(
          Effect.andThen(Effect.sync(() => process.exit(1))),
          Effect.andThen(Effect.fail(error))
        )
      )
    )
  ).then(({ createBunWSHandlers }) => {
    // Create the web handler from the Effect router
    const { handler } = HttpApp.toWebHandlerLayer(router, layer)

    // Create WebSocket handlers
    const { upgrade, websocket } = createBunWSHandlers(
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

    // Start Bun server with WebSocket support
    const server = Bun.serve({
      port,
      hostname: host,
      fetch: async (request, server) => {
        // Try WebSocket upgrade first
        if (upgrade(request, server)) {
          return new Response(null, { status: 101 })
        }

        // Handle HTTP requests
        return handler(request)
      },
      websocket,
    })

    if (onStart) {
      onStart(`http://${host === "0.0.0.0" ? "localhost" : host}:${port}`)
    }

    // Handle shutdown
    process.on("SIGINT", () => {
      server.stop()
      process.exit(0)
    })

    process.on("SIGTERM", () => {
      server.stop()
      process.exit(0)
    })
  })
}
