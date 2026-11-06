import { describe, it, expect } from "vitest"
import { ByteSize, Effect, Layer, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import express, { type ErrorRequestHandler, type RequestHandler } from "express"
import { Agent, createServer, request as httpRequest, type IncomingMessage } from "node:http"
import { once } from "node:events"
import { gzipSync } from "node:zlib"
import { toMiddleware, type ToMiddlewareOptions } from "../../src"

const startStreamServer = async (
  body: ReadableStream<Uint8Array>,
  onError: ErrorRequestHandler,
  options?: HttpServerResponse.Options,
  onFinish?: () => void
) => {
  const app = express()
  if (onFinish) {
    app.use((_req, res, next) => {
      res.once("finish", onFinish)
      next()
    })
  }
  const middleware = toMiddleware(
    HttpRouter.add("*", "/", HttpServerResponse.raw(body, options)),
    Layer.empty
  )
  app.use(middleware)
  app.use(onError)
  const server = createServer(app)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP server address")
  return {
    url: `http://127.0.0.1:${address.port}/`,
    stop: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      await middleware.dispose()
    },
  }
}

const encode = (text: string) => new TextEncoder().encode(text)

// Fetch adds Cache-Control: no-cache to conditional requests; use the wire
// headers directly to exercise Express freshness semantics.
const conditionalRequest = (url: string, method: string, validator: string) =>
  new Promise<{
    status: number | undefined
    headers: IncomingMessage["headers"]
    body: string
  }>((resolve, reject) => {
    const request = httpRequest(
      url,
      { method, headers: { "if-none-match": validator } },
      async (response) => {
        try {
          response.setEncoding("utf8")
          let body = ""
          for await (const chunk of response) body += chunk
          resolve({ status: response.statusCode, headers: response.headers, body })
        } catch (error) {
          reject(error)
        }
      }
    )
    request.once("error", reject)
    request.end()
  })

describe("Express streaming responses", () => {
  it("keeps the response writable for an early source error", async () => {
    const failure = new Error("source failed before its first chunk")
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure)
      },
    })
    const errors: unknown[] = []
    const states: { headersSent: boolean; destroyed: boolean; locked: boolean }[] = []
    const server = await startStreamServer(body, (error, _req, res, _next) => {
      errors.push(error)
      states.push({ headersSent: res.headersSent, destroyed: res.destroyed, locked: body.locked })
      res.status(503).send("unavailable")
    })
    try {
      const response = await fetch(server.url)
      expect(response.status).toBe(503)
      expect(await response.text()).toBe("unavailable")
      expect(errors).toEqual([failure])
      expect(states).toEqual([{ headersSent: false, destroyed: false, locked: false }])
    } finally {
      await server.stop()
    }
  })

  it("forwards an error after the first chunk without sending a replacement response", async () => {
    const failure = new Error("source failed after starting")
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(source) {
        controller = source
        source.enqueue(encode("started\n"))
      },
    })
    const errors: unknown[] = []
    const states: { headersSent: boolean; destroyed: boolean; locked: boolean }[] = []
    const server = await startStreamServer(body, (error, _req, res, _next) => {
      errors.push(error)
      states.push({ headersSent: res.headersSent, destroyed: res.destroyed, locked: body.locked })
      // Express error handlers must delegate/close once headers have committed.
      if (res.headersSent) res.destroy()
      else res.status(503).send("unavailable")
    })
    try {
      const response = await fetch(server.url)
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      try {
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("started\n")
        controller.error(failure)
        await expect(reader.read()).rejects.toThrow()
        expect(errors).toEqual([failure])
        expect(states).toEqual([{ headersSent: true, destroyed: false, locked: false }])
      } finally {
        reader.releaseLock()
      }
    } finally {
      await server.stop()
    }
  })

  it("cancels a pending source read and releases its reader on client disconnect", async () => {
    let signalCancellation!: () => void
    const canceled = new Promise<void>((resolve) => {
      signalCancellation = resolve
    })
    let cancellations = 0
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode("first chunk"))
      },
      cancel() {
        cancellations++
        signalCancellation()
      },
    })
    const errors: unknown[] = []
    const server = await startStreamServer(body, (error, _req, res, _next) => {
      errors.push(error)
      res.destroy()
    })
    try {
      const response = await fetch(server.url)
      const reader = response.body!.getReader()
      try {
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("first chunk")
        await reader.cancel()
      } finally {
        reader.releaseLock()
      }
      await canceled
      await expect.poll(() => body.locked).toBe(false)
      expect(cancellations).toBe(1)
      expect(errors).toEqual([])
    } finally {
      await server.stop()
    }
  })

  it.each([
    { method: "GET", status: 200, validator: '"revision1"', expectedStatus: 304, expectedBody: "" },
    {
      method: "GET",
      status: 200,
      validator: '"different"',
      expectedStatus: 200,
      expectedBody: "representation",
    },
    {
      method: "GET",
      status: 500,
      validator: '"revision1"',
      expectedStatus: 500,
      expectedBody: "representation",
    },
    {
      method: "POST",
      status: 200,
      validator: '"revision1"',
      expectedStatus: 200,
      expectedBody: "representation",
    },
    {
      method: "HEAD",
      status: 200,
      validator: '"revision1"',
      expectedStatus: 304,
      expectedBody: "",
    },
  ])(
    "honors If-None-Match $validator for $method status $status",
    async ({ method, status, validator, expectedStatus, expectedBody }) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encode("representation"))
          controller.close()
        },
      })
      const errors: unknown[] = []
      const server = await startStreamServer(
        body,
        (error, _req, res, _next) => {
          errors.push(error)
          res.destroy()
        },
        {
          status,
          headers: {
            etag: '"revision1"',
            "content-type": "text/plain",
            "content-length": "14",
          },
        }
      )
      try {
        const response = await conditionalRequest(server.url, method, validator)
        expect(response.status).toBe(expectedStatus)
        expect(response.body).toBe(expectedBody)
        expect(response.headers.etag).toBe('"revision1"')
        if (expectedStatus === 304) {
          expect(response.headers["content-type"]).toBeUndefined()
          expect(response.headers["content-length"]).toBeUndefined()
          expect(response.headers["transfer-encoding"]).toBeUndefined()
        }
        expect(errors).toEqual([])
      } finally {
        await server.stop()
      }
    }
  )

  it("awaits cancellation of an unused conditional response stream", async () => {
    let signalCancellation!: () => void
    const canceled = new Promise<void>((resolve) => {
      signalCancellation = resolve
    })
    let finishCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve
    })
    let cancellations = 0
    let released = false
    let releasedAtFinish = false
    const body = new ReadableStream<Uint8Array>({
      async cancel() {
        cancellations++
        signalCancellation()
        await cleanup
        released = true
      },
    })
    const errors: unknown[] = []
    const server = await startStreamServer(
      body,
      (error, _req, res, _next) => {
        errors.push(error)
        res.destroy()
      },
      { headers: { etag: '"revision1"' } },
      () => {
        releasedAtFinish = released
      }
    )
    try {
      const responsePromise = conditionalRequest(server.url, "GET", '"revision1"')
      await canceled
      expect(released).toBe(false)
      finishCleanup()
      const response = await responsePromise
      expect(response.status).toBe(304)
      expect(response.body).toBe("")
      expect(released).toBe(true)
      expect(releasedAtFinish).toBe(true)
      expect(cancellations).toBe(1)
      expect(body.locked).toBe(false)
      expect(errors).toEqual([])
    } finally {
      finishCleanup()
      await server.stop()
    }
  })
})

const startBodyServer = async (parser?: RequestHandler, options?: ToMiddlewareOptions) => {
  const app = express()
  if (parser) app.use(parser)
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "POST",
      "/json",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const value = yield* request.json.pipe(
          Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(1024))
        )
        return yield* HttpServerResponse.json({ type: typeof value, value })
      })
    ),
    HttpRouter.add(
      "POST",
      "/text",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return HttpServerResponse.text(
          yield* request.text.pipe(
            Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(1024))
          )
        )
      })
    ),
    HttpRouter.add(
      "POST",
      "/stream",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return HttpServerResponse.stream(request.stream)
      })
    )
  )
  const middleware = toMiddleware(routes, Layer.empty, options)
  app.use(middleware)
  const server = createServer(app)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP server address")
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      await middleware.dispose()
    },
  }
}

describe("Express request bodies", () => {
  it.each(["ignored", "partial", "response error"] as const)(
    "drains the %s upload so the same connection can serve another request",
    async (mode) => {
      const app = express()
      const failure = new Error("upload response failed")
      const errors: unknown[] = []
      const middleware = toMiddleware(
        Layer.mergeAll(
          HttpRouter.add(
            "POST",
            "/",
            Effect.gen(function* () {
              if (mode === "partial") {
                const request = yield* HttpServerRequest.HttpServerRequest
                yield* Stream.runHead(request.stream)
              }
              if (mode === "response error") {
                return HttpServerResponse.raw(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.error(failure)
                    },
                  })
                )
              }
              return HttpServerResponse.text("upload accepted")
            })
          ),
          HttpRouter.add("GET", "/", HttpServerResponse.text("next request"))
        ),
        Layer.empty
      )
      app.use(middleware)
      app.use(((error, _req, res, _next) => {
        errors.push(error)
        res.status(503).send("upload failed")
      }) satisfies ErrorRequestHandler)
      const server = createServer(app)
      const agent = new Agent({ keepAlive: true, maxSockets: 1 })
      server.listen(0, "127.0.0.1")
      await once(server, "listening")
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Expected TCP server address")
      const send = (method: string, body?: Buffer) =>
        new Promise<{
          status: number | undefined
          body: string
          socket: IncomingMessage["socket"]
        }>((resolve, reject) => {
          const request = httpRequest(
            `http://127.0.0.1:${address.port}/`,
            {
              method,
              agent,
              headers: body ? { "content-length": body.length } : { connection: "close" },
            },
            async (response) => {
              const socket = response.socket
              try {
                response.setEncoding("utf8")
                let text = ""
                for await (const chunk of response) text += chunk
                resolve({ status: response.statusCode, body: text, socket })
              } catch (error) {
                reject(error)
              }
            }
          )
          request.once("error", reject)
          request.setTimeout(2000, () => request.destroy(new Error("Keep-alive request stalled")))
          request.end(body)
        })
      try {
        const first = await send("POST", Buffer.alloc(1024 * 1024, "x"))
        const second = await send("GET")
        expect(first.status).toBe(mode === "response error" ? 503 : 200)
        expect(first.body).toBe(mode === "response error" ? "upload failed" : "upload accepted")
        expect(second.status).toBe(200)
        expect(second.body).toBe("next request")
        expect(second.socket).toBe(first.socket)
        expect(errors).toEqual(mode === "response error" ? [failure] : [])
      } finally {
        agent.destroy()
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        })
        await middleware.dispose()
      }
    }
  )

  it("reads reserialized exponent notation with a bounded body size", async () => {
    const server = await startBodyServer(express.json())
    try {
      const response = await fetch(`${server.url}/json`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"value":1e9}',
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ type: "object", value: { value: 1000000000 } })
    } finally {
      await server.stop()
    }
  })

  it("uses the decoded text length instead of the original charset byte length", async () => {
    const server = await startBodyServer(express.text())
    try {
      const response = await fetch(`${server.url}/text`, {
        method: "POST",
        headers: { "content-type": "text/plain; charset=iso-8859-1" },
        body: Buffer.from([0xe9]),
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("é")
    } finally {
      await server.stop()
    }
  })

  it("uses the inflated buffer length instead of the compressed upload length", async () => {
    const server = await startBodyServer(express.raw({ type: "*/*" }))
    const value = "decoded content ".repeat(20)
    try {
      const response = await fetch(`${server.url}/text`, {
        method: "POST",
        headers: { "content-type": "text/plain", "content-encoding": "gzip" },
        body: gzipSync(value),
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(value)
    } finally {
      await server.stop()
    }
  })

  it("still enforces the configured size limit on parsed bodies", async () => {
    const server = await startBodyServer(express.text())
    try {
      const response = await fetch(`${server.url}/text`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "x".repeat(1025),
      })
      expect(response.status).toBe(413)
    } finally {
      await server.stop()
    }
  })

  it.each([
    ["hello", "application/json"],
    ["123", "application/json"],
    ["hello", "application/vnd.example+json"],
  ])("preserves the parsed JSON string %j with %s", async (value, contentType) => {
    const server = await startBodyServer(
      express.json({ strict: false, type: ["application/json", "application/*+json"] })
    )
    try {
      const response = await fetch(`${server.url}/json`, {
        method: "POST",
        headers: { "content-type": contentType },
        body: JSON.stringify(value),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ type: "string", value })
    } finally {
      await server.stop()
    }
  })

  it.each([
    {
      name: "a custom media type",
      parser: express.json({ strict: false, type: "application/csp-report" }),
      contentType: "application/csp-report",
    },
    {
      name: "a text media type",
      parser: express.json({ strict: false, type: "text/plain" }),
      contentType: "text/plain",
    },
    {
      name: "a parser predicate",
      parser: express.json({ strict: false, type: () => true }),
      contentType: "text/plain",
    },
  ])(
    "preserves JSON strings parsed using $name with explicit JSON encoding",
    async ({ parser, contentType }) => {
      const server = await startBodyServer(parser, { bodyEncoding: "json" })
      try {
        for (const value of ["hello", "123"]) {
          const response = await fetch(`${server.url}/json`, {
            method: "POST",
            headers: { "content-type": contentType },
            body: JSON.stringify(value),
          })
          expect(response.status).toBe(200)
          expect(await response.json()).toEqual({ type: "string", value })
        }
      } finally {
        await server.stop()
      }
    }
  )

  it.each([
    { value: 123 },
    { value: true },
    { value: null },
    { value: ["hello"] },
    { value: { message: "hello" } },
  ])("preserves the parsed JSON value %j", async ({ value }) => {
    const server = await startBodyServer(express.json({ strict: false }))
    try {
      const response = await fetch(`${server.url}/json`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ type: typeof value, value })
    } finally {
      await server.stop()
    }
  })

  it.each(["hello", '"hello"', "123", ""])("forwards parsed text %j unchanged", async (value) => {
    const server = await startBodyServer(express.text())
    try {
      const response = await fetch(`${server.url}/text`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: value,
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(value)
    } finally {
      await server.stop()
    }
  })

  it.each(["hello", '"hello"', "123", ""])(
    "forwards parsed text %j with a JSON content type using explicit raw encoding",
    async (value) => {
      const server = await startBodyServer(express.text({ type: "application/json" }), {
        bodyEncoding: "raw",
      })
      try {
        const response = await fetch(`${server.url}/text`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: value,
        })
        expect(response.status).toBe(200)
        expect(await response.text()).toBe(value)
      } finally {
        await server.stop()
      }
    }
  )

  it.each([undefined, "json", "raw"] as const)(
    "forwards raw parser buffers unchanged with bodyEncoding %j",
    async (bodyEncoding) => {
      const server = await startBodyServer(express.raw({ type: "*/*" }), { bodyEncoding })
      const bytes = Buffer.from([0, 255, 34, 49, 50, 51, 34])
      try {
        const response = await fetch(`${server.url}/stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: bytes,
        })
        expect(response.status).toBe(200)
        expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
      } finally {
        await server.stop()
      }
    }
  )

  it.each([undefined, "json", "raw"] as const)(
    "streams unparsed uploads before the request ends with bodyEncoding %j",
    async (bodyEncoding) => {
      const server = await startBodyServer(undefined, { bodyEncoding })
      const upload = httpRequest(`${server.url}/stream`, { method: "POST" })
      try {
        const response = new Promise<IncomingMessage>((resolve, reject) => {
          upload.once("response", resolve)
          upload.once("error", reject)
        })
        upload.write("first")
        const incoming = await response
        expect(incoming.statusCode).toBe(200)
        const chunks = incoming[Symbol.asyncIterator]()
        expect((await chunks.next()).value.toString()).toBe("first")
        upload.end("second")
        let remainder = ""
        for await (const chunk of { [Symbol.asyncIterator]: () => chunks }) {
          remainder += chunk.toString()
        }
        expect(remainder).toBe("second")
      } finally {
        upload.destroy()
        await server.stop()
      }
    }
  )
})
