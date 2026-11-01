import { describe, it, expect } from "vitest"
import { Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import express, { type ErrorRequestHandler } from "express"
import { createServer } from "node:http"
import { once } from "node:events"
import { toMiddleware } from "../../src/middleware"

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
