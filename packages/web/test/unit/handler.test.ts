import { describe, it, expect } from "vitest"
import { Effect, Layer, Context } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { toHandler } from "../../src/handler"

describe("handler.ts", () => {
  describe("toHandler", () => {
    it("provides services to global middleware and renders its failures", async () => {
      const Auth = Context.Service<{ readonly allowed: boolean }>("web/GlobalAuth")
      let calls = 0
      const router = HttpRouter.add("GET", "/protected", HttpServerResponse.text("protected")).pipe(
        Layer.provide(
          HttpRouter.middleware(
            (effect) =>
              Effect.gen(function* () {
                const { allowed } = yield* Auth
                calls++
                if (!allowed) yield* Effect.fail(HttpServerResponse.empty({ status: 403 }))
                return yield* effect
              }),
            { global: true }
          )
        )
      )
      for (const allowed of [true, false]) {
        const app = toHandler(router, Layer.succeed(Auth, { allowed }))
        try {
          const response = await app.handler(new Request("http://localhost/protected"))
          expect(response.status).toBe(allowed ? 200 : 403)
          expect(await response.text()).toBe(allowed ? "protected" : "")
        } finally {
          await app.dispose()
        }
      }
      expect(calls).toBe(2)
    })

    it("should handle GET requests", async () => {
      const router = HttpRouter.add("GET", "/hello", HttpServerResponse.text("Hello!"))

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
      const router = HttpRouter.add(
        "POST",
        "/graphql",
        Effect.gen(function* () {
          return yield* HttpServerResponse.json({ data: { test: true } })
        })
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
      const router = HttpRouter.add("GET", "/hello", HttpServerResponse.text("Hello!"))

      const { handler, dispose } = toHandler(router, Layer.empty)

      const request = new Request("http://localhost/notfound", {
        method: "GET",
      })

      const response = await handler(request)

      expect(response.status).toBe(404)

      await dispose()
    })

    it("should provide layer services to routes", async () => {
      class TestService extends Context.Service<TestService, { getValue: () => string }>()(
        "TestService"
      ) {}

      const testLayer = Layer.succeed(TestService, {
        getValue: () => "test-value",
      })

      const router = HttpRouter.add(
        "GET",
        "/test",
        Effect.gen(function* () {
          const service = yield* TestService
          return HttpServerResponse.text(service.getValue())
        })
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

      const router = HttpRouter.add(
        "GET",
        "/count",
        Effect.gen(function* () {
          requestCount++
          return HttpServerResponse.text(`Request ${requestCount}`)
        })
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
})
