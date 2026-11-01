import { describe, it, expect } from "vitest"
import { Context, Effect, Exit, Layer, Option, Tracer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { resolverTracingMiddleware } from "../../src"
import { withTracedRouter } from "../../src/traced-router"

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736"
const parentSpanId = "00f067aa0ba902b7"
const traceparent = `00-${traceId}-${parentSpanId}-01`

const recordingTracer = () => {
  const spans: Array<Tracer.Span> = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    },
  })
  return { spans, layer: Layer.succeed(Tracer.Tracer, tracer) }
}

describe("tracing", () => {
  describe("resolverTracingMiddleware", () => {
    it("should filter introspection fields by default", () => {
      const mw = resolverTracingMiddleware()
      const info = {
        fieldName: "__schema",
        parentType: { name: "Query" },
        path: { key: "__schema", prev: undefined },
      } as any

      expect(mw.match!(info)).toBe(false)
    })

    it("should trace introspection fields when enabled", () => {
      const mw = resolverTracingMiddleware({ traceIntrospection: true })
      const info = {
        fieldName: "__schema",
        parentType: { name: "Query" },
        path: { key: "__schema", prev: undefined },
      } as any

      expect(mw.match!(info)).toBe(true)
    })

    it("should filter by depth when configured", () => {
      const mw = resolverTracingMiddleware({ minDepth: 1 })
      const rootInfo = {
        fieldName: "users",
        parentType: { name: "Query" },
        path: { key: "users", prev: undefined },
      } as any

      expect(mw.match!(rootInfo)).toBe(false)

      const nestedInfo = {
        fieldName: "name",
        parentType: { name: "User" },
        path: {
          key: "name",
          prev: { key: "users", prev: undefined },
        },
      } as any

      expect(mw.match!(nestedInfo)).toBe(true)
    })

    it("should filter by exclude patterns", () => {
      const mw = resolverTracingMiddleware({
        excludePatterns: [/\.id$/, /^Query\.health/],
      })

      const idField = {
        fieldName: "id",
        parentType: { name: "User" },
        path: { key: "id", prev: undefined },
      } as any

      expect(mw.match!(idField)).toBe(false)

      const healthField = {
        fieldName: "health",
        parentType: { name: "Query" },
        path: { key: "health", prev: undefined },
      } as any

      expect(mw.match!(healthField)).toBe(false)

      const nameField = {
        fieldName: "name",
        parentType: { name: "User" },
        path: { key: "name", prev: undefined },
      } as any

      expect(mw.match!(nameField)).toBe(true)
    })
  })

  describe("withTracedRouter", () => {
    it.each([
      { path: "/hello", status: 200, child: "hello.handler" },
      { path: "/missing", status: 404, child: undefined },
      { path: "/fail", status: 500, child: "failure.handler" },
    ])("finishes the configured request span for $path", async ({ path, status, child }) => {
      const recording = recordingTracer()
      const routes = Layer.merge(
        HttpRouter.add(
          "GET",
          "/hello",
          Effect.succeed(HttpServerResponse.text("hello")).pipe(Effect.withSpan("hello.handler"))
        ),
        HttpRouter.add(
          "GET",
          "/fail",
          Effect.die(new Error("route failed")).pipe(Effect.withSpan("failure.handler"))
        )
      )
      const app = Layer.merge(
        withTracedRouter(routes, {
          rootSpanName: "custom.http",
          rootSpanAttributes: {
            "service.name": "consumer",
            "custom.version": 2,
            "custom.enabled": true,
          },
        }),
        recording.layer
      )
      const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true })

      try {
        const response = await handler(
          new Request(`http://localhost${path}`, { headers: { traceparent } })
        )
        expect(response.status).toBe(status)
        if (status === 200) expect(await response.text()).toBe("hello")

        const roots = recording.spans.filter((span) => span.name === "custom.http")
        expect(roots).toHaveLength(1)
        const root = roots[0]!
        expect(root.attributes.get("service.name")).toBe("consumer")
        expect(root.attributes.get("custom.version")).toBe(2)
        expect(root.attributes.get("custom.enabled")).toBe(true)
        expect(root.attributes.get("http.target")).toBe(path)
        expect(root.traceId).toBe(traceId)
        expect(Option.getOrThrow(root.parent)).toMatchObject({
          _tag: "ExternalSpan",
          traceId,
          spanId: parentSpanId,
        })
        expect(root.status._tag).toBe("Ended")
        if (root.status._tag === "Ended") {
          expect(Exit.isFailure(root.status.exit)).toBe(status >= 400)
        }
        if (child) {
          const childSpan = recording.spans.find((span) => span.name === child)!
          expect(childSpan).toBeDefined()
          expect(childSpan.traceId).toBe(root.traceId)
          expect(Option.getOrThrow(childSpan.parent).spanId).toBe(root.spanId)
        }
        for (const span of recording.spans) expect(span.status._tag).toBe("Ended")
      } finally {
        await dispose()
      }
    })

    it("wraps shared dispatch while preserving route-scoped services and middleware", async () => {
      class Greeting extends Context.Service<Greeting, { readonly message: string }>()(
        "tracing-test/Greeting"
      ) {}
      const recording = recordingTracer()
      const routeMiddleware = HttpRouter.middleware((effect) =>
        Effect.map(effect, HttpServerResponse.setHeader("x-hello", "route-only"))
      )
      const hello = HttpRouter.add(
        "GET",
        "/hello",
        Effect.map(Greeting, ({ message }) => HttpServerResponse.text(message))
      ).pipe(
        HttpRouter.provideRequest(Layer.succeed(Greeting, { message: "from-service" })),
        Layer.provide(routeMiddleware.layer)
      )
      const app = Layer.mergeAll(
        withTracedRouter(hello, { rootSpanName: "shared.http" }),
        HttpRouter.add("GET", "/sibling", HttpServerResponse.text("sibling")),
        recording.layer
      )
      const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true })

      try {
        const helloResponse = await handler(new Request("http://localhost/hello"))
        expect(helloResponse.status).toBe(200)
        expect(await helloResponse.text()).toBe("from-service")
        expect(helloResponse.headers.get("x-hello")).toBe("route-only")

        const siblingResponse = await handler(new Request("http://localhost/sibling"))
        expect(siblingResponse.status).toBe(200)
        expect(await siblingResponse.text()).toBe("sibling")
        expect(siblingResponse.headers.get("x-hello")).toBeNull()
        const roots = recording.spans.filter((span) => span.name === "shared.http")
        expect(roots.map((span) => span.attributes.get("http.target"))).toEqual([
          "/hello",
          "/sibling",
        ])
        for (const root of roots) expect(root.status._tag).toBe("Ended")
      } finally {
        await dispose()
      }
    })

    it.each(["/hello", "/missing"])(
      "retains the enclosing server parent when package propagation is disabled for %s",
      async (path) => {
        const recording = recordingTracer()
        const app = Layer.merge(
          withTracedRouter(HttpRouter.add("GET", "/hello", HttpServerResponse.text("hello")), {
            rootSpanName: "local.http",
            propagateContext: false,
          }),
          recording.layer
        )
        const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true })

        try {
          const response = await handler(
            new Request(`http://localhost${path}`, { headers: { traceparent } })
          )
          expect(response.status).toBe(path === "/hello" ? 200 : 404)
          const root = recording.spans.find((span) => span.name === "local.http")!
          expect(root).toBeDefined()
          const parent = Option.getOrThrow(root.parent)
          expect(parent._tag).toBe("Span")
          expect(parent.spanId).not.toBe(parentSpanId)
          expect(root.traceId).toBe(traceId)
          expect(root.status._tag).toBe("Ended")
        } finally {
          await dispose()
        }
      }
    )
  })
})
