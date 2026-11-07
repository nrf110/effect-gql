import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { createServer } from "node:http"
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
  router: Layer.Layer<
    never,
    E,
    | HttpRouter.HttpRouter
    | NoInfer<R>
    | HttpRouter.Request<"Requires", NoInfer<R>>
    | HttpRouter.Request<"Error", unknown>
    | HttpRouter.Request<"GlobalRequires", NoInfer<R>>
    | HttpRouter.Request<"GlobalError", unknown>
  >,
  layer: Layer.Layer<R, RE>,
  options: ServeOptions<NoInfer<R>> = {}
): void => {
  const { port = 4000, host = "0.0.0.0", onStart, subscriptions } = options
  const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`
  // Resolve construction services before interpreting request requirement markers.
  const routes: Layer.Layer<
    R,
    E | RE,
    | HttpRouter.HttpRouter
    | HttpRouter.Request<"Requires", R>
    | HttpRouter.Request<"Error", unknown>
    | HttpRouter.Request<"GlobalRequires", R>
    | HttpRouter.Request<"GlobalError", unknown>
  > = Layer.provideMerge(router, layer)

  if (!subscriptions) {
    const app = HttpRouter.serve(routes).pipe(Layer.provide(layer))
    const serverLayer = NodeHttpServer.layer(() => createServer(), { port, host })
    if (onStart) onStart(url)
    NodeRuntime.runMain(Layer.launch(Layer.provide(app, serverLayer)))
    return
  }

  const program = Effect.gen(function* () {
    const { createGraphQLWSServer } = yield* Effect.tryPromise(() => import("./ws"))
    const scope = yield* Effect.scope
    const httpEffect = yield* HttpRouter.toHttpEffect(routes)
    const requestHandler = yield* NodeHttpServer.makeHandler(httpEffect, { scope })
    const server = createServer(requestHandler)
    yield* Effect.acquireRelease(
      Effect.callback<void, Error>((resume) => {
        const onError = (error: Error) => resume(Effect.fail(error))
        server.once("error", onError)
        server.listen(port, host, () => {
          server.off("error", onError)
          resume(Effect.void)
        })
      }),
      () =>
        Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()))
              // Scoped request fibers have already been interrupted and finalized.
              // Incomplete headers have no request fiber, so close their sockets too.
              server.closeAllConnections()
            })
        )
    )
    // Scope finalizers run in reverse order: close upgraded connections before HTTP.
    const ws = yield* Effect.acquireRelease(
      Effect.sync(() => createGraphQLWSServer(subscriptions.schema, layer, subscriptions)),
      (ws) => Effect.promise(() => ws.close())
    )
    server.on("upgrade", ws.handleUpgrade)
    if (onStart) yield* Effect.sync(() => onStart(url))
    yield* Effect.never
  }).pipe(Effect.provide(layer), Effect.provide(NodeHttpServer.layerHttpServices), Effect.scoped)
  NodeRuntime.runMain(program)
}
