import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import type { Request, Response, NextFunction, RequestHandler } from "express"
import { toWebHeaders } from "./http-utils"
import { Readable } from "node:stream"
import { finished } from "node:stream/promises"

// Pump directly instead of piping into ServerResponse: a source error must not
// destroy the socket before Express can send its error response.
const writeBody = async (body: ReadableStream<Uint8Array>, res: Response): Promise<void> => {
  const reader = body.getReader()
  let done = false
  let destinationError: Error | undefined
  let resume: (() => void) | undefined
  let cancellation: Promise<void> | undefined
  const cancel = () => {
    cancellation ??= reader.cancel()
    // The pump awaits this promise during cleanup; observe rejection immediately
    // as cancellation can happen while a read or drain is still pending.
    void cancellation.catch(() => {})
    resume?.()
  }
  const onError = (error: Error) => {
    destinationError = error
    cancel()
  }
  res.once("close", cancel)
  res.once("error", onError)
  try {
    while (!res.destroyed) {
      const chunk = await reader.read()
      if (destinationError) throw destinationError
      if (res.destroyed) return
      if (chunk.done) {
        done = true
        res.end()
        await finished(res, { cleanup: true })
        return
      }
      if (!res.write(chunk.value)) {
        await new Promise<void>((resolve) => {
          resume = resolve
          res.once("drain", resolve)
        })
        if (resume) res.off("drain", resume)
        resume = undefined
        if (destinationError) throw destinationError
      }
    }
  } finally {
    res.off("close", cancel)
    res.off("error", onError)
    if (resume) res.off("drain", resume)
    try {
      if (!done) {
        cancel()
        await cancellation
      }
    } finally {
      reader.releaseLock()
    }
  }
}

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
    | HttpRouter.HttpRouter
    | HttpRouter.Request<"Requires", R>
    | HttpRouter.Request<"Error", unknown>
    | HttpRouter.Request<"GlobalRequires", R>
    | HttpRouter.Request<"GlobalError", unknown>
  >,
  layer: Layer.Layer<R, RE>
): RequestHandler & { readonly dispose: () => Promise<void> } => {
  // The merged layer supplies all R services; no per-request context remains.
  const { handler, dispose } = HttpRouter.toWebHandler<
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

  const middleware: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
    const abort = new AbortController()
    const onClose = () => {
      if (!res.writableFinished) abort.abort()
    }
    res.once("close", onClose)
    try {
      // Convert Express request to web standard Request
      // Use URL constructor for safe URL parsing (avoids Host header injection)
      const baseUrl = `${req.protocol}://${req.hostname}`
      const url = new URL(req.originalUrl || "/", baseUrl).href
      const headers = toWebHeaders(req.headers)

      // JSON parsers also produce strings: retain their JSON quotes, while
      // forwarding text-parser strings and raw buffers as already-decoded bytes.
      const hasBody = !["GET", "HEAD"].includes(req.method)
      const webRequest = new Request(url, {
        method: req.method,
        headers,
        body: !hasBody
          ? undefined
          : req.body === undefined
            ? (Readable.toWeb(req) as ReadableStream<Uint8Array>)
            : Buffer.isBuffer(req.body) ||
                (typeof req.body === "string" &&
                  !req.is(["application/json", "application/*+json"]))
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
      if (webResponse.body) {
        await writeBody(webResponse.body, res)
      } else {
        res.end()
      }
    } catch (error) {
      if (!res.destroyed) next(error)
    } finally {
      res.off("close", onClose)
    }
  }
  return Object.assign(middleware, { dispose })
}
