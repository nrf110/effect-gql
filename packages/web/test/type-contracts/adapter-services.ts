import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import type { GraphQLSchema } from "graphql"
import { serve as serveNode, type ServeOptions as NodeServeOptions } from "../../../node/src/serve"
import { serve as serveBun, type ServeOptions as BunServeOptions } from "../../../bun/src/serve"
import { toMiddleware } from "../../../express/src/middleware"
import { toHandler } from "../../src/handler"

class Construct extends Context.Service<Construct, { readonly value: string }>()(
  "contracts/Construct"
) {}
class RequestService extends Context.Service<RequestService, { readonly value: string }>()(
  "contracts/Request"
) {}
class GlobalService extends Context.Service<GlobalService, { readonly value: string }>()(
  "contracts/Global"
) {}
class Extra extends Context.Service<Extra, { readonly value: string }>()("contracts/Extra") {}

const construction = Layer.succeed(Construct, { value: "construct" })
const requests = Layer.succeed(RequestService, { value: "request" })
const globals = Layer.succeed(GlobalService, { value: "global" })
const extra = Layer.succeed(Extra, { value: "extra" })
const routes = Layer.unwrap(
  Effect.gen(function* () {
    const built = yield* Construct
    return HttpRouter.add(
      "GET",
      "/",
      Effect.map(RequestService, (request) =>
        HttpServerResponse.text(`${built.value}:${request.value}`)
      )
    )
  })
)
const globalRoutes = Layer.merge(
  routes,
  HttpRouter.middleware(
    (effect) =>
      Effect.flatMap(GlobalService, (global) =>
        Effect.map(effect, HttpServerResponse.setHeader("x-global", global.value))
      ),
    { global: true }
  )
)

// These functions are compile-only consumers: native serve calls must not start servers here.
export const inlineLayers = () => {
  serveNode(routes, Layer.merge(construction, requests))
  serveBun(routes, Layer.merge(construction, requests))
  toHandler(routes, Layer.merge(construction, requests))
  toMiddleware(routes, Layer.merge(construction, requests))

  serveNode(globalRoutes, Layer.mergeAll(construction, requests, globals, extra))
  serveBun(globalRoutes, Layer.mergeAll(construction, requests, globals, extra))

  const serviceFree = HttpRouter.add("GET", "/public", HttpServerResponse.text("public"))
  serveNode(serviceFree, Layer.merge(construction, extra))
  serveBun(serviceFree, Layer.merge(construction, extra))
  toHandler(serviceFree, Layer.merge(construction, extra))
  toMiddleware(serviceFree, Layer.merge(construction, extra))
  toHandler(globalRoutes, Layer.mergeAll(construction, requests, globals, extra))
  toMiddleware(globalRoutes, Layer.mergeAll(construction, requests, globals, extra))
}

export const missingServices = () => {
  // @ts-expect-error construction requires Construct
  serveNode(routes, requests)
  // @ts-expect-error construction requires Construct
  serveBun(routes, requests)
  // @ts-expect-error construction requires Construct
  toHandler(routes, requests)
  // @ts-expect-error construction requires Construct
  toMiddleware(routes, requests)

  // @ts-expect-error request dispatch requires RequestService
  serveNode(routes, construction)
  // @ts-expect-error request dispatch requires RequestService
  serveBun(routes, construction)
  // @ts-expect-error request dispatch requires RequestService
  toHandler(routes, construction)
  // @ts-expect-error request dispatch requires RequestService
  toMiddleware(routes, construction)

  // @ts-expect-error global middleware requires GlobalService
  serveNode(globalRoutes, Layer.merge(construction, requests))
  // @ts-expect-error global middleware requires GlobalService
  serveBun(globalRoutes, Layer.merge(construction, requests))
  // @ts-expect-error global middleware requires GlobalService
  toHandler(globalRoutes, Layer.merge(construction, requests))
  // @ts-expect-error global middleware requires GlobalService
  toMiddleware(globalRoutes, Layer.merge(construction, requests))
}

export const fallibleLayers = (schema: GraphQLSchema) => {
  const fallible = Layer.effect(
    Construct,
    Effect.try(() => ({ value: "construct" }))
  )
  serveNode(routes, Layer.merge(fallible, requests))
  serveBun(routes, Layer.merge(fallible, requests))
  toHandler(routes, Layer.merge(fallible, requests))
  toMiddleware(routes, Layer.merge(fallible, requests))
  serveNode(routes, Layer.merge(fallible, requests), { subscriptions: { schema } })
  serveBun(routes, Layer.merge(fallible, requests), { subscriptions: { schema } })

  const fallibleRoutes = Layer.merge(routes, Layer.effectDiscard(Effect.fail("router unavailable")))
  serveNode(fallibleRoutes, Layer.merge(fallible, requests))
  serveBun(fallibleRoutes, Layer.merge(fallible, requests))
  toHandler(fallibleRoutes, Layer.merge(fallible, requests))
  toMiddleware(fallibleRoutes, Layer.merge(fallible, requests))
}

export const requestErrorMarkers = () => {
  const failedRequests = Layer.merge(
    HttpRouter.add("GET", "/failure", Effect.fail(HttpServerResponse.empty({ status: 400 }))),
    HttpRouter.middleware(
      (effect) => Effect.andThen(Effect.fail(HttpServerResponse.empty({ status: 403 })), effect),
      { global: true }
    )
  )
  serveNode(failedRequests, Layer.empty)
  serveBun(failedRequests, Layer.empty)
  toHandler(failedRequests, Layer.empty)
  toMiddleware(failedRequests, Layer.empty)
}

export const missingLayerInputs = () => {
  const dependent = Layer.effect(
    Construct,
    Effect.map(Extra, ({ value }) => ({ value }))
  )
  // @ts-expect-error the supplied layer still needs Extra
  serveNode(routes, Layer.merge(dependent, requests))
  // @ts-expect-error the supplied layer still needs Extra
  serveBun(routes, Layer.merge(dependent, requests))
  // @ts-expect-error the supplied layer still needs Extra
  toHandler(routes, Layer.merge(dependent, requests))
  // @ts-expect-error the supplied layer still needs Extra
  toMiddleware(routes, Layer.merge(dependent, requests))
}

export const subscriptionServices = (schema: GraphQLSchema) => {
  const options: NodeServeOptions<Extra> = {
    subscriptions: {
      schema,
      onConnect: () => Effect.map(Extra, ({ value }) => ({ value })),
      onSubscribe: ({ services }) => Effect.logInfo(Context.get(services, Extra).value),
    },
  }
  const bunOptions: BunServeOptions<Extra> = options
  serveNode(routes, Layer.mergeAll(construction, requests, extra), options)
  serveBun(routes, Layer.mergeAll(construction, requests, extra), bunOptions)
  // @ts-expect-error subscription hook requires Extra
  serveNode(routes, Layer.merge(construction, requests), options)
  // @ts-expect-error subscription hook requires Extra
  serveBun(routes, Layer.merge(construction, requests), bunOptions)
}

export const genericWrappers = <E, R, RE>(
  router: Layer.Layer<
    never,
    E,
    | HttpRouter.HttpRouter
    | R
    | HttpRouter.Request<"Requires", R>
    | HttpRouter.Request<"Error", unknown>
    | HttpRouter.Request<"GlobalRequires", R>
    | HttpRouter.Request<"GlobalError", unknown>
  >,
  layer: Layer.Layer<R, RE>,
  nodeOptions: NodeServeOptions<R>,
  bunOptions: BunServeOptions<R>
) => {
  serveNode(router, layer, nodeOptions)
  serveBun(router, layer, bunOptions)
  toHandler(router, layer)
  toMiddleware(router, layer)
}
