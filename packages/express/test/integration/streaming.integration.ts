import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import express, { type ErrorRequestHandler, type RequestHandler } from "express"
import { createServer, request as httpRequest, type IncomingMessage } from "node:http"
import { once } from "node:events"
import { toMiddleware, type ToMiddlewareOptions } from "../../src"

const startStreamServer = async (
  body: ReadableStream<Uint8Array>,
  onError: ErrorRequestHandler
) => {
  const app = express()
  const middleware = toMiddleware(
    HttpRouter.add("GET", "/", HttpServerResponse.raw(body)),
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
        const value = yield* request.json
        return yield* HttpServerResponse.json({ type: typeof value, value })
      })
    ),
    HttpRouter.add(
      "POST",
      "/text",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return HttpServerResponse.text(yield* request.text)
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
