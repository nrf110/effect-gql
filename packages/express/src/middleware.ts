import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import type { Request, Response, NextFunction, RequestHandler } from "express"
import { toWebHeaders } from "./http-utils"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"

/**
 * Convert an HttpRouter to Express middleware.
 *
 * This creates Express-compatible middleware that can be mounted on any Express app.
 * The middleware converts Express requests to web standard Requests, processes them
 * through the Effect router, and writes the response back to Express.
 *
 * @param router - The HttpRouter to convert (typically from makeGraphQLRouter or toRouter)
 * @param layer - Layer providing any services required by the router
 * @returns Express middleware with dispose() for releasing resources on server shutdown
 *
 * @example
 * ```typescript
 * import express from "express"
 * import { makeGraphQLRouter } from "@effect-gql/core"
 * import { toMiddleware } from "@effect-gql/express"
 * import { Layer } from "effect"
 *
 * const router = makeGraphQLRouter(schema, Layer.empty, { graphiql: true })
 *
 * const app = express()
 * app.use(toMiddleware(router, Layer.empty))
 * app.listen(4000, () => console.log("Server running on http://localhost:4000"))
 * ```
 */
export const toMiddleware = <E, R, RE>(
  router: Layer.Layer<
    never,
    E,
    HttpRouter.HttpRouter | HttpRouter.Request<"Requires", R> | HttpRouter.Request<"Error", unknown>
  >,
  layer: Layer.Layer<R, RE>
): RequestHandler & { readonly dispose: () => Promise<void> } => {
  // The merged layer supplies all R services; no per-request context remains.
  const { handler, dispose } = HttpRouter.toWebHandler<
    R,
    E | RE,
    | HttpRouter.HttpRouter
    | HttpRouter.Request<"Requires", R>
    | HttpRouter.Request<"Error", unknown>,
    never,
    never
  >(Layer.merge(router, layer))

  const middleware: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Convert Express request to web standard Request
      // Use URL constructor for safe URL parsing (avoids Host header injection)
      const baseUrl = `${req.protocol}://${req.hostname}`
      const url = new URL(req.originalUrl || "/", baseUrl).href
      const headers = toWebHeaders(req.headers)

      const hasBody = !["GET", "HEAD"].includes(req.method)
      const abort = new AbortController()
      const onClose = () => {
        if (!res.writableFinished) abort.abort()
      }
      res.once("close", onClose)
      const webRequest = new Request(url, {
        method: req.method,
        headers,
        body: !hasBody
          ? undefined
          : req.body === undefined
            ? (Readable.toWeb(req) as ReadableStream<Uint8Array>)
            : Buffer.isBuffer(req.body) || typeof req.body === "string"
              ? req.body
              : JSON.stringify(req.body),
        signal: abort.signal,
        duplex: "half",
      } as RequestInit)

      // Process through Effect handler
      const webResponse = await handler(webRequest)

      // Write response back to Express
      res.status(webResponse.status)
      webResponse.headers.forEach((value, key) => {
        res.setHeader(key, value)
      })
      try {
        if (webResponse.body) {
          await pipeline(Readable.fromWeb(webResponse.body as NodeReadableStream), res)
        } else {
          res.end()
        }
      } finally {
        res.off("close", onClose)
      }
    } catch (error) {
      next(error)
    }
  }
  return Object.assign(middleware, { dispose })
}
