import { describe, it, expect } from "vitest"
import { Context, Deferred, Effect, Fiber, References, Stream, Layer } from "effect"
import * as S from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLNonNull,
  GraphQLScalarType,
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
    it.each(["failure", "throw"])("frames onConnect %s as a rejected connection", async (mode) => {
      const events = await Effect.runPromise(
        makeSSESubscriptionStream(
          createTestSchema(),
          Layer.empty,
          { query: "subscription { tick { count } }" },
          new Headers(),
          {
            onConnect: () => {
              if (mode === "throw") throw new Error("Unauthorized")
              return Effect.fail(new Error("Unauthorized"))
            },
          }
        ).pipe(Stream.runCollect)
      )

      expect(events.map((event) => event.event)).toEqual(["error", "complete"])
      expect(JSON.parse(events[0].data)).toEqual({
        errors: [{ message: "Unauthorized", extensions: { code: "CONNECTION_REJECTED" } }],
      })
    })

    it("isolates and releases each subscription when its layer is already ambient", async () => {
      const Resource = Context.Service<{ readonly id: number }>("sse/SubscriptionResource")
      const Mirror = Context.Service<number>("sse/SubscriptionMirror")
      let acquired = 0
      const released: number[] = []
      const observed: Array<{ id: number; mirror: number }> = []
      const resource = Layer.effect(
        Resource,
        Effect.acquireRelease(
          Effect.sync(() => ({ id: ++acquired })),
          ({ id }) => Effect.sync(() => released.push(id))
        )
      )
      const layer = Layer.merge(
        resource,
        Layer.effect(
          Mirror,
          Effect.map(Resource, ({ id }) => id)
        ).pipe(Layer.provide(resource))
      )
      const schema = GraphQLSchemaBuilder.empty
        .query("hello", { type: S.String, resolve: () => Effect.succeed("world") })
        .subscription("instance", {
          type: S.Int,
          subscribe: () => Effect.map(Resource, ({ id }) => Stream.succeed(id)),
        })
        .buildSchema()
      const events = await Effect.runPromise(
        Effect.gen(function* () {
          expect((yield* Resource).id).toBe(1)
          const subscriptions: SSEEvent[][] = []
          for (let subscription = 0; subscription < 2; subscription++) {
            subscriptions.push(
              yield* makeSSESubscriptionStream(
                schema,
                layer,
                { query: "subscription { instance }" },
                new Headers(),
                {
                  onSubscribe: () =>
                    Effect.gen(function* () {
                      observed.push({ id: (yield* Resource).id, mirror: yield* Mirror })
                    }),
                }
              ).pipe(Stream.runCollect)
            )
            expect(released).toEqual(subscription === 0 ? [2] : [2, 3])
          }
          expect((yield* Resource).id).toBe(1)
          return subscriptions
        }).pipe(Effect.provide(layer))
      )

      expect(events).toEqual([
        [formatNextEvent({ data: { instance: 2 } }), formatCompleteEvent()],
        [formatNextEvent({ data: { instance: 3 } }), formatCompleteEvent()],
      ])
      expect(observed).toEqual([
        { id: 2, mirror: 2 },
        { id: 3, mirror: 3 },
      ])
      expect(acquired).toBe(3)
      expect(released).toEqual([2, 3, 1])
    })

    it("preserves ambient annotations and spans across hooks and detached subscription effects", async () => {
      const Setting = Context.Service<string>("sse/AnnotationSetting")
      const observations: Array<{
        phase: string
        connectionId: unknown
        span: string
        setting: string
      }> = []
      const observe = (phase: string) =>
        Effect.gen(function* () {
          observations.push({
            phase,
            connectionId: (yield* References.CurrentLogAnnotations).connectionId,
            span: (yield* Effect.currentSpan.pipe(Effect.orDie)).name,
            setting: yield* Setting,
          })
        })
      const layer = Layer.effect(
        Setting,
        observe("layer").pipe(Effect.as("explicit"), Effect.provideService(Setting, "building"))
      )
      const schema = GraphQLSchemaBuilder.empty
        .query("hello", { type: S.String, resolve: () => Effect.succeed("world") })
        .subscription("setting", {
          type: S.String,
          subscribe: () =>
            observe("subscribe").pipe(
              Effect.andThen(Setting),
              Effect.map((setting) => Stream.succeed(setting))
            ),
        })
        .buildSchema()
      const events = await Effect.runPromise(
        makeSSESubscriptionStream(
          schema,
          layer,
          { query: "subscription { setting }" },
          new Headers(),
          {
            onConnect: () => observe("connect").pipe(Effect.as({})),
            onSubscribe: (ctx) =>
              observe("hook").pipe(
                Effect.andThen(
                  Effect.promise(() => Effect.runPromiseWith(ctx.services)(observe("detached")))
                )
              ),
            onComplete: () => observe("complete"),
          }
        ).pipe(
          Stream.runCollect,
          Effect.provideService(Setting, "ambient"),
          Effect.annotateLogs("connectionId", "sse-connection"),
          Effect.withSpan("sse-connection")
        )
      )

      expect(events).toEqual([
        formatNextEvent({ data: { setting: "explicit" } }),
        formatCompleteEvent(),
      ])
      expect(observations).toEqual(
        ["layer", "connect", "hook", "detached", "subscribe", "complete"].map((phase) => ({
          phase,
          connectionId: "sse-connection",
          span: "sse-connection",
          setting: phase === "layer" ? "building" : "explicit",
        }))
      )
    })

    it.each(["bigint", "circular"])(
      "frames %s serialization errors and finalizes resources",
      async (mode) => {
        const lifecycle: string[] = []
        const Resource = Context.Service<string>("sse/SerializationResource")
        const layer = Layer.effect(
          Resource,
          Effect.acquireRelease(Effect.succeed("open"), () =>
            Effect.sync(() => lifecycle.push("release"))
          )
        )
        const circular: { self?: unknown } = {}
        circular.self = circular
        const value = mode === "bigint" ? 1n : circular
        const scalar = new GraphQLScalarType({
          name: "Unserializable",
          serialize: (input) => input,
        })
        const schema = new GraphQLSchema({
          query: new GraphQLObjectType({
            name: "Query",
            fields: { hello: { type: GraphQLString } },
          }),
          subscription: new GraphQLObjectType({
            name: "Subscription",
            fields: {
              value: {
                type: scalar,
                subscribe: async function* () {
                  try {
                    yield { value }
                    yield { value: "must not be emitted" }
                  } finally {
                    lifecycle.push("iterator")
                  }
                },
              },
            },
          }),
        })
        const events = await Effect.runPromise(
          makeSSESubscriptionStream(
            schema,
            layer,
            { query: "subscription { value }" },
            new Headers(),
            {
              onComplete: () =>
                Effect.map(Resource, (resource) => {
                  lifecycle.push(`complete:${resource}`)
                }),
            }
          ).pipe(Stream.runCollect)
        )

        expect(events.map((event) => event.event)).toEqual(["error", "complete"])
        expect(JSON.parse(events[0].data)).toEqual({
          errors: [
            {
              message: expect.any(String),
              extensions: { code: "SUBSCRIPTION_ERROR" },
            },
          ],
        })
        expect(lifecycle).toEqual(["iterator", "complete:open", "release"])
      }
    )
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
      expect(headersReceived).not.toBeNull()
      expect(headersReceived!.get("authorization")).toBe("Bearer token")
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

      // The iterator's return() method should be called when the stream is cancelled
      expect(iteratorCleanedUp).toBe(true)
    })

    it.each(["completion", "cancellation"])(
      "finalizes hooks before services on %s",
      async (mode) => {
        const lifecycle: string[] = []
        let open = false
        let releases = 0
        const Resource = Context.Service<{ readonly isOpen: () => boolean }>("sse/Resource")
        const layer = Layer.effect(
          Resource,
          Effect.acquireRelease(
            Effect.sync(() => {
              open = true
              return { isOpen: () => open }
            }),
            () =>
              Effect.sync(() => {
                open = false
                releases++
                lifecycle.push("release")
              })
          )
        )
        const schema = GraphQLSchemaBuilder.empty
          .query("hello", { type: S.String, resolve: () => Effect.succeed("world") })
          .subscription("open", {
            type: S.Boolean,
            subscribe: () =>
              Effect.succeed(
                Stream.fromEffect(Effect.map(Resource, (resource) => resource.isOpen()))
              ),
          })
          .buildSchema()
        let hookOpen = false
        const stream = makeSSESubscriptionStream(
          schema,
          layer,
          { query: "subscription { open }" },
          new Headers(),
          {
            onComplete: () => {
              lifecycle.push("construct")
              return Effect.map(Resource, (resource) => {
                lifecycle.push("effect")
                hookOpen = resource.isOpen()
              })
            },
          }
        )

        const observed = stream.pipe(
          Stream.tap((event) => Effect.sync(() => lifecycle.push(event.event)))
        )
        const events = await Effect.runPromise(
          (mode === "cancellation" ? observed.pipe(Stream.take(1)) : observed).pipe(
            Stream.runCollect
          )
        )

        expect(events).toEqual(
          mode === "cancellation"
            ? [formatNextEvent({ data: { open: true } })]
            : [formatNextEvent({ data: { open: true } }), formatCompleteEvent()]
        )
        expect(lifecycle).toEqual(
          mode === "cancellation"
            ? ["next", "construct", "effect", "release"]
            : ["next", "complete", "construct", "effect", "release"]
        )
        expect(hookOpen).toBe(true)
        expect(open).toBe(false)
        expect(releases).toBe(1)
      }
    )
  })

  describe("Integration with GraphQLSchemaBuilder", () => {
    it("isolates once-decoded args across operations sharing services and finalizes both streams", async () => {
      let defaults = 0
      let transforms = 0
      const finalized: number[] = []
      const completed: string[] = []
      const firstStarted = Effect.runSync(Deferred.make<void>())
      const emit = Effect.runSync(Deferred.make<void>())
      const Shared = Context.Service<{ readonly prefix: string }>("sse/SharedSubscription")
      const shared = { prefix: "shared" }
      const args = S.Struct({
        token: S.NumberFromString.pipe(
          S.decodeTo(S.Number, {
            decode: SchemaGetter.transform((value) => {
              transforms++
              return value + 10
            }),
            encode: SchemaGetter.transform((value) => value - 10),
          }),
          S.withDecodingDefault(Effect.sync(() => String(++defaults)))
        ),
      })
      const schema = GraphQLSchemaBuilder.empty
        .query("hello", { type: S.String, resolve: () => Effect.succeed("world") })
        .subscription("token", {
          type: S.String,
          args,
          subscribe: ({ token }) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(token === 11 ? firstStarted : emit, undefined)
              return Stream.fromEffect(Deferred.await(emit).pipe(Effect.as("first"))).pipe(
                Stream.concat(Stream.make("second")),
                Stream.concat(token === 12 ? Stream.never : Stream.empty),
                Stream.ensuring(
                  Effect.sync(() => {
                    finalized.push(token)
                  })
                )
              )
            }),
          resolve: (event, { token }) =>
            Effect.map(Shared, ({ prefix }) => `${prefix}:${token}:${event}`),
        })
        .buildSchema()
      const tokenField = schema.getSubscriptionType()!.getFields().token
      const resolveToken = tokenField.resolve!
      tokenField.resolve = async (source, args, context, info) =>
        `${context.user.name}:${await resolveToken(source, args, context, info)}`
      const handler = makeGraphQLSSEHandler(schema, Layer.succeed(Shared, shared), {
        onConnect: () => Effect.succeed({ user: { name: "alice" }, services: "metadata" }),
        onComplete: () =>
          Effect.map(Shared, ({ prefix }) => {
            completed.push(prefix)
          }),
      })
      const request = { query: "subscription { token }" }
      const headers = new Headers()
      const [first, second] = await Effect.runPromise(
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(Stream.runCollect(handler(request, headers)))
          yield* Deferred.await(firstStarted)
          const second = yield* Effect.forkChild(
            handler(request, headers).pipe(Stream.take(2), Stream.runCollect)
          )
          return [Array.from(yield* Fiber.join(first)), Array.from(yield* Fiber.join(second))]
        }).pipe(Effect.timeout("2 seconds"))
      )

      expect(first).toEqual([
        formatNextEvent({ data: { token: "alice:shared:11:first" } }),
        formatNextEvent({ data: { token: "alice:shared:11:second" } }),
        formatCompleteEvent(),
      ])
      expect(second).toEqual([
        formatNextEvent({ data: { token: "alice:shared:12:first" } }),
        formatNextEvent({ data: { token: "alice:shared:12:second" } }),
      ])
      expect(defaults).toBe(2)
      expect(transforms).toBe(2)
      expect(finalized.sort()).toEqual([11, 12])
      expect(completed).toEqual(["shared", "shared"])
    })

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
