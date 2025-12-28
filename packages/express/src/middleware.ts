import { Layer } from "effect"
import { HttpApp, HttpRouter } from "@effect/platform"
import type { Request, Response, NextFunction, RequestHandler } from "express"
import { toWebHeaders } from "./http-utils"

/**
 * Convert an HttpRouter to Express middleware.
 *
 * This creates Express-compatible middleware that can be mounted on any Express app.
 * The middleware converts Express requests to web standard Requests, processes them
 * through the Effect router, and writes the response back to Express.
 *
 * @param router - The HttpRouter to convert (typically from makeGraphQLRouter or toRouter)
 * @param layer - Layer providing any services required by the router
 * @returns Express middleware function
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
  router: HttpRouter.HttpRouter<E, R>,
  layer: Layer.Layer<R, RE>
): RequestHandler => {
  const { handler } = HttpApp.toWebHandlerLayer(router, layer)

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Convert Express request to web standard Request
      // Use URL constructor for safe URL parsing (avoids Host header injection)
      const baseUrl = `${req.protocol}://${req.hostname}`
      const url = new URL(req.originalUrl || "/", baseUrl).href
      const headers = toWebHeaders(req.headers)

      const webRequest = new Request(url, {
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body),
      })

      // Process through Effect handler
      const webResponse = await handler(webRequest)

      // Write response back to Express
      res.status(webResponse.status)
      webResponse.headers.forEach((value, key) => {
        res.setHeader(key, value)
      })
      const body = await webResponse.text()
      res.send(body)
    } catch (error) {
      next(error)
    }
  }
}
