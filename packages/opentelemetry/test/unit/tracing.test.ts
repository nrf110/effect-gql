import { describe, it, expect } from "vitest"
import { Cause, Context, Effect, Exit, Layer, Option, Schema, Tracer } from "effect"
import { HttpRouter, HttpServerRespondable, HttpServerResponse } from "effect/http"
import { buildSchema } from "graphql"
import { resolverTracingMiddleware } from "../../src"
import { makeTracedGraphQLRouter, withTracedRouter } from "../../src/traced-router"

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
      { path: "/response-failure", status: 429, child: undefined },
      { path: "/typed-response-failure", status: 429, child: undefined },
      { path: "/composite-response-failure", status: 403, child: undefined },
      { path: "/schema-failure", status: 400, child: undefined },
      { path: "/missing-value", status: 404, child: undefined },
      { path: "/schema-defect", status: 500, child: undefined },
      { path: "/missing-value-defect", status: 500, child: undefined },
    ])("finishes the configured request span for $path", async ({ path, status, child }) => {
      const recording = recordingTracer()
      const invalidInput = Schema.decodeUnknownEffect(Schema.Number)("invalid")
      const routes = Layer.mergeAll(
        HttpRouter.add(
          "GET",
          "/hello",
          Effect.succeed(HttpServerResponse.text("hello")).pipe(Effect.withSpan("hello.handler"))
        ),
        HttpRouter.add(
          "GET",
          "/fail",
          Effect.die(new Error("route failed")).pipe(Effect.withSpan("failure.handler"))
        ),
        HttpRouter.add(
          "GET",
          "/response-failure",
          Effect.die(HttpServerResponse.empty({ status: 429 }))
        ),
        HttpRouter.add(
          "GET",
          "/typed-response-failure",
          Effect.fail(HttpServerResponse.empty({ status: 429 }))
        ),
        HttpRouter.add(
          "GET",
          "/composite-response-failure",
          Effect.failCause(
            Cause.fromReasons([
              ...Cause.die(HttpServerResponse.empty({ status: 418 })).reasons,
              ...Cause.fail(HttpServerResponse.empty({ status: 429 })).reasons,
              ...Cause.die(HttpServerResponse.empty({ status: 403 })).reasons,
              ...Cause.die(new Error("later defect")).reasons,
            ])
          )
        ),
        HttpRouter.add(
          "GET",
          "/schema-failure",
          invalidInput.pipe(Effect.as(HttpServerResponse.empty()))
        ),
        HttpRouter.add("GET", "/missing-value", Effect.fail(new Cause.NoSuchElementError())),
        HttpRouter.add(
          "GET",
          "/schema-defect",
          invalidInput.pipe(Effect.orDie, Effect.as(HttpServerResponse.empty()))
        ),
        HttpRouter.add("GET", "/missing-value-defect", Effect.die(new Cause.NoSuchElementError()))
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
        expect(root.attributes.get("http.status_code")).toBe(status)
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

    it.each(["GET", "POST"])(
      "records the unmatched %s status before the GraphQL request span ends",
      async (method) => {
        const recording = recordingTracer()
        const app = Layer.merge(
          makeTracedGraphQLRouter(buildSchema("type Query { hello: String }"), Layer.empty, {
            rootSpanName: "graphql.request",
          }),
          recording.layer
        )
        const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true })

        try {
          const response = await handler(new Request("http://localhost/missing", { method }))
          expect(response.status).toBe(404)
          const root = recording.spans.find((span) => span.name === "graphql.request")!
          expect(root.attributes.get("http.status_code")).toBe(404)
          expect(root.status._tag).toBe("Ended")
          if (root.status._tag === "Ended") expect(Exit.isFailure(root.status.exit)).toBe(true)
        } finally {
          await dispose()
        }
      }
    )

    it.each(["defect", "respondable"])("preserves %s failures for outer recovery", async (kind) => {
      const recording = recordingTracer()
      const failure = new Error("original route failure")
      let conversions = 0
      if (kind === "respondable") {
        Object.assign(failure, {
          [HttpServerRespondable.symbol]: () =>
            Effect.sync(() => {
              conversions++
              return HttpServerResponse.text("custom conversion", { status: 418 })
            }),
        })
      }
      const failureCause = kind === "defect" ? Cause.die(failure) : Cause.fail(failure)
      let observedCause: Cause.Cause<unknown> | undefined
      const recover = HttpRouter.middleware(
        (httpEffect) =>
          Effect.catchCause(httpEffect, (cause) => {
            observedCause = cause
            return Effect.succeed(
              HttpServerResponse.text("recovered by outer middleware", { status: 503 })
            )
          }),
        { global: true }
      )
      const app = Layer.merge(
        withTracedRouter(HttpRouter.add("GET", "/fail", Effect.failCause(failureCause)), {
          rootSpanName: "failed.request",
        }).pipe(Layer.provide(recover)),
        recording.layer
      )
      const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true })

      try {
        const response = await handler(new Request("http://localhost/fail"))
        expect(response.status).toBe(503)
        expect(await response.text()).toBe("recovered by outer middleware")
        expect(conversions).toBe(0)
        expect(observedCause?.reasons).toHaveLength(1)
        expect(Cause.squash(observedCause!)).toBe(failure)
        const root = recording.spans.find((span) => span.name === "failed.request")!
        expect(root.attributes.get("http.status_code")).toBe(kind === "defect" ? 500 : undefined)
        expect(root.status._tag).toBe("Ended")
        if (root.status._tag === "Ended")
          expect(root.status.exit).toEqual(Exit.failCause(observedCause!))
      } finally {
        await dispose()
      }
    })

    it("leaves custom response conversion to the HTTP server", async () => {
      const recording = recordingTracer()
      let conversions = 0
      const failure = {
        [HttpServerRespondable.symbol]: () =>
          Effect.sync(() => {
            conversions++
            return HttpServerResponse.text("custom response", { status: 418 })
          }),
      }
      const app = Layer.merge(
        withTracedRouter(HttpRouter.add("GET", "/fail", Effect.fail(failure)), {
          rootSpanName: "custom.failure",
        }),
        recording.layer
      )
      const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true })

      try {
        const response = await handler(new Request("http://localhost/fail"))
        expect(response.status).toBe(418)
        expect(await response.text()).toBe("custom response")
        expect(conversions).toBe(1)
        const root = recording.spans.find((span) => span.name === "custom.failure")!
        expect(root.attributes.has("http.status_code")).toBe(false)
        expect(root.status._tag).toBe("Ended")
        if (root.status._tag === "Ended") {
          expect(Exit.isFailure(root.status.exit)).toBe(true)
          if (Exit.isFailure(root.status.exit)) {
            expect(Cause.squash(root.status.exit.cause)).toBe(failure)
          }
        }
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
