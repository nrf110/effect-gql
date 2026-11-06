import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import type { Request, Response, NextFunction, RequestHandler } from "express"
import { toWebHeaders } from "./http-utils"
import { finished } from "node:stream/promises"

interface RequestBody {
  readonly body: ReadableStream<Uint8Array>
  readonly drain: () => void
}

// Own the conversion so cancelling or abandoning the web body never destroys
// IncomingMessage (Readable.toWeb's cancellation would also close its socket).
const requestBody = (req: Request, abort: AbortController): RequestBody => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let attached = true
  let draining = false
  const detach = () => {
    attached = false
    req.off("data", onData)
    req.off("end", onEnd)
    req.off("error", onError)
    req.off("close", onClose)
  }
  const onData = (chunk: Buffer) => {
    req.pause()
    controller.enqueue(chunk)
  }
  const onEnd = () => {
    detach()
    controller.close()
  }
  const onError = (error: Error) => {
    detach()
    controller.error(error)
    abort.abort(error)
  }
  const onClose = () => onError(new Error("Request body closed before completion"))
  const drain = () => {
    if (attached) {
      detach()
      controller.close()
    }
    if (!draining && !req.destroyed && !req.readableEnded) {
      draining = true
      // Observe errors until draining ends, then remove every drain listener.
      void finished(req, { cleanup: true }).catch(() => {})
      req.resume()
    }
  }
  const body = new ReadableStream<Uint8Array>(
    {
      start(source) {
        controller = source
        req.pause()
        req.on("data", onData)
        req.once("end", onEnd)
        req.once("error", onError)
        req.once("close", onClose)
        if (req.readableEnded) onEnd()
        else if (req.destroyed) onClose()
      },
      pull() {
        req.resume()
      },
      cancel() {
        // A cancelled stream is already closed; just relinquish its source.
        if (attached) detach()
        drain()
      },
    },
    // Read only on demand: no abandoned queue retains upload chunks.
    { highWaterMark: 0 }
  )
  return { body, drain }
}

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

export interface ToMiddlewareOptions {
  /**
   * Serialization of already-parsed string bodies only. By default, strings
   * with JSON content types are JSON-encoded; other strings are forwarded raw.
   * Use "json" or "raw" to override this when a parser uses a custom content type.
   */
  readonly bodyEncoding?: "json" | "raw"
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
 * @param options - Serialization options for already-parsed string request bodies
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
    | NoInfer<R>
    | HttpRouter.Request<"Requires", NoInfer<R>>
    | HttpRouter.Request<"Error", unknown>
    | HttpRouter.Request<"GlobalRequires", NoInfer<R>>
    | HttpRouter.Request<"GlobalError", unknown>
  >,
  layer: Layer.Layer<R, RE>,
  options: ToMiddlewareOptions = {}
): RequestHandler & { readonly dispose: () => Promise<void> } => {
  // Provide construction dependencies and retain services for request dispatch.
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
  >(Layer.provideMerge(router, layer))

  const middleware: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
    const abort = new AbortController()
    let upload: RequestBody | undefined
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

      // MIME-based defaults cannot identify which parser produced a string;
      // explicit encoding handles custom JSON/text parsers without touching streams.
      const hasBody = !["GET", "HEAD"].includes(req.method)
      if (hasBody && req.body !== undefined) {
        // Parsers can change byte length through JSON serialization, text
        // decoding, or decompression, even when they return a Buffer.
        headers.delete("content-length")
      }
      if (hasBody && req.body === undefined) upload = requestBody(req, abort)
      const webRequest = new Request(url, {
        method: req.method,
        headers,
        body: !hasBody
          ? undefined
          : req.body === undefined
            ? upload!.body
            : Buffer.isBuffer(req.body) ||
                (typeof req.body === "string" &&
                  (options.bodyEncoding === "raw" ||
                    (options.bodyEncoding !== "json" &&
                      !req.is(["application/json", "application/*+json"]))))
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
      if (req.fresh) {
        res.status(304)
        res.removeHeader("content-type")
        res.removeHeader("content-length")
        res.removeHeader("transfer-encoding")
        // The handler may own request-scoped resources until its stream ends.
        // Await cancellation before completing the bodyless response.
        await webResponse.body?.cancel()
        res.end()
      } else if (webResponse.body) {
        await writeBody(webResponse.body, res)
      } else {
        res.end()
      }
    } catch (error) {
      if (!res.destroyed) next(error)
    } finally {
      upload?.drain()
      res.off("close", onClose)
    }
  }
  return Object.assign(middleware, { dispose })
}
