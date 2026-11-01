import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
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
 * Requires Bun 1.4.2 or later; older runtimes are rejected before startup.
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
  router: Layer.Layer<
    never,
    E,
    | HttpRouter.HttpRouter
    | HttpRouter.Request<"Requires", R>
    | HttpRouter.Request<"Error", unknown>
    | HttpRouter.Request<"GlobalRequires", R>
    | HttpRouter.Request<"GlobalError", unknown>
  >,
  layer: Layer.Layer<R, RE>,
  options: ServeOptions<R> = {}
): void => {
  if (!Bun.semver.satisfies(Bun.version, ">=1.4.2")) {
    throw new Error(
      `@effect-gql/bun requires Bun >=1.4.2; found ${Bun.version}. Upgrade Bun to ensure WebSocket shutdown completes.`
    )
  }

  const { port = 4000, host = "0.0.0.0", onStart, subscriptions } = options
  const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`

  if (!subscriptions) {
    const app = HttpRouter.serve(router).pipe(Layer.provide(layer))
    const serverLayer = BunHttpServer.layer({ port, hostname: host })
    if (onStart) onStart(url)
    BunRuntime.runMain(Layer.launch(Layer.provide(app, serverLayer)))
    return
  }

  const program = Effect.gen(function* () {
    const { createBunWSHandlers } = yield* Effect.tryPromise(() => import("./ws"))
    const app = yield* Effect.acquireRelease(
      // The merged layer supplies all R services; no per-request context remains.
      Effect.sync(() =>
        HttpRouter.toWebHandler<
          R,
          E | RE,
          | HttpRouter.HttpRouter
          | HttpRouter.Request<"Requires", R>
          | HttpRouter.Request<"Error", unknown>
          | HttpRouter.Request<"GlobalRequires", R>
          | HttpRouter.Request<"GlobalError", unknown>,
          never,
          never
        >(Layer.merge(router, layer))
      ),
      ({ dispose }) => Effect.promise(dispose)
    )
    const { upgrade, websocket } = yield* Effect.acquireRelease(
      Effect.sync(() => createBunWSHandlers(subscriptions.schema, layer, subscriptions)),
      ({ close }) => Effect.promise(close)
    )
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port,
          hostname: host,
          fetch: (request, server) => (upgrade(request, server) ? undefined : app.handler(request)),
          websocket,
        })
      ),
      (server) =>
        Effect.promise(async () => {
          await server.stop(true)
        })
    )
    if (onStart) yield* Effect.sync(() => onStart(url))
    yield* Effect.never
  }).pipe(Effect.scoped)
  BunRuntime.runMain(program)
}
