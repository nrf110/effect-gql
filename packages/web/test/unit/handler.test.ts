import { describe, it, expect } from "vitest"
import { Effect, Layer, Context } from "effect"
import { HttpRouter, HttpServerResponse } from "@effect/platform"
import { toHandler } from "../../src/handler"

describe("handler.ts", () => {
  describe("toHandler", () => {
    it("should create a web handler from an HttpRouter", () => {
      const router = HttpRouter.empty.pipe(
        HttpRouter.get("/", HttpServerResponse.text("Hello, World!"))
      )

      const result = toHandler(router, Layer.empty)

      expect(result).toHaveProperty("handler")
      expect(result).toHaveProperty("dispose")
      expect(typeof result.handler).toBe("function")
      expect(typeof result.dispose).toBe("function")
    })

    it("should handle GET requests", async () => {
      const router = HttpRouter.empty.pipe(
        HttpRouter.get("/hello", HttpServerResponse.text("Hello!"))
      )

      const { handler, dispose } = toHandler(router, Layer.empty)

      const request = new Request("http://localhost/hello", {
        method: "GET",
      })

      const response = await handler(request)

      expect(response.status).toBe(200)
      expect(await response.text()).toBe("Hello!")

      await dispose()
    })

    it("should handle POST requests with JSON body", async () => {
      const router = HttpRouter.empty.pipe(
        HttpRouter.post(
          "/graphql",
          Effect.gen(function* () {
            return yield* HttpServerResponse.json({ data: { test: true } })
          })
        )
      )

      const { handler, dispose } = toHandler(router, Layer.empty)

      const request = new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ test }" }),
      })

      const response = await handler(request)

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ data: { test: true } })

      await dispose()
    })

    it("should return 404 for unmatched routes", async () => {
      const router = HttpRouter.empty.pipe(
        HttpRouter.get("/hello", HttpServerResponse.text("Hello!"))
      )

      const { handler, dispose } = toHandler(router, Layer.empty)

      const request = new Request("http://localhost/notfound", {
        method: "GET",
      })

      const response = await handler(request)

      expect(response.status).toBe(404)

      await dispose()
    })

    it("should provide layer services to routes", async () => {
      class TestService extends Context.Tag("TestService")<
        TestService,
        { getValue: () => string }
      >() {}

      const testLayer = Layer.succeed(TestService, {
        getValue: () => "test-value",
      })

      const router = HttpRouter.empty.pipe(
        HttpRouter.get(
          "/test",
          Effect.gen(function* () {
            const service = yield* TestService
            return yield* HttpServerResponse.text(service.getValue())
          })
        )
      )

      const { handler, dispose } = toHandler(router, testLayer)

      const request = new Request("http://localhost/test", {
        method: "GET",
      })

      const response = await handler(request)

      expect(response.status).toBe(200)
      expect(await response.text()).toBe("test-value")

      await dispose()
    })

    it("should handle multiple concurrent requests", async () => {
      let requestCount = 0

      const router = HttpRouter.empty.pipe(
        HttpRouter.get(
          "/count",
          Effect.gen(function* () {
            requestCount++
            return yield* HttpServerResponse.text(`Request ${requestCount}`)
          })
        )
      )

      const { handler, dispose } = toHandler(router, Layer.empty)

      const requests = [
        new Request("http://localhost/count", { method: "GET" }),
        new Request("http://localhost/count", { method: "GET" }),
        new Request("http://localhost/count", { method: "GET" }),
      ]

      const responses = await Promise.all(requests.map((r) => handler(r)))

      expect(responses.every((r) => r.status === 200)).toBe(true)
      expect(requestCount).toBe(3)

      await dispose()
    })
  })

  describe("WebHandler interface", () => {
    it("should properly dispose of resources", async () => {
      const router = HttpRouter.empty.pipe(HttpRouter.get("/", HttpServerResponse.text("test")))

      const webHandler = toHandler(router, Layer.empty)

      // Call dispose
      await expect(webHandler.dispose()).resolves.toBeUndefined()
    })
  })
})
