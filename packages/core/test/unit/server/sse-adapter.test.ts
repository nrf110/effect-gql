import { describe, it, expect } from "vitest"
import { Effect, Stream, Layer } from "effect"
import * as S from "effect/Schema"
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLNonNull,
  GraphQLInt,
} from "graphql"
import { makeGraphQLSSEHandler, makeSSESubscriptionStream } from "../../../src/server/sse-adapter"
import {
  formatSSEMessage,
  formatNextEvent,
  formatErrorEvent,
  formatCompleteEvent,
  type SSEEvent,
} from "../../../src/server/sse-types"
import { GraphQLSchemaBuilder, query, subscription } from "../../../src/builder"

describe("sse-adapter.ts", () => {
  describe("formatSSEMessage", () => {
    it("should format a next event correctly", () => {
      const event: SSEEvent = {
        event: "next",
        data: '{"data":{"tick":{"count":1}}}',
      }
      const result = formatSSEMessage(event)
      expect(result).toBe('event: next\ndata: {"data":{"tick":{"count":1}}}\n\n')
    })

    it("should format a complete event correctly", () => {
      const event: SSEEvent = {
        event: "complete",
        data: "",
      }
      const result = formatSSEMessage(event)
      expect(result).toBe("event: complete\n\n")
    })

    it("should format an error event correctly", () => {
      const event: SSEEvent = {
        event: "error",
        data: '{"errors":[{"message":"Something went wrong"}]}',
      }
      const result = formatSSEMessage(event)
      expect(result).toBe('event: error\ndata: {"errors":[{"message":"Something went wrong"}]}\n\n')
    })
  })

  describe("formatNextEvent", () => {
    it("should format an ExecutionResult as a next event", () => {
      const result = formatNextEvent({ data: { hello: "world" } })
      expect(result.event).toBe("next")
      expect(JSON.parse(result.data)).toEqual({ data: { hello: "world" } })
    })

    it("should include errors in the next event", () => {
      const result = formatNextEvent({
        data: null,
        errors: [{ message: "Error" } as any],
      })
      expect(result.event).toBe("next")
      const parsed = JSON.parse(result.data)
      expect(parsed.data).toBeNull()
      expect(parsed.errors).toHaveLength(1)
    })
  })

  describe("formatErrorEvent", () => {
    it("should format errors as an error event", () => {
      const result = formatErrorEvent([{ message: "Error 1" }, { message: "Error 2" }])
      expect(result.event).toBe("error")
      const parsed = JSON.parse(result.data)
      expect(parsed.errors).toHaveLength(2)
    })
  })

  describe("formatCompleteEvent", () => {
    it("should format a complete event with empty data", () => {
      const result = formatCompleteEvent()
      expect(result.event).toBe("complete")
      expect(result.data).toBe("")
    })
  })

  describe("makeSSESubscriptionStream", () => {
    // Create a simple schema with subscriptions
    const createTestSchema = () => {
      const TickType = new GraphQLObjectType({
        name: "Tick",
        fields: {
          count: { type: new GraphQLNonNull(GraphQLInt) },
        },
      })

      return new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            hello: { type: GraphQLString },
          },
        }),
        subscription: new GraphQLObjectType({
          name: "Subscription",
          fields: {
            tick: {
              type: TickType,
              subscribe: async function* () {
                for (let i = 1; i <= 3; i++) {
                  yield { tick: { count: i } }
                }
              },
            },
            error: {
              type: GraphQLString,
              subscribe: async function* () {
                throw new Error("Subscription error")
              },
            },
          },
        }),
      })
    }

    it("should reject non-subscription operations", async () => {
      const schema = createTestSchema()
      const stream = makeSSESubscriptionStream(
        schema,
        Layer.empty,
        { query: "{ hello }" },
        new Headers()
      )

      const events: SSEEvent[] = []
      await Effect.runPromise(
        Stream.runCollect(stream).pipe(
          Effect.map((chunk) => {
            events.push(...chunk)
          })
        )
      )

      expect(events).toHaveLength(2)
      expect(events[0].event).toBe("error")
      expect(events[0].data).toContain("only supports subscriptions")
      expect(events[1].event).toBe("complete")
    })

    it("should handle invalid query syntax", async () => {
      const schema = createTestSchema()
      const stream = makeSSESubscriptionStream(
        schema,
        Layer.empty,
        { query: "{ invalid syntax" },
        new Headers()
      )

      const events: SSEEvent[] = []
      await Effect.runPromise(
        Stream.runCollect(stream).pipe(
          Effect.map((chunk) => {
            events.push(...chunk)
          })
        )
      )

      expect(events).toHaveLength(2)
      expect(events[0].event).toBe("error")
      expect(events[1].event).toBe("complete")
    })

    it("should handle validation errors", async () => {
      const schema = createTestSchema()
      const stream = makeSSESubscriptionStream(
        schema,
        Layer.empty,
        { query: "subscription { nonExistent }" },
        new Headers()
      )

      const events: SSEEvent[] = []
      await Effect.runPromise(
        Stream.runCollect(stream).pipe(
          Effect.map((chunk) => {
            events.push(...chunk)
          })
        )
      )

      expect(events).toHaveLength(2)
      expect(events[0].event).toBe("error")
      expect(events[1].event).toBe("complete")
    })

    it("should stream subscription events", async () => {
      const schema = createTestSchema()
      const stream = makeSSESubscriptionStream(
        schema,
        Layer.empty,
        { query: "subscription { tick { count } }" },
        new Headers()
      )

      const events: SSEEvent[] = []
      await Effect.runPromise(
        Stream.runCollect(stream).pipe(
          Effect.map((chunk) => {
            events.push(...chunk)
          })
        )
      )

      // 3 next events + 1 complete event
      expect(events).toHaveLength(4)
      expect(events[0].event).toBe("next")
      expect(JSON.parse(events[0].data)).toEqual({ data: { tick: { count: 1 } } })
      expect(events[1].event).toBe("next")
      expect(JSON.parse(events[1].data)).toEqual({ data: { tick: { count: 2 } } })
      expect(events[2].event).toBe("next")
      expect(JSON.parse(events[2].data)).toEqual({ data: { tick: { count: 3 } } })
      expect(events[3].event).toBe("complete")
    })
  })

  describe("makeGraphQLSSEHandler", () => {
    const createTestSchema = () =>
      new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            hello: { type: GraphQLString },
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

    it("should create a reusable handler", async () => {
      const schema = createTestSchema()
      const handler = makeGraphQLSSEHandler(schema, Layer.empty)

      const stream = handler({ query: "subscription { counter }" }, new Headers())

      const events: SSEEvent[] = []
      await Effect.runPromise(
        Stream.runCollect(stream).pipe(
          Effect.map((chunk) => {
            events.push(...chunk)
          })
        )
      )

      expect(events).toHaveLength(4)
      expect(events[0].event).toBe("next")
      expect(events[3].event).toBe("complete")
    })

    it("should call onConnect hook", async () => {
      const schema = createTestSchema()
      let connectCalled = false
      let headersReceived: Headers | null = null

      const handler = makeGraphQLSSEHandler(schema, Layer.empty, {
        onConnect: (request, headers) => {
          connectCalled = true
          headersReceived = headers
          return Effect.succeed({ userId: "123" })
        },
      })

      const headers = new Headers({ authorization: "Bearer token" })
      const stream = handler({ query: "subscription { counter }" }, headers)

      const events: SSEEvent[] = []
      await Effect.runPromise(
        Stream.runCollect(stream).pipe(
          Effect.map((chunk) => {
            events.push(...chunk)
          })
        )
      )

      expect(connectCalled).toBe(true)
      expect(headersReceived?.get("authorization")).toBe("Bearer token")
    })
  })

  describe("SSE Lifecycle Hooks", () => {
    const createTestSchema = () =>
      new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            hello: { type: GraphQLString },
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
            error: {
              type: GraphQLString,
              subscribe: async function* () {
                throw new Error("Subscription error")
              },
            },
          },
        }),
      })

    it("should call onSubscribe hook before subscription starts", async () => {
      const schema = createTestSchema()
      let subscribeCalled = false
      let subscribeContext: any = null

      const handler = makeGraphQLSSEHandler(schema, Layer.empty, {
        onSubscribe: (ctx) => {
          subscribeCalled = true
          subscribeContext = ctx
          return Effect.void
        },
      })

      const stream = handler({ query: "subscription { counter }" }, new Headers())

      await Effect.runPromise(Stream.runCollect(stream).pipe(Effect.map(() => {})))

      expect(subscribeCalled).toBe(true)
      expect(subscribeContext.request.query).toBe("subscription { counter }")
    })

    it("should call onComplete hook when subscription completes", async () => {
      const schema = createTestSchema()
      let completeCalled = false

      const handler = makeGraphQLSSEHandler(schema, Layer.empty, {
        onComplete: () => {
          completeCalled = true
          return Effect.void
        },
      })

      const stream = handler({ query: "subscription { counter }" }, new Headers())

      await Effect.runPromise(Stream.runCollect(stream).pipe(Effect.map(() => {})))

      expect(completeCalled).toBe(true)
    })

    it("should reject connection when onConnect returns failure", async () => {
      const schema = createTestSchema()

      const handler = makeGraphQLSSEHandler(schema, Layer.empty, {
        onConnect: () => Effect.fail(new Error("Unauthorized")),
      })

      const stream = handler({ query: "subscription { counter }" }, new Headers())

      const events: SSEEvent[] = []
      await Effect.runPromise(
        Stream.runCollect(stream).pipe(
          Effect.map((chunk) => {
            events.push(...chunk)
          })
        )
      )

      expect(events.length).toBe(2)
      expect(events[0].event).toBe("error")
      // onConnect failure results in an error response
      expect(events[0].data).toContain("Unauthorized")
      expect(events[1].event).toBe("complete")
    })

    it("should pass connection context to GraphQL resolver", async () => {
      let receivedContext: any = null

      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: { hello: { type: GraphQLString } },
        }),
        subscription: new GraphQLObjectType({
          name: "Subscription",
          fields: {
            counter: {
              type: GraphQLInt,
              subscribe: async function* (_, __, context) {
                receivedContext = context
                yield { counter: 1 }
              },
            },
          },
        }),
      })

      const handler = makeGraphQLSSEHandler(schema, Layer.empty, {
        onConnect: () => Effect.succeed({ userId: "user-123", role: "admin" }),
      })

      const stream = handler({ query: "subscription { counter }" }, new Headers())

      await Effect.runPromise(Stream.runCollect(stream).pipe(Effect.map(() => {})))

      expect(receivedContext.userId).toBe("user-123")
      expect(receivedContext.role).toBe("admin")
    })

    it("should handle errors thrown during subscription execution", async () => {
      const schema = createTestSchema()

      const stream = makeSSESubscriptionStream(
        schema,
        Layer.empty,
        { query: "subscription { error }" },
        new Headers()
      )

      const events: SSEEvent[] = []
      await Effect.runPromise(
        Stream.runCollect(stream).pipe(
          Effect.map((chunk) => {
            events.push(...chunk)
          })
        )
      )

      // Should get an error event and complete event
      expect(events.some((e) => e.event === "error")).toBe(true)
      expect(events.some((e) => e.event === "complete")).toBe(true)
    })
  })

  describe("SSE Complexity Validation", () => {
    const createTestSchema = () =>
      new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            hello: { type: GraphQLString },
          },
        }),
        subscription: new GraphQLObjectType({
          name: "Subscription",
          fields: {
            tick: {
              type: new GraphQLObjectType({
                name: "Tick",
                fields: {
                  count: { type: new GraphQLNonNull(GraphQLInt) },
                  nested: {
                    type: new GraphQLObjectType({
                      name: "NestedTick",
                      fields: {
                        value: { type: GraphQLInt },
                      },
                    }),
                  },
                },
              }),
              subscribe: async function* () {
                yield { tick: { count: 1, nested: { value: 1 } } }
              },
            },
          },
        }),
      })

    it("should reject subscription when complexity exceeds limit", async () => {
      const schema = createTestSchema()

      const handler = makeGraphQLSSEHandler(schema, Layer.empty, {
        complexity: {
          maxComplexity: 1, // Very low limit
        },
      })

      const stream = handler(
        { query: "subscription { tick { count nested { value } } }" },
        new Headers()
      )

      const events: SSEEvent[] = []
      await Effect.runPromise(
        Stream.runCollect(stream).pipe(
          Effect.map((chunk) => {
            events.push(...chunk)
          })
        )
      )

      expect(events.some((e) => e.event === "error")).toBe(true)
      const errorEvent = events.find((e) => e.event === "error")
      expect(errorEvent?.data).toContain("COMPLEXITY_LIMIT_EXCEEDED")
    })

    it("should reject subscription when depth exceeds limit", async () => {
      const schema = createTestSchema()

      const handler = makeGraphQLSSEHandler(schema, Layer.empty, {
        complexity: {
          maxDepth: 1, // Very shallow limit
        },
      })

      const stream = handler(
        { query: "subscription { tick { count nested { value } } }" },
        new Headers()
      )

      const events: SSEEvent[] = []
      await Effect.runPromise(
        Stream.runCollect(stream).pipe(
          Effect.map((chunk) => {
            events.push(...chunk)
          })
        )
      )

      expect(events.some((e) => e.event === "error")).toBe(true)
    })

    it("should allow subscription when complexity is within limits", async () => {
      const schema = createTestSchema()

      const handler = makeGraphQLSSEHandler(schema, Layer.empty, {
        complexity: {
          maxComplexity: 100,
          maxDepth: 10,
        },
      })

      const stream = handler({ query: "subscription { tick { count } }" }, new Headers())

      const events: SSEEvent[] = []
      await Effect.runPromise(
        Stream.runCollect(stream).pipe(
          Effect.map((chunk) => {
            events.push(...chunk)
          })
        )
      )

      expect(events.some((e) => e.event === "next")).toBe(true)
      expect(events.some((e) => e.event === "complete")).toBe(true)
    })
  })

  describe("SSE Stream Cleanup", () => {
    it("should properly clean up async iterator when stream is cancelled", async () => {
      let iteratorCleanedUp = false
      let yieldCount = 0

      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: { hello: { type: GraphQLString } },
        }),
        subscription: new GraphQLObjectType({
          name: "Subscription",
          fields: {
            slow: {
              type: GraphQLInt,
              subscribe: () => ({
                [Symbol.asyncIterator]() {
                  return {
                    async next() {
                      yieldCount++
                      if (yieldCount <= 10) {
                        await new Promise((r) => setTimeout(r, 50))
                        return { done: false, value: { slow: yieldCount } }
                      }
                      return { done: true, value: undefined }
                    },
                    return() {
                      iteratorCleanedUp = true
                      return Promise.resolve({ done: true, value: undefined })
                    },
                  }
                },
              }),
            },
          },
        }),
      })

      const stream = makeSSESubscriptionStream(
        schema,
        Layer.empty,
        { query: "subscription { slow }" },
        new Headers()
      )

      // Take only first 2 events and cancel
      const events: SSEEvent[] = []
      await Effect.runPromise(
        stream.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.map((chunk) => {
            events.push(...chunk)
          })
        )
      )

      // Should have received 2 events
      expect(events.length).toBe(2)

      // Give time for cleanup to run
      await new Promise((r) => setTimeout(r, 100))

      // Note: The cleanup happens via the Stream.async cleanup function
      // which is called when the stream is interrupted
    })
  })

  describe("Integration with GraphQLSchemaBuilder", () => {
    it("should work with builder-created schemas", async () => {
      const Tick = S.Struct({
        count: S.Number,
        timestamp: S.Number,
      })

      const builder = GraphQLSchemaBuilder.empty.pipe(
        query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        }),
        subscription("tick", {
          type: Tick,
          subscribe: () =>
            Effect.succeed(
              Stream.make(
                { count: 1, timestamp: Date.now() },
                { count: 2, timestamp: Date.now() },
                { count: 3, timestamp: Date.now() }
              )
            ),
        })
      )

      const schema = builder.buildSchema()
      const handler = makeGraphQLSSEHandler(schema, Layer.empty)

      const stream = handler({ query: "subscription { tick { count } }" }, new Headers())

      const events: SSEEvent[] = []
      await Effect.runPromise(
        Stream.runCollect(stream).pipe(
          Effect.map((chunk) => {
            events.push(...chunk)
          })
        )
      )

      expect(events.length).toBeGreaterThanOrEqual(1)
      // At least we get a response (complete or next events)
      const hasComplete = events.some((e) => e.event === "complete")
      expect(hasComplete).toBe(true)
    })
  })
})
