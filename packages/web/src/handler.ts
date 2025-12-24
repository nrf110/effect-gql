import { Context, Layer } from "effect"
import { HttpApp, HttpRouter } from "@effect/platform"

/**
 * Result of creating a web handler
 */
export interface WebHandler {
  /**
   * Handle a web standard Request and return a Response.
   * This is the main entry point for Cloudflare Workers, Deno, and other WASM runtimes.
   */
  readonly handler: (request: Request, context?: Context.Context<never>) => Promise<Response>

  /**
   * Dispose of the handler and clean up resources.
   * Call this when shutting down the worker.
   */
  readonly dispose: () => Promise<void>
}

/**
 * Create a web standard Request/Response handler from an HttpRouter.
 *
 * This is designed for Cloudflare Workers, Deno, and other WASM-based runtimes
 * that use the Web standard fetch API.
 *
 * @param router - The HttpRouter to handle (typically from makeGraphQLRouter or toRouter)
 * @param layer - Layer providing any services required by the router
 * @returns A handler object with handler() and dispose() methods
 *
 * @example Cloudflare Workers
 * ```typescript
 * import { makeGraphQLRouter } from "@effect-gql/core"
 * import { toHandler } from "@effect-gql/web"
 * import { Layer } from "effect"
 *
 * const router = makeGraphQLRouter(schema, Layer.empty, { graphiql: true })
 * const { handler } = toHandler(router, Layer.empty)
 *
 * export default {
 *   async fetch(request: Request) {
 *     return await handler(request)
 *   }
 * }
 * ```
 *
 * @example Deno
 * ```typescript
 * import { makeGraphQLRouter } from "@effect-gql/core"
 * import { toHandler } from "@effect-gql/web"
 *
 * const router = makeGraphQLRouter(schema, Layer.empty, { graphiql: true })
 * const { handler } = toHandler(router, Layer.empty)
 *
 * Deno.serve((request) => handler(request))
 * ```
 */
export const toHandler = <E, R, RE>(
  router: HttpRouter.HttpRouter<E, R>,
  layer: Layer.Layer<R, RE>
): WebHandler => {
  return HttpApp.toWebHandlerLayer(router, layer)
}
