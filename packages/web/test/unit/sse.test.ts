import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { GraphQLSchema, GraphQLObjectType, GraphQLString, GraphQLInt } from "graphql"
import { createSSEHandler, createSSEHandlers } from "../../src/sse"

describe("sse.ts", () => {
  // Create a simple schema with subscriptions
  const createTestSchema = () => {
    return new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          hello: { type: GraphQLString, resolve: () => "world" },
        },
      }),
      subscription: new GraphQLObjectType({
        name: "Subscription",
        fields: {
          counter: {
            type: GraphQLInt,
            subscribe: async function* () {
              for (let i = 1; i <= 3; i++) {
                yield { counter: i }
              }
            },
          },
        },
      }),
    })
  }

  describe("createSSEHandler", () => {
    it("should create a handler function", () => {
      const schema = createTestSchema()
      const handler = createSSEHandler(schema, Layer.empty)

      expect(typeof handler).toBe("function")
    })

    it("should return 406 for requests without accept header", async () => {
      const schema = createTestSchema()
      const handler = createSSEHandler(schema, Layer.empty)

      const request = new Request("http://localhost/graphql/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "subscription { counter }" }),
      })

      const response = await handler(request)

      expect(response.status).toBe(406)
      const body = await response.json()
      expect(body.errors[0].message).toContain("text/event-stream")
    })

    it("should return 400 for invalid request body", async () => {
      const schema = createTestSchema()
      const handler = createSSEHandler(schema, Layer.empty)

      const request = new Request("http://localhost/graphql/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: "not valid json",
      })

      const response = await handler(request)

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.errors[0].message).toContain("Invalid GraphQL request body")
    })

    it("should return 400 for missing query", async () => {
      const schema = createTestSchema()
      const handler = createSSEHandler(schema, Layer.empty)

      const request = new Request("http://localhost/graphql/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ variables: {} }),
      })

      const response = await handler(request)

      expect(response.status).toBe(400)
    })

    it("should accept */* accept header", async () => {
      const schema = createTestSchema()
      const handler = createSSEHandler(schema, Layer.empty)

      const request = new Request("http://localhost/graphql/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "*/*",
        },
        body: JSON.stringify({ query: "subscription { counter }" }),
      })

      const response = await handler(request)

      expect(response.status).toBe(200)
      expect(response.headers.get("Content-Type")).toContain("text/event-stream")
    })

    it("should return streaming response for valid subscription", async () => {
      const schema = createTestSchema()
      const handler = createSSEHandler(schema, Layer.empty)

      const request = new Request("http://localhost/graphql/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ query: "subscription { counter }" }),
      })

      const response = await handler(request)

      expect(response.status).toBe(200)
      expect(response.headers.get("Content-Type")).toContain("text/event-stream")
      expect(response.body).not.toBeNull()
      expect(response.body instanceof ReadableStream).toBe(true)
    })

    it("should set correct SSE headers", async () => {
      const schema = createTestSchema()
      const handler = createSSEHandler(schema, Layer.empty)

      const request = new Request("http://localhost/graphql/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ query: "subscription { counter }" }),
      })

      const response = await handler(request)

      expect(response.headers.get("Content-Type")).toContain("text/event-stream")
      expect(response.headers.get("Cache-Control")).toBe("no-cache")
      expect(response.headers.get("Connection")).toBe("keep-alive")
    })

    it("should call onConnect hook", async () => {
      const schema = createTestSchema()
      let connectCalled = false

      const handler = createSSEHandler(schema, Layer.empty, {
        onConnect: (_request, headers) => {
          connectCalled = true
          expect(headers.get("x-custom-header")).toBe("test-value")
          return Effect.succeed({ userId: "123" })
        },
      })

      const request = new Request("http://localhost/graphql/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "X-Custom-Header": "test-value",
        },
        body: JSON.stringify({ query: "subscription { counter }" }),
      })

      const response = await handler(request)

      // Consume the stream to complete
      await response.text()

      expect(connectCalled).toBe(true)
    })
  })

  describe("createSSEHandlers", () => {
    it("should create handlers with shouldHandle method", () => {
      const schema = createTestSchema()
      const handlers = createSSEHandlers(schema, Layer.empty)

      expect(handlers.path).toBe("/graphql/stream")
      expect(typeof handlers.shouldHandle).toBe("function")
      expect(typeof handlers.handle).toBe("function")
    })

    it("should use custom path", () => {
      const schema = createTestSchema()
      const handlers = createSSEHandlers(schema, Layer.empty, {
        path: "/custom/sse",
      })

      expect(handlers.path).toBe("/custom/sse")
    })

    it("should return true for matching POST requests", () => {
      const schema = createTestSchema()
      const handlers = createSSEHandlers(schema, Layer.empty)

      const request = new Request("http://localhost/graphql/stream", {
        method: "POST",
      })

      expect(handlers.shouldHandle(request)).toBe(true)
    })

    it("should return false for GET requests", () => {
      const schema = createTestSchema()
      const handlers = createSSEHandlers(schema, Layer.empty)

      const request = new Request("http://localhost/graphql/stream", {
        method: "GET",
      })

      expect(handlers.shouldHandle(request)).toBe(false)
    })

    it("should return false for non-matching paths", () => {
      const schema = createTestSchema()
      const handlers = createSSEHandlers(schema, Layer.empty)

      const request = new Request("http://localhost/graphql", {
        method: "POST",
      })

      expect(handlers.shouldHandle(request)).toBe(false)
    })

    it("should handle request using handle method", async () => {
      const schema = createTestSchema()
      const handlers = createSSEHandlers(schema, Layer.empty)

      const request = new Request("http://localhost/graphql/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ query: "subscription { counter }" }),
      })

      const response = await handlers.handle(request)

      expect(response.status).toBe(200)
      expect(response.headers.get("Content-Type")).toContain("text/event-stream")
    })
  })
})
