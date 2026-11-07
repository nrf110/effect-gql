import { describe, it, expect, vi } from "vitest"
import { EventEmitter } from "node:events"
import { Effect, Layer, Stream, Queue, Deferred, Fiber, Context, References } from "effect"
import * as S from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLInt,
  GraphQLNonNull,
} from "graphql"
import * as GraphqlWs from "graphql-ws"
import { makeGraphQLWSHandler } from "../../../src/server/ws-adapter"
import { toEffectWebSocketFromWs, type WsWebSocket } from "../../../src/server/ws-utils"
import { WebSocketError, type EffectWebSocket, type CloseEvent } from "../../../src/server/ws-types"
import { GraphQLSchemaBuilder } from "../../../src/builder"

/**
 * Create a mock EffectWebSocket for testing
 */
const createMockSocket = () => {
  const messageQueue = Effect.runSync(Queue.unbounded<string>())
  const closedDeferred = Effect.runSync(Deferred.make<CloseEvent, WebSocketError>())
  const acknowledged = Effect.runSync(Deferred.make<void>())
  const sentMessages: string[] = []
  const closeInfo = {
    code: undefined as number | undefined,
    reason: undefined as string | undefined,
  }

  const socket: EffectWebSocket = {
    protocol: "graphql-transport-ws",
    send: (data: string) =>
      Effect.gen(function* () {
        sentMessages.push(data)
        if (JSON.parse(data).type === "connection_ack") {
          yield* Deferred.succeed(acknowledged, undefined)
        }
      }),
    close: (code?: number, reason?: string) =>
      Effect.sync(() => {
        closeInfo.code = code
        closeInfo.reason = reason
      }),
    messages: Stream.fromQueue(messageQueue),
    closed: Deferred.await(closedDeferred),
  }

  return {
    socket,
    messageQueue,
    closedDeferred,
    sentMessages,
    closeInfo,
    waitForAck: () =>
      Effect.runPromise(Deferred.await(acknowledged).pipe(Effect.timeout("2 seconds"))),
    // Helper to simulate incoming message
    sendMessage: (msg: string) => Effect.runSync(Queue.offer(messageQueue, msg)),
    // Helper to simulate connection close
    closeConnection: (code: number, reason: string) =>
      Effect.runSync(Deferred.succeed(closedDeferred, { code, reason })),
  }
}

// Simple test schema with subscriptions
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
        hello: {
          type: GraphQLString,
          resolve: () => "world",
        },
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

describe("ws-adapter.ts", () => {
  describe("makeGraphQLWSHandler", () => {
    it("should create a handler function", () => {
      const schema = createTestSchema()
      const handler = makeGraphQLWSHandler(schema, Layer.empty)

      expect(typeof handler).toBe("function")
    })

    it("should return an Effect that handles a WebSocket connection", async () => {
      const schema = createTestSchema()
      const handler = makeGraphQLWSHandler(schema, Layer.empty)
      const { socket, closeConnection } = createMockSocket()

      // Run handler in background
      const fiber = Effect.runFork(handler(socket))

      // Allow handler to start
      await new Promise((r) => setTimeout(r, 10))

      // Close the connection
      closeConnection(1000, "Normal closure")

      // Wait for handler to complete
      await Effect.runPromise(Fiber.join(fiber))
    })

    it("should send messages through the socket", async () => {
      const schema = createTestSchema()
      const handler = makeGraphQLWSHandler(schema, Layer.empty)
      const { socket, sentMessages, closeConnection, sendMessage } = createMockSocket()

      // Run handler in background
      const fiber = Effect.runFork(handler(socket))

      // Allow handler to initialize
      await new Promise((r) => setTimeout(r, 10))

      // Send CONNECTION_INIT message (graphql-ws protocol)
      sendMessage(JSON.stringify({ type: "connection_init" }))

      // Allow message processing
      await new Promise((r) => setTimeout(r, 50))

      // Should have received CONNECTION_ACK
      const ackMessage = sentMessages.find((m) => {
        try {
          return JSON.parse(m).type === "connection_ack"
        } catch {
          return false
        }
      })
      expect(ackMessage).toBeDefined()

      // Close connection
      closeConnection(1000, "Done")
      await Effect.runPromise(Fiber.join(fiber))
    })

    it("should handle malformed messages gracefully", async () => {
      const schema = createTestSchema()
      const handler = makeGraphQLWSHandler(schema, Layer.empty)
      const { socket, closeConnection, sendMessage } = createMockSocket()

      const fiber = Effect.runFork(handler(socket))

      await new Promise((r) => setTimeout(r, 10))

      // Send malformed message
      sendMessage("not valid json")

      await new Promise((r) => setTimeout(r, 50))

      // Handler should not crash
      closeConnection(1000, "Done")
      await Effect.runPromise(Fiber.join(fiber))
    })
  })

  describe("onConnect hook", () => {
    it("should call onConnect with connection params", async () => {
      const schema = createTestSchema()
      let connectCalled = false
      let receivedParams: Record<string, unknown> = {}

      const handler = makeGraphQLWSHandler(schema, Layer.empty, {
        onConnect: (params) => {
          connectCalled = true
          receivedParams = params
          return Effect.succeed(true)
        },
      })

      const { socket, sendMessage, closeConnection } = createMockSocket()
      const fiber = Effect.runFork(handler(socket))

      await new Promise((r) => setTimeout(r, 10))

      // Send CONNECTION_INIT with params
      sendMessage(
        JSON.stringify({
          type: "connection_init",
          payload: { authToken: "secret123" },
        })
      )

      await new Promise((r) => setTimeout(r, 50))

      expect(connectCalled).toBe(true)
      expect(receivedParams.authToken).toBe("secret123")

      closeConnection(1000, "Done")
      await Effect.runPromise(Fiber.join(fiber))
    })

    it("should reject connection when onConnect returns false", async () => {
      const schema = createTestSchema()

      const handler = makeGraphQLWSHandler(schema, Layer.empty, {
        onConnect: () => Effect.succeed(false),
      })

      const { socket, sendMessage, sentMessages, closeConnection } = createMockSocket()
      const fiber = Effect.runFork(handler(socket))

      await new Promise((r) => setTimeout(r, 10))

      sendMessage(JSON.stringify({ type: "connection_init" }))

      await new Promise((r) => setTimeout(r, 50))

      // Should not have sent connection_ack
      const hasAck = sentMessages.some((m) => {
        try {
          return JSON.parse(m).type === "connection_ack"
        } catch {
          return false
        }
      })
      expect(hasAck).toBe(false)

      closeConnection(1000, "Done")
      await Effect.runPromise(Fiber.join(fiber))
    })

    it("should reject connection when onConnect throws", async () => {
      const schema = createTestSchema()

      const handler = makeGraphQLWSHandler(schema, Layer.empty, {
        onConnect: () => Effect.fail(new Error("Auth failed")),
      })

      const { socket, sendMessage, sentMessages, closeConnection } = createMockSocket()
      const fiber = Effect.runFork(handler(socket))

      await new Promise((r) => setTimeout(r, 10))

      sendMessage(JSON.stringify({ type: "connection_init" }))

      await new Promise((r) => setTimeout(r, 50))

      // Should not have sent connection_ack
      const hasAck = sentMessages.some((m) => {
        try {
          return JSON.parse(m).type === "connection_ack"
        } catch {
          return false
        }
      })
      expect(hasAck).toBe(false)

      closeConnection(1000, "Done")
      await Effect.runPromise(Fiber.join(fiber))
    })

    it("should merge onConnect result into connection context", async () => {
      const schema = createTestSchema()
      let subscribeContext: Record<string, unknown> = {}

      const handler = makeGraphQLWSHandler(schema, Layer.empty, {
        onConnect: () => Effect.succeed({ userId: "user-123", role: "admin" }),
        onSubscribe: (ctx) => {
          subscribeContext = ctx.connectionParams
          return Effect.void
        },
      })

      const { socket, sendMessage, closeConnection } = createMockSocket()
      const fiber = Effect.runFork(handler(socket))

      await new Promise((r) => setTimeout(r, 10))

      // Initialize connection
      sendMessage(JSON.stringify({ type: "connection_init" }))
      await new Promise((r) => setTimeout(r, 50))

      // Subscribe to trigger onSubscribe hook
      sendMessage(
        JSON.stringify({
          id: "1",
          type: "subscribe",
          payload: { query: "subscription { tick { count } }" },
        })
      )
      await new Promise((r) => setTimeout(r, 50))

      expect(subscribeContext.userId).toBe("user-123")
      expect(subscribeContext.role).toBe("admin")

      closeConnection(1000, "Done")
      await Effect.runPromise(Fiber.join(fiber))
    })
  })

  describe("onDisconnect hook", () => {
    it("should call onDisconnect when connection closes", async () => {
      const schema = createTestSchema()
      let disconnectCalled = false

      const handler = makeGraphQLWSHandler(schema, Layer.empty, {
        onDisconnect: () => {
          disconnectCalled = true
          return Effect.void
        },
      })

      const { socket, sendMessage, closeConnection } = createMockSocket()
      const fiber = Effect.runFork(handler(socket))

      await new Promise((r) => setTimeout(r, 10))

      // Initialize connection first
      sendMessage(JSON.stringify({ type: "connection_init" }))
      await new Promise((r) => setTimeout(r, 50))

      // Close connection
      closeConnection(1000, "Normal closure")
      await Effect.runPromise(Fiber.join(fiber))

      // Give time for disconnect handler to run
      await new Promise((r) => setTimeout(r, 50))

      expect(disconnectCalled).toBe(true)
    })

    it("should not crash if onDisconnect throws", async () => {
      const schema = createTestSchema()

      const handler = makeGraphQLWSHandler(schema, Layer.empty, {
        onDisconnect: () =>
          Effect.sync(() => {
            throw new Error("Cleanup error")
          }).pipe(
            Effect.asVoid,
            Effect.catch(() => Effect.void)
          ),
      })

      const { socket, sendMessage, closeConnection } = createMockSocket()
      const fiber = Effect.runFork(handler(socket))

      await new Promise((r) => setTimeout(r, 10))

      sendMessage(JSON.stringify({ type: "connection_init" }))
      await new Promise((r) => setTimeout(r, 50))

      closeConnection(1000, "Normal closure")

      // Should complete without crashing
      await Effect.runPromise(Fiber.join(fiber))
    })
  })

  describe("onSubscribe hook", () => {
    it("should call onSubscribe for each subscription", async () => {
      const schema = createTestSchema()
      const subscriptions: { id: string; query: string }[] = []

      const handler = makeGraphQLWSHandler(schema, Layer.empty, {
        onSubscribe: (_ctx, msg) => {
          subscriptions.push({ id: msg.id, query: msg.payload.query })
          return Effect.void
        },
      })

      const { socket, sendMessage, closeConnection } = createMockSocket()
      const fiber = Effect.runFork(handler(socket))

      await new Promise((r) => setTimeout(r, 10))

      sendMessage(JSON.stringify({ type: "connection_init" }))
      await new Promise((r) => setTimeout(r, 50))

      sendMessage(
        JSON.stringify({
          id: "sub-1",
          type: "subscribe",
          payload: { query: "subscription { tick { count } }" },
        })
      )
      await new Promise((r) => setTimeout(r, 50))

      expect(subscriptions).toHaveLength(1)
      expect(subscriptions[0].id).toBe("sub-1")
      expect(subscriptions[0].query).toContain("tick")

      closeConnection(1000, "Done")
      await Effect.runPromise(Fiber.join(fiber))
    })

    it("should receive variables and operationName", async () => {
      const schema = createTestSchema()
      let receivedPayload: any = null

      const handler = makeGraphQLWSHandler(schema, Layer.empty, {
        onSubscribe: (_ctx, msg) => {
          receivedPayload = msg.payload
          return Effect.void
        },
      })

      const { socket, sendMessage, closeConnection } = createMockSocket()
      const fiber = Effect.runFork(handler(socket))

      await new Promise((r) => setTimeout(r, 10))

      sendMessage(JSON.stringify({ type: "connection_init" }))
      await new Promise((r) => setTimeout(r, 50))

      sendMessage(
        JSON.stringify({
          id: "sub-1",
          type: "subscribe",
          payload: {
            query: "subscription Tick { tick { count } }",
            operationName: "Tick",
            variables: { limit: 10 },
          },
        })
      )
      await new Promise((r) => setTimeout(r, 50))

      expect(receivedPayload).toBeDefined()
      expect(receivedPayload.operationName).toBe("Tick")
      expect(receivedPayload.variables).toEqual({ limit: 10 })

      closeConnection(1000, "Done")
      await Effect.runPromise(Fiber.join(fiber))
    })
  })

  describe("onComplete hook", () => {
    it("should register onComplete hook in handler options", async () => {
      const schema = createTestSchema()

      // The hook is registered when makeGraphQLWSHandler is called
      const handler = makeGraphQLWSHandler(schema, Layer.empty, {
        onComplete: () => Effect.void,
      })

      // Verify handler was created (hook is wired internally to graphql-ws)
      expect(typeof handler).toBe("function")

      const { socket, sendMessage, closeConnection } = createMockSocket()
      const fiber = Effect.runFork(handler(socket))

      await new Promise((r) => setTimeout(r, 10))

      // Initialize and subscribe
      sendMessage(JSON.stringify({ type: "connection_init" }))
      await new Promise((r) => setTimeout(r, 50))

      sendMessage(
        JSON.stringify({
          id: "sub-1",
          type: "subscribe",
          payload: { query: "subscription { tick { count } }" },
        })
      )
      await new Promise((r) => setTimeout(r, 50))

      // Send client-initiated complete
      sendMessage(JSON.stringify({ id: "sub-1", type: "complete" }))
      await new Promise((r) => setTimeout(r, 50))

      closeConnection(1000, "Done")
      await Effect.runPromise(Fiber.join(fiber))
    })
  })

  describe("onError hook", () => {
    it("should register onError hook in handler options", async () => {
      const schema = createTestSchema()

      // The hook is registered when makeGraphQLWSHandler is called
      const handler = makeGraphQLWSHandler(schema, Layer.empty, {
        onError: (_ctx, _) => {
          // This would be called if graphql-ws triggers an error
          return Effect.void
        },
      })

      // Verify handler was created with error hook wired
      expect(typeof handler).toBe("function")

      const { socket, sendMessage, closeConnection } = createMockSocket()
      const fiber = Effect.runFork(handler(socket))

      await new Promise((r) => setTimeout(r, 10))

      sendMessage(JSON.stringify({ type: "connection_init" }))
      await new Promise((r) => setTimeout(r, 50))

      // Subscribe to error-throwing subscription
      sendMessage(
        JSON.stringify({
          id: "sub-error",
          type: "subscribe",
          payload: { query: "subscription { error }" },
        })
      )
      await new Promise((r) => setTimeout(r, 100))

      // Note: Whether error hook is called depends on graphql-ws error handling
      // This test verifies the wiring is set up correctly

      closeConnection(1000, "Done")
      await Effect.runPromise(Fiber.join(fiber))
    })
  })

  describe("complexity validation", () => {
    it("should accept complexity config in handler options", async () => {
      const schema = createTestSchema()

      // Verify handler can be created with complexity config
      const handler = makeGraphQLWSHandler(schema, Layer.empty, {
        complexity: {
          maxDepth: 5,
          maxComplexity: 100,
          maxAliases: 10,
          maxFields: 50,
        },
      })

      expect(typeof handler).toBe("function")

      const { socket, closeConnection } = createMockSocket()
      const fiber = Effect.runFork(handler(socket))

      await new Promise((r) => setTimeout(r, 10))

      closeConnection(1000, "Done")
      await Effect.runPromise(Fiber.join(fiber))
    })

    it("should accept fieldComplexities config in handler options", async () => {
      const schema = createTestSchema()

      const fieldComplexities = new Map([["Subscription.tick", 10]])

      // Verify handler can be created with field complexities
      const handler = makeGraphQLWSHandler(schema, Layer.empty, {
        complexity: {
          maxComplexity: 100,
        },
        fieldComplexities,
      })

      expect(typeof handler).toBe("function")

      const { socket, closeConnection } = createMockSocket()
      const fiber = Effect.runFork(handler(socket))

      await new Promise((r) => setTimeout(r, 10))

      closeConnection(1000, "Done")
      await Effect.runPromise(Fiber.join(fiber))
    })
  })

  describe("cleanup on close", () => {
    it("should properly cleanup resources when connection closes", async () => {
      const schema = createTestSchema()
      const handler = makeGraphQLWSHandler(schema, Layer.empty)

      const { socket, sendMessage, closeConnection } = createMockSocket()
      const fiber = Effect.runFork(handler(socket))

      await new Promise((r) => setTimeout(r, 10))

      sendMessage(JSON.stringify({ type: "connection_init" }))
      await new Promise((r) => setTimeout(r, 50))

      // Start a subscription
      sendMessage(
        JSON.stringify({
          id: "sub-1",
          type: "subscribe",
          payload: { query: "subscription { tick { count } }" },
        })
      )
      await new Promise((r) => setTimeout(r, 50))

      // Close abruptly
      closeConnection(1001, "Going away")

      // Handler should complete without hanging
      const result = await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("2 seconds")))

      // Should complete successfully (undefined for void return)
      expect(result).toBeUndefined()
    })

    it("multiplexes subscriptions, queries and pings and cancels only the requested operation", async () => {
      let defaults = 0
      let released = 0
      const finalized: number[] = []
      const finalizedAtRelease: number[][] = []
      const firstCancelled = Effect.runSync(Deferred.make<void>())
      const secondFinalizing = Effect.runSync(Deferred.make<void>())
      const finishSecond = Effect.runSync(Deferred.make<void>())
      const schema = GraphQLSchemaBuilder.empty
        .query("hello", { type: S.String, resolve: () => Effect.succeed("world") })
        .subscription("token", {
          type: S.Number,
          args: S.Struct({
            value: S.Number.pipe(S.withDecodingDefault(Effect.sync(() => ++defaults))),
          }),
          subscribe: ({ value }) =>
            Effect.succeed(
              Stream.make(value).pipe(
                Stream.concat(Stream.never),
                Stream.ensuring(
                  Effect.gen(function* () {
                    if (value === 2) {
                      yield* Deferred.succeed(secondFinalizing, undefined)
                      yield* Deferred.await(finishSecond)
                    }
                    yield* Effect.promise(() => Promise.resolve())
                    finalized.push(value)
                    if (value === 1) yield* Deferred.succeed(firstCancelled, undefined)
                  })
                )
              )
            ),
        })
        .buildSchema()
      const layer = Layer.effectDiscard(
        Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            released++
            finalizedAtRelease.push([...finalized])
          })
        )
      )
      const mock = createMockSocket()
      const outgoing = Effect.runSync(
        Queue.unbounded<{ type: string; id?: string; payload?: unknown }>()
      )
      const socket: EffectWebSocket = {
        ...mock.socket,
        send: (data) =>
          mock.socket
            .send(data)
            .pipe(Effect.andThen(Queue.offer(outgoing, JSON.parse(data))), Effect.asVoid),
      }
      const nextMessage = () =>
        Effect.runPromise(Queue.take(outgoing).pipe(Effect.timeout("2 seconds")))
      const fiber = Effect.runFork(makeGraphQLWSHandler(schema, layer)(socket))
      try {
        mock.sendMessage(JSON.stringify({ type: "connection_init" }))
        expect(await nextMessage()).toEqual({ type: "connection_ack" })
        for (const [id, value] of [
          ["first", 1],
          ["second", 2],
        ] as const) {
          mock.sendMessage(
            JSON.stringify({ id, type: "subscribe", payload: { query: "subscription { token }" } })
          )
          expect(await nextMessage()).toEqual({
            id,
            type: "next",
            payload: { data: { token: value } },
          })
        }
        expect(defaults).toBe(2)
        expect(finalized).toEqual([])

        mock.sendMessage(
          JSON.stringify({ id: "query", type: "subscribe", payload: { query: "{ hello }" } })
        )
        expect(await nextMessage()).toEqual({
          id: "query",
          type: "next",
          payload: { data: { hello: "world" } },
        })
        expect(await nextMessage()).toEqual({ id: "query", type: "complete" })

        mock.sendMessage(JSON.stringify({ id: "first", type: "complete" }))
        await Effect.runPromise(Deferred.await(firstCancelled).pipe(Effect.timeout("2 seconds")))
        expect(finalized).toEqual([1])
        expect(released).toBe(0)

        mock.sendMessage(JSON.stringify({ type: "ping", payload: { nonce: 42 } }))
        expect(await nextMessage()).toEqual({ type: "pong", payload: { nonce: 42 } })
        mock.closeConnection(1000, "Done")
        await Effect.runPromise(Deferred.await(secondFinalizing).pipe(Effect.timeout("2 seconds")))
        expect(finalized).toEqual([1])
        expect(released).toBe(0)
        Effect.runSync(Deferred.succeed(finishSecond, undefined))
        await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("2 seconds")))
        expect(finalized).toEqual([1, 2])
        expect(finalizedAtRelease).toEqual([[1, 2]])
        expect(released).toBe(1)
      } finally {
        Effect.runSync(Deferred.succeed(finishSecond, undefined))
        mock.closeConnection(1000, "Done")
        await Effect.runPromise(Fiber.interrupt(fiber))
      }
    })

    it.each(["hook", "source"] as const)(
      "cancels immediately during %s setup without consuming the late iterator or closing the connection",
      async (phase) => {
        const started = Effect.runSync(Deferred.make<void>())
        const finishSetup = Effect.runSync(Deferred.make<void>())
        const completed = Effect.runSync(Deferred.make<void>())
        const returning = Effect.runSync(Deferred.make<void>())
        const finishReturn = Effect.runSync(Deferred.make<void>())
        const returned = Effect.runSync(Deferred.make<void>())
        let released = 0
        const setup = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(finishSetup))
        )
        const next = vi.fn(async () => {
          throw new Error("An immediately cancelled subscription must not be consumed")
        })
        const returnSource = vi.fn(async () => {
          Effect.runSync(Deferred.succeed(returning, undefined))
          await Effect.runPromise(Deferred.await(finishReturn))
          Effect.runSync(Deferred.succeed(returned, undefined))
          return { done: true as const, value: undefined }
        })
        const schema = createTestSchema()
        schema.getSubscriptionType()!.getFields().tick.subscribe = async () => {
          if (phase === "source") await Effect.runPromise(setup)
          return {
            [Symbol.asyncIterator]() {
              return this
            },
            next,
            return: returnSource,
          }
        }
        const layer = Layer.effectDiscard(
          Effect.acquireRelease(Effect.void, () =>
            Effect.sync(() => {
              released++
            })
          )
        )
        const mock = createMockSocket()
        const outgoing = Effect.runSync(
          Queue.unbounded<{ type: string; id?: string; payload?: unknown }>()
        )
        const socket: EffectWebSocket = {
          ...mock.socket,
          send: (data) =>
            mock.socket
              .send(data)
              .pipe(Effect.andThen(Queue.offer(outgoing, JSON.parse(data))), Effect.asVoid),
        }
        const nextMessage = () =>
          Effect.runPromise(Queue.take(outgoing).pipe(Effect.timeout("2 seconds")))
        const fiber = Effect.runFork(
          makeGraphQLWSHandler(schema, layer, {
            onSubscribe: (_ctx, { id }) =>
              id === "cancelled" && phase === "hook" ? setup : Effect.void,
            onComplete: (_ctx, { id }) =>
              id === "cancelled"
                ? Deferred.succeed(completed, undefined).pipe(Effect.asVoid)
                : Effect.void,
          })(socket)
        )
        try {
          mock.sendMessage(JSON.stringify({ type: "connection_init" }))
          expect(await nextMessage()).toEqual({ type: "connection_ack" })
          mock.sendMessage(
            JSON.stringify({
              id: "cancelled",
              type: "subscribe",
              payload: { query: "subscription { tick { count } }" },
            })
          )
          await Effect.runPromise(Deferred.await(started).pipe(Effect.timeout("2 seconds")))
          mock.sendMessage(JSON.stringify({ id: "cancelled", type: "complete" }))
          // Complete deletes the reserved ID synchronously; a subsequent pong
          // proves cancellation was dispatched before setup is allowed to finish.
          mock.sendMessage(JSON.stringify({ type: "ping", payload: { barrier: "cancelled" } }))
          expect(await nextMessage()).toEqual({ type: "pong", payload: { barrier: "cancelled" } })

          Effect.runSync(Deferred.succeed(finishSetup, undefined))
          await Effect.runPromise(Deferred.await(returning).pipe(Effect.timeout("2 seconds")))
          await Effect.runPromise(Deferred.await(completed).pipe(Effect.timeout("2 seconds")))
          expect(next).not.toHaveBeenCalled()
          expect(returnSource).toHaveBeenCalledTimes(1)
          expect(released).toBe(0)

          mock.sendMessage(
            JSON.stringify({ id: "live", type: "subscribe", payload: { query: "{ hello }" } })
          )
          expect(await nextMessage()).toEqual({
            id: "live",
            type: "next",
            payload: { data: { hello: "world" } },
          })
          expect(await nextMessage()).toEqual({ id: "live", type: "complete" })
          Effect.runSync(Deferred.succeed(finishReturn, undefined))
          await Effect.runPromise(Deferred.await(returned).pipe(Effect.timeout("2 seconds")))
          expect(released).toBe(0)
          mock.closeConnection(1000, "Done")
          await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("2 seconds")))
          expect(next).not.toHaveBeenCalled()
          expect(returnSource).toHaveBeenCalledTimes(1)
          expect(released).toBe(1)
          expect(mock.closeInfo).toEqual({ code: undefined, reason: undefined })
          expect(mock.sentMessages.map((message) => JSON.parse(message))).toEqual([
            { type: "connection_ack" },
            { type: "pong", payload: { barrier: "cancelled" } },
            { id: "live", type: "next", payload: { data: { hello: "world" } } },
            { id: "live", type: "complete" },
          ])
        } finally {
          Effect.runSync(Deferred.succeed(finishSetup, undefined))
          Effect.runSync(Deferred.succeed(finishReturn, undefined))
          mock.closeConnection(1000, "Done")
          await Effect.runPromise(Fiber.interrupt(fiber))
        }
      }
    )

    it.each([
      ["hook", "complete"],
      ["source", "complete"],
      ["hook", "close"],
      ["source", "close"],
    ] as const)(
      "isolates reused IDs during %s setup and cleans up the replacement on %s",
      async (phase, termination) => {
        const started = Effect.runSync(Deferred.make<void>())
        const finishSetup = Effect.runSync(Deferred.make<void>())
        const oldReturning = Effect.runSync(Deferred.make<void>())
        const finishOldReturn = Effect.runSync(Deferred.make<void>())
        const liveReturning = Effect.runSync(Deferred.make<void>())
        const finishLiveReturn = Effect.runSync(Deferred.make<void>())
        const liveReturned = Effect.runSync(Deferred.make<void>())
        const disconnected = Effect.runSync(Deferred.make<void>())
        let released = 0
        let liveClosed = false
        let liveReads = 0
        let finishLiveNext: ((result: IteratorResult<unknown>) => void) | undefined
        const setup = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(finishSetup))
        )
        const oldNext = vi.fn(async () => {
          throw new Error("The cancelled operation must not consume its source")
        })
        const oldReturn = vi.fn(async () => {
          Effect.runSync(Deferred.succeed(oldReturning, undefined))
          await Effect.runPromise(Deferred.await(finishOldReturn))
          return { done: true as const, value: undefined }
        })
        const liveReturn = vi.fn(async () => {
          liveClosed = true
          finishLiveNext?.({ done: true, value: undefined })
          Effect.runSync(Deferred.succeed(liveReturning, undefined))
          await Effect.runPromise(Deferred.await(finishLiveReturn))
          Effect.runSync(Deferred.succeed(liveReturned, undefined))
          return { done: true as const, value: undefined }
        })
        const schema = createTestSchema()
        schema.getSubscriptionType()!.getFields().tick.subscribe = async (
          _root,
          _args,
          _context,
          info
        ) => {
          const old = info.operation.name?.value === "Old"
          if (old && phase === "source") await Effect.runPromise(setup)
          return {
            [Symbol.asyncIterator]() {
              return this
            },
            next: old
              ? oldNext
              : () => {
                  if (liveClosed) return Promise.resolve({ done: true as const, value: undefined })
                  if (liveReads++ === 0) {
                    return Promise.resolve({ done: false as const, value: { tick: { count: 2 } } })
                  }
                  return new Promise<IteratorResult<unknown>>((resolve) => {
                    finishLiveNext = resolve
                  })
                },
            return: old ? oldReturn : liveReturn,
          }
        }
        const layer = Layer.effectDiscard(
          Effect.acquireRelease(Effect.void, () =>
            Effect.sync(() => {
              released++
            })
          )
        )
        const mock = createMockSocket()
        const outgoing = Effect.runSync(
          Queue.unbounded<{ type: string; id?: string; payload?: unknown }>()
        )
        const socket: EffectWebSocket = {
          ...mock.socket,
          send: (data) =>
            mock.socket
              .send(data)
              .pipe(Effect.andThen(Queue.offer(outgoing, JSON.parse(data))), Effect.asVoid),
        }
        const nextMessage = () =>
          Effect.runPromise(Queue.take(outgoing).pipe(Effect.timeout("2 seconds")))
        const fiber = Effect.runFork(
          makeGraphQLWSHandler(schema, layer, {
            onSubscribe: (_ctx, { payload }) =>
              phase === "hook" && payload.operationName === "Old" ? setup : Effect.void,
            onDisconnect: () => Deferred.succeed(disconnected, undefined).pipe(Effect.asVoid),
          })(socket)
        )
        try {
          mock.sendMessage(JSON.stringify({ type: "connection_init" }))
          expect(await nextMessage()).toEqual({ type: "connection_ack" })
          mock.sendMessage(
            JSON.stringify({
              id: "same",
              type: "subscribe",
              payload: { query: "subscription Old { tick { count } }", operationName: "Old" },
            })
          )
          await Effect.runPromise(Deferred.await(started).pipe(Effect.timeout("2 seconds")))
          mock.sendMessage(JSON.stringify({ id: "same", type: "complete" }))
          mock.sendMessage(
            JSON.stringify({
              id: "same",
              type: "subscribe",
              payload: { query: "subscription Live { tick { count } }", operationName: "Live" },
            })
          )
          mock.sendMessage(JSON.stringify({ type: "ping", payload: { barrier: "queued" } }))
          expect(await nextMessage()).toEqual({ type: "pong", payload: { barrier: "queued" } })
          mock.sendMessage(
            JSON.stringify({ id: "query", type: "subscribe", payload: { query: "{ hello }" } })
          )
          expect(await nextMessage()).toEqual({
            id: "query",
            type: "next",
            payload: { data: { hello: "world" } },
          })
          expect(await nextMessage()).toEqual({ id: "query", type: "complete" })

          Effect.runSync(Deferred.succeed(finishSetup, undefined))
          await Effect.runPromise(Deferred.await(oldReturning).pipe(Effect.timeout("2 seconds")))
          expect(await nextMessage()).toEqual({
            id: "same",
            type: "next",
            payload: { data: { tick: { count: 2 } } },
          })
          if (termination === "complete") {
            mock.sendMessage(JSON.stringify({ id: "same", type: "complete" }))
          } else {
            mock.closeConnection(1000, "Done")
          }
          await Effect.runPromise(Deferred.await(liveReturning).pipe(Effect.timeout("2 seconds")))
          expect(released).toBe(0)
          Effect.runSync(Deferred.succeed(finishLiveReturn, undefined))
          await Effect.runPromise(Deferred.await(liveReturned).pipe(Effect.timeout("2 seconds")))
          if (termination === "complete") {
            mock.sendMessage(JSON.stringify({ type: "ping", payload: { barrier: "cancelled" } }))
            expect(await nextMessage()).toEqual({ type: "pong", payload: { barrier: "cancelled" } })
            mock.closeConnection(1000, "Done")
          }
          await Effect.runPromise(Deferred.await(disconnected).pipe(Effect.timeout("2 seconds")))
          expect(released).toBe(0)
          Effect.runSync(Deferred.succeed(finishOldReturn, undefined))
          await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("2 seconds")))
          expect(oldNext).not.toHaveBeenCalled()
          expect(oldReturn).toHaveBeenCalledTimes(1)
          expect(liveReturn).toHaveBeenCalledTimes(1)
          expect(released).toBe(1)
          expect(
            mock.sentMessages
              .map((message) => JSON.parse(message))
              .filter(({ id }) => id === "same")
          ).toEqual([{ id: "same", type: "next", payload: { data: { tick: { count: 2 } } } }])
        } finally {
          Effect.runSync(Deferred.succeed(finishSetup, undefined))
          Effect.runSync(Deferred.succeed(finishOldReturn, undefined))
          Effect.runSync(Deferred.succeed(finishLiveReturn, undefined))
          liveClosed = true
          finishLiveNext?.({ done: true, value: undefined })
          mock.closeConnection(1000, "Done")
          await Effect.runPromise(Fiber.interrupt(fiber))
        }
      }
    )

    it.each(["cancel", "reject", "close", "duplicate", "malformed", "reinitialize"] as const)(
      "handles %s while an ID replacement is queued",
      async (action) => {
        const started = Effect.runSync(Deferred.make<void>())
        const finishSetup = Effect.runSync(Deferred.make<void>())
        const oldReturned = Effect.runSync(Deferred.make<void>())
        const disconnected = Effect.runSync(Deferred.make<void>())
        const protocolClosed = Effect.runSync(Deferred.make<void>())
        const hooks: string[] = []
        const sources: string[] = []
        const reads: string[] = []
        let oldReturns = 0
        let released = 0
        const schema = createTestSchema()
        schema.getSubscriptionType()!.getFields().tick.subscribe = (
          _root,
          _args,
          _context,
          info
        ) => {
          const name = info.operation.name!.value
          sources.push(name)
          let emitted = false
          return {
            [Symbol.asyncIterator]() {
              return this
            },
            next: async () => {
              reads.push(name)
              if (name === "Live" && !emitted) {
                emitted = true
                return { done: false as const, value: { tick: { count: 3 } } }
              }
              return { done: true as const, value: undefined }
            },
            return: async () => {
              if (name === "Old") {
                oldReturns++
                Effect.runSync(Deferred.succeed(oldReturned, undefined))
              }
              return { done: true as const, value: undefined }
            },
          }
        }
        const mock = createMockSocket()
        const outgoing = Effect.runSync(
          Queue.unbounded<{ type: string; id?: string; payload?: unknown }>()
        )
        const socket: EffectWebSocket = {
          ...mock.socket,
          send: (data) =>
            mock.socket
              .send(data)
              .pipe(Effect.andThen(Queue.offer(outgoing, JSON.parse(data))), Effect.asVoid),
          close: (code, reason) =>
            mock.socket
              .close(code, reason)
              .pipe(Effect.andThen(Deferred.succeed(protocolClosed, undefined)), Effect.asVoid),
        }
        const nextMessage = () =>
          Effect.runPromise(Queue.take(outgoing).pipe(Effect.timeout("2 seconds")))
        const layer = Layer.effectDiscard(
          Effect.acquireRelease(Effect.void, () =>
            Effect.sync(() => {
              released++
            })
          )
        )
        const fiber = Effect.runFork(
          makeGraphQLWSHandler(schema, layer, {
            onSubscribe: (_ctx, { payload }) =>
              Effect.gen(function* () {
                hooks.push(payload.operationName!)
                if (payload.operationName === "Old") {
                  yield* Deferred.succeed(started, undefined)
                  yield* Deferred.await(finishSetup)
                  if (action === "reject") return yield* Effect.fail(new Error("Expected failure"))
                }
              }),
            onDisconnect: () => Deferred.succeed(disconnected, undefined).pipe(Effect.asVoid),
          })(socket)
        )
        const subscribe = (name: string) =>
          mock.sendMessage(
            JSON.stringify({
              id: "same",
              type: "subscribe",
              payload: { query: `subscription ${name} { tick { count } }`, operationName: name },
            })
          )
        try {
          mock.sendMessage(JSON.stringify({ type: "connection_init" }))
          expect(await nextMessage()).toEqual({ type: "connection_ack" })
          subscribe("Old")
          await Effect.runPromise(Deferred.await(started).pipe(Effect.timeout("2 seconds")))
          mock.sendMessage(JSON.stringify({ id: "same", type: "complete" }))
          subscribe("Discarded")
          const live = action === "cancel" || action === "reject"
          if (live) {
            mock.sendMessage(JSON.stringify({ id: "same", type: "complete" }))
            subscribe("Live")
            mock.sendMessage(JSON.stringify({ type: "ping", payload: { barrier: "queued" } }))
            expect(await nextMessage()).toEqual({ type: "pong", payload: { barrier: "queued" } })
          } else {
            if (action === "duplicate") subscribe("Discarded")
            if (action === "malformed") {
              mock.sendMessage(JSON.stringify({ id: "same", type: "subscribe", payload: {} }))
            }
            if (action === "reinitialize") {
              mock.sendMessage(JSON.stringify({ type: "connection_init" }))
            }
            if (action !== "close") {
              await Effect.runPromise(
                Deferred.await(protocolClosed).pipe(Effect.timeout("2 seconds"))
              )
              expect(mock.closeInfo).toEqual(
                action === "duplicate"
                  ? { code: 4409, reason: "Subscriber for same already exists" }
                  : action === "malformed"
                    ? { code: 4400, reason: "Invalid message received" }
                    : { code: 4429, reason: "Too many initialisation requests" }
              )
              mock.sendMessage(
                JSON.stringify({
                  id: "fresh",
                  type: "subscribe",
                  payload: {
                    query: "subscription Fresh { tick { count } }",
                    operationName: "Fresh",
                  },
                })
              )
              mock.sendMessage(JSON.stringify({ type: "ping" }))
            }
            if (action === "close") {
              mock.closeConnection(1000, "Done")
              await Effect.runPromise(
                Deferred.await(disconnected).pipe(Effect.timeout("2 seconds"))
              )
            }
          }
          expect(hooks).toEqual(["Old"])
          expect(sources).toEqual([])
          if (action !== "close") expect(released).toBe(0)
          Effect.runSync(Deferred.succeed(finishSetup, undefined))
          if (live && action !== "reject") {
            await Effect.runPromise(Deferred.await(oldReturned).pipe(Effect.timeout("2 seconds")))
          }
          if (live) {
            expect(await nextMessage()).toEqual({
              id: "same",
              type: "next",
              payload: { data: { tick: { count: 3 } } },
            })
            expect(await nextMessage()).toEqual({ id: "same", type: "complete" })
            expect(released).toBe(0)
            mock.closeConnection(1000, "Done")
          }
          if (!live && action !== "close") {
            // Drain the native Promise continuations while socket.closed is
            // still pending: neither the deferred replacement nor sends may start.
            await new Promise<void>((resolve) => setImmediate(resolve))
            expect(hooks).toEqual(["Old"])
            expect(sources).toEqual([])
            expect(reads).toEqual([])
            expect(mock.sentMessages.map((message) => JSON.parse(message))).toEqual([
              { type: "connection_ack" },
            ])
            expect(released).toBe(0)
            mock.closeConnection(1000, "Done")
          }
          await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("2 seconds")))
          expect(hooks).toEqual(live ? ["Old", "Live"] : ["Old"])
          expect(sources).toEqual(action === "reject" ? ["Live"] : live ? ["Old", "Live"] : [])
          expect(reads).toEqual(live ? ["Live", "Live"] : [])
          expect(oldReturns).toBe(live && action !== "reject" ? 1 : 0)
          expect(released).toBe(1)
          expect(
            mock.sentMessages
              .map((message) => JSON.parse(message))
              .filter(({ id }) => id === "same")
          ).toEqual(
            live
              ? [
                  { id: "same", type: "next", payload: { data: { tick: { count: 3 } } } },
                  { id: "same", type: "complete" },
                ]
              : []
          )
        } finally {
          Effect.runSync(Deferred.succeed(finishSetup, undefined))
          mock.closeConnection(1000, "Done")
          await Effect.runPromise(Fiber.interrupt(fiber))
        }
      }
    )

    it("delivers replacement results to a graphql-ws client reusing an ID after a blocked error send", async () => {
      const finishError = Effect.runSync(Deferred.make<void>())
      const receivedError = Effect.runSync(Deferred.make<void>())
      const liveSent = Effect.runSync(Deferred.make<void>())
      const pong = Effect.runSync(Deferred.make<void>())
      const completed = Effect.runSync(Deferred.make<void>())
      const mock = createMockSocket()
      const sources: string[] = []
      const values: unknown[] = []
      const oldErrors: unknown[] = []
      const failures: unknown[] = []
      const schema = createTestSchema()
      schema.getSubscriptionType()!.getFields().tick.subscribe = async function* (
        _root,
        _args,
        _context,
        info
      ) {
        const name = info.operation.name!.value
        sources.push(name)
        if (name === "Old") throw new Error("Expected source failure")
        yield { tick: { count: 3 } }
      }
      let connection:
        | {
            receive: (data: string) => void
            close: (code?: number, reason?: string) => void
          }
        | undefined
      class ClientSocket {
        static CONNECTING = 0
        static OPEN = 1
        static CLOSING = 2
        static CLOSED = 3
        readyState = ClientSocket.CONNECTING
        onopen: (() => void) | null = null
        onmessage: ((event: { data: string }) => void) | null = null
        onclose: ((event: CloseEvent) => void) | null = null
        onerror: ((error: unknown) => void) | null = null

        constructor() {
          connection = {
            receive: (data) => this.onmessage?.({ data }),
            close: (code, reason) => this.close(code, reason),
          }
          queueMicrotask(() => {
            this.readyState = ClientSocket.OPEN
            this.onopen?.()
          })
        }

        send(data: string) {
          mock.sendMessage(data)
          if (JSON.parse(data).payload?.operationName === "Live") {
            Effect.runSync(Deferred.succeed(liveSent, undefined))
          }
        }

        close(code = 1000, reason = "") {
          if (this.readyState === ClientSocket.CLOSED) return
          this.readyState = ClientSocket.CLOSED
          mock.closeConnection(code, reason)
          this.onclose?.({ code, reason })
        }
      }
      const socket: EffectWebSocket = {
        ...mock.socket,
        send: (data) =>
          Effect.gen(function* () {
            yield* mock.socket.send(data)
            connection?.receive(data)
            if (JSON.parse(data).type === "error") yield* Deferred.await(finishError)
          }),
        close: (code, reason) => Effect.sync(() => connection?.close(code, reason)),
      }
      const fiber = Effect.runFork(makeGraphQLWSHandler(schema, Layer.empty)(socket))
      const client = GraphqlWs.createClient({
        url: "ws://in-memory",
        webSocketImpl: ClientSocket,
        lazy: false,
        retryAttempts: 0,
        generateID: () => "same",
        onNonLazyError: (error) => failures.push(error),
        on: {
          pong: () => {
            Effect.runSync(Deferred.succeed(pong, undefined))
          },
        },
      })
      try {
        client.subscribe(
          { query: "subscription Old { tick { count } }", operationName: "Old" },
          {
            next: (value) => failures.push(value),
            error: (error) => {
              oldErrors.push(error)
              Effect.runSync(Deferred.succeed(receivedError, undefined))
            },
            complete: () => failures.push("Old unexpectedly completed"),
          }
        )
        await Effect.runPromise(Deferred.await(receivedError).pipe(Effect.timeout("2 seconds")))
        expect(oldErrors).toEqual([
          [expect.objectContaining({ message: "Expected source failure" })],
        ])
        client.subscribe(
          { query: "subscription Live { tick { count } }", operationName: "Live" },
          {
            next: (value) => values.push(value),
            error: (error) => {
              failures.push(error)
              Effect.runSync(Deferred.succeed(completed, undefined))
            },
            complete: () => {
              Effect.runSync(Deferred.succeed(completed, undefined))
            },
          }
        )
        await Effect.runPromise(Deferred.await(liveSent).pipe(Effect.timeout("2 seconds")))
        mock.sendMessage(JSON.stringify({ type: "ping" }))
        await Effect.runPromise(Deferred.await(pong).pipe(Effect.timeout("2 seconds")))
        expect(sources).toEqual(["Old"])
        Effect.runSync(Deferred.succeed(finishError, undefined))
        await Effect.runPromise(Deferred.await(completed).pipe(Effect.timeout("2 seconds")))
        expect(values).toEqual([{ data: { tick: { count: 3 } } }])
        expect(failures).toEqual([])
        expect(sources).toEqual(["Old", "Live"])
      } finally {
        Effect.runSync(Deferred.succeed(finishError, undefined))
        await client.dispose()
        connection?.close()
        mock.closeConnection(1000, "Done")
        await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("2 seconds")))
      }
    })

    it.each([
      ["complete", "replace"],
      ["validation-error", "replace"],
      ["source-error", "replace"],
      ["complete", "cancel-queued"],
      ["source-error", "cancel-queued"],
      ["complete", "cancel-current"],
      ["source-error", "cancel-current"],
      ["complete", "duplicate"],
      ["source-error", "duplicate"],
    ] as const)(
      "hands off an ID after %s delivery begins while handling %s",
      async (terminal, action) => {
        const finishTerminal = Effect.runSync(Deferred.make<void>())
        const protocolClosed = Effect.runSync(Deferred.make<void>())
        const hooks: string[] = []
        const sources: string[] = []
        const schema = createTestSchema()
        schema.getSubscriptionType()!.getFields().tick.subscribe = async function* (
          _root,
          _args,
          _context,
          info
        ) {
          const name = info.operation.name!.value
          sources.push(name)
          if (name === "Old") {
            if (terminal === "source-error") throw new Error("Expected terminal failure")
            return
          }
          yield { tick: { count: 3 } }
        }
        const mock = createMockSocket()
        const outgoing = Effect.runSync(
          Queue.unbounded<{ type: string; id?: string; payload?: unknown }>()
        )
        let terminalSends = 0
        const socket: EffectWebSocket = {
          ...mock.socket,
          send: (data) =>
            Effect.gen(function* () {
              const message = JSON.parse(data)
              yield* mock.socket.send(data)
              // Model a transport that exposes bytes before its send completes.
              yield* Queue.offer(outgoing, message)
              if (
                message.id === "same" &&
                (message.type === "complete" || message.type === "error")
              ) {
                terminalSends++
                if (terminalSends === 1) yield* Deferred.await(finishTerminal)
              }
            }),
          close: (code, reason) =>
            mock.socket
              .close(code, reason)
              .pipe(Effect.andThen(Deferred.succeed(protocolClosed, undefined)), Effect.asVoid),
        }
        const nextMessage = () =>
          Effect.runPromise(Queue.take(outgoing).pipe(Effect.timeout("2 seconds")))
        const fiber = Effect.runFork(
          makeGraphQLWSHandler(schema, Layer.empty, {
            onSubscribe: (_ctx, { id, payload }) =>
              Effect.sync(() => {
                if (id === "same") hooks.push(payload.operationName!)
              }),
          })(socket)
        )
        const subscribe = (name: string) =>
          mock.sendMessage(
            JSON.stringify({
              id: "same",
              type: "subscribe",
              payload: {
                query:
                  name === "Old" && terminal === "validation-error"
                    ? "query Old { missing }"
                    : `subscription ${name} { tick { count } }`,
                operationName: name,
              },
            })
          )
        const ping = async (barrier: string) => {
          mock.sendMessage(JSON.stringify({ type: "ping", payload: { barrier } }))
          expect(await nextMessage()).toEqual({ type: "pong", payload: { barrier } })
        }
        try {
          mock.sendMessage(JSON.stringify({ type: "connection_init" }))
          expect(await nextMessage()).toEqual({ type: "connection_ack" })
          subscribe("Old")
          const firstTerminal = await nextMessage()
          if (terminal === "complete") {
            expect(firstTerminal).toEqual({ id: "same", type: "complete" })
          } else {
            expect(firstTerminal).toMatchObject({
              id: "same",
              type: "error",
              payload: [{ message: expect.any(String) }],
            })
          }
          if (action === "cancel-current") {
            mock.sendMessage(JSON.stringify({ id: "same", type: "complete" }))
          }
          subscribe(action === "cancel-queued" ? "Discarded" : "Live")
          await ping("queued")
          mock.sendMessage(
            JSON.stringify({ id: "other", type: "subscribe", payload: { query: "{ hello }" } })
          )
          expect(await nextMessage()).toEqual({
            id: "other",
            type: "next",
            payload: { data: { hello: "world" } },
          })
          expect(await nextMessage()).toEqual({ id: "other", type: "complete" })
          if (action === "cancel-queued") {
            mock.sendMessage(JSON.stringify({ id: "same", type: "complete" }))
            subscribe("Live")
            await ping("latest")
          }
          expect(hooks).toEqual(["Old"])
          expect(mock.closeInfo.code).toBeUndefined()

          if (action === "duplicate") {
            // A queued replacement owns the ID even while the old send is blocked.
            subscribe("Duplicate")
            await Effect.runPromise(
              Deferred.await(protocolClosed).pipe(Effect.timeout("2 seconds"))
            )
            expect(mock.closeInfo).toEqual({
              code: 4409,
              reason: "Subscriber for same already exists",
            })
          }
          Effect.runSync(Deferred.succeed(finishTerminal, undefined))
          const replacementFrames = [
            { id: "same", type: "next", payload: { data: { tick: { count: 3 } } } },
            { id: "same", type: "complete" },
          ]
          if (action !== "duplicate") {
            expect(await nextMessage()).toEqual(replacementFrames[0])
            expect(await nextMessage()).toEqual(replacementFrames[1])
            expect(mock.closeInfo.code).toBeUndefined()
          }
          mock.closeConnection(1000, "Done")
          await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("2 seconds")))
          expect(hooks).toEqual(action === "duplicate" ? ["Old"] : ["Old", "Live"])
          expect(sources).toEqual(
            terminal === "validation-error"
              ? ["Live"]
              : action === "duplicate"
                ? ["Old"]
                : ["Old", "Live"]
          )
          expect(
            mock.sentMessages
              .map((message) => JSON.parse(message))
              .filter(({ id }) => id === "same")
          ).toEqual([firstTerminal, ...(action === "duplicate" ? [] : replacementFrames)])
        } finally {
          Effect.runSync(Deferred.succeed(finishTerminal, undefined))
          mock.closeConnection(1000, "Done")
          await Effect.runPromise(Fiber.interrupt(fiber))
        }
      }
    )

    it("drains every concurrent dispatch when one setup rejects and another creates a late iterator", async () => {
      const events: string[] = []
      const started = Effect.runSync(Queue.unbounded<string>())
      const finishPending = Effect.runSync(Deferred.make<void>())
      const finishRejecting = Effect.runSync(Deferred.make<void>())
      const rejected = Effect.runSync(Deferred.make<void>())
      const disconnected = Effect.runSync(Deferred.make<void>())
      const returning = Effect.runSync(Deferred.make<void>())
      const finishReturn = Effect.runSync(Deferred.make<void>())
      let released = false
      const schema = createTestSchema()
      schema.getSubscriptionType()!.getFields().tick.subscribe = async (
        _root,
        _args,
        _ctx,
        info
      ) => {
        const id = info.operation.name!.value
        Effect.runSync(Queue.offer(started, id))
        if (id === "pending") {
          await Effect.runPromise(Deferred.await(finishPending))
        } else {
          await Effect.runPromise(Deferred.await(finishRejecting))
          events.push("rejected")
          Effect.runSync(Deferred.succeed(rejected, undefined))
          throw new Error("Expected setup failure")
        }
        events.push(`source:${released}`)
        return {
          [Symbol.asyncIterator]() {
            return this
          },
          next: async () => {
            throw new Error("A closed subscription must not be consumed")
          },
          return: async () => {
            events.push(`return:start:${released}`)
            Effect.runSync(Deferred.succeed(returning, undefined))
            await Effect.runPromise(Deferred.await(finishReturn))
            events.push(`return:end:${released}`)
            return { done: true, value: undefined }
          },
        }
      }
      const layer = Layer.effectDiscard(
        Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            released = true
            events.push("released")
          })
        )
      )
      const mock = createMockSocket()
      const fiber = Effect.runFork(
        makeGraphQLWSHandler(schema, layer, {
          onDisconnect: () => Deferred.succeed(disconnected, undefined).pipe(Effect.asVoid),
        })(mock.socket)
      )
      try {
        mock.sendMessage(JSON.stringify({ type: "connection_init" }))
        await mock.waitForAck()
        for (const id of ["pending", "rejecting"]) {
          mock.sendMessage(
            JSON.stringify({
              id,
              type: "subscribe",
              payload: { query: `subscription ${id} { tick { count } }` },
            })
          )
          expect(
            await Effect.runPromise(Queue.take(started).pipe(Effect.timeout("2 seconds")))
          ).toBe(id)
        }
        mock.closeConnection(1000, "Done")
        await Effect.runPromise(Deferred.await(disconnected).pipe(Effect.timeout("2 seconds")))
        Effect.runSync(Deferred.succeed(finishRejecting, undefined))
        await Effect.runPromise(Deferred.await(rejected).pipe(Effect.timeout("2 seconds")))
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(events).toEqual(["rejected"])
        expect(released).toBe(false)

        Effect.runSync(Deferred.succeed(finishPending, undefined))
        await Effect.runPromise(Deferred.await(returning).pipe(Effect.timeout("2 seconds")))
        expect(events).toEqual(["rejected", "source:false", "return:start:false"])
        expect(released).toBe(false)
        Effect.runSync(Deferred.succeed(finishReturn, undefined))
        await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("2 seconds")))
        expect(events).toEqual([
          "rejected",
          "source:false",
          "return:start:false",
          "return:end:false",
          "released",
        ])
      } finally {
        Effect.runSync(Deferred.succeed(finishPending, undefined))
        Effect.runSync(Deferred.succeed(finishRejecting, undefined))
        Effect.runSync(Deferred.succeed(finishReturn, undefined))
        mock.closeConnection(1000, "Done")
        await Effect.runPromise(Fiber.interrupt(fiber))
      }
    })

    it("rejects an already queued subscribe before initialization can acknowledge", async () => {
      const rejected = Effect.runSync(Deferred.make<void>())
      const mock = createMockSocket()
      const schema = createTestSchema()
      const resolve = vi.fn(() => "world")
      schema.getQueryType()!.getFields().hello.resolve = resolve
      const socket: EffectWebSocket = {
        ...mock.socket,
        close: (code, reason) =>
          mock.socket
            .close(code, reason)
            .pipe(Effect.andThen(Deferred.succeed(rejected, undefined)), Effect.asVoid),
      }
      // Both messages are available before native connection initialization starts.
      mock.sendMessage(JSON.stringify({ type: "connection_init" }))
      mock.sendMessage(
        JSON.stringify({
          id: "early",
          type: "subscribe",
          payload: { query: "{ hello }" },
        })
      )
      const fiber = Effect.runFork(makeGraphQLWSHandler(schema, Layer.empty)(socket))
      try {
        await Effect.runPromise(Deferred.await(rejected).pipe(Effect.timeout("2 seconds")))
        expect(mock.closeInfo).toEqual({ code: 4401, reason: "Unauthorized" })
        mock.closeConnection(1000, "Done")
        await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("2 seconds")))
        expect(resolve).not.toHaveBeenCalled()
      } finally {
        mock.closeConnection(1000, "Done")
        await Effect.runPromise(Fiber.interrupt(fiber))
      }
    })

    it("rejects subscriptions sent before an asynchronous connection acknowledgment", async () => {
      const connecting = Effect.runSync(Deferred.make<void>())
      const finishConnect = Effect.runSync(Deferred.make<void>())
      const rejected = Effect.runSync(Deferred.make<void>())
      const mock = createMockSocket()
      const socket: EffectWebSocket = {
        ...mock.socket,
        close: (code, reason) =>
          mock.socket
            .close(code, reason)
            .pipe(Effect.andThen(Deferred.succeed(rejected, undefined)), Effect.asVoid),
      }
      const fiber = Effect.runFork(
        makeGraphQLWSHandler(createTestSchema(), Layer.empty, {
          onConnect: () =>
            Deferred.succeed(connecting, undefined).pipe(
              Effect.andThen(Deferred.await(finishConnect))
            ),
        })(socket)
      )
      try {
        mock.sendMessage(JSON.stringify({ type: "connection_init" }))
        await Effect.runPromise(Deferred.await(connecting).pipe(Effect.timeout("2 seconds")))
        mock.sendMessage(
          JSON.stringify({
            id: "early",
            type: "subscribe",
            payload: { query: "subscription { tick { count } }" },
          })
        )
        await Effect.runPromise(Deferred.await(rejected).pipe(Effect.timeout("2 seconds")))
        expect(mock.closeInfo).toEqual({ code: 4401, reason: "Unauthorized" })
        expect(mock.sentMessages).toEqual([])
      } finally {
        Effect.runSync(Deferred.succeed(finishConnect, undefined))
        mock.closeConnection(1000, "Done")
        await Effect.runPromise(Fiber.interrupt(fiber))
      }
    })

    it.each(["subscribe", "disconnect", "interrupt"] as const)(
      "cancels a suspended ACK send and finalizes resources on %s",
      async (termination) => {
        const acknowledging = Effect.runSync(Deferred.make<void>())
        const finishAck = Effect.runSync(Deferred.make<void>())
        const protocolClosed = Effect.runSync(Deferred.make<void>())
        const outgoing = Effect.runSync(Queue.unbounded<unknown>())
        const mock = createMockSocket()
        const schema = createTestSchema()
        const resolve = vi.fn(() => "world")
        schema.getQueryType()!.getFields().hello.resolve = resolve
        let sendFinalized = 0
        let released = 0
        const layer = Layer.effectDiscard(
          Effect.acquireRelease(Effect.void, () =>
            Effect.sync(() => {
              released++
            })
          )
        )
        const socket: EffectWebSocket = {
          ...mock.socket,
          send: (data) =>
            Effect.gen(function* () {
              if (JSON.parse(data).type === "connection_ack") {
                yield* Deferred.succeed(acknowledging, undefined)
                yield* Deferred.await(finishAck).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      sendFinalized++
                    })
                  )
                )
              }
              yield* mock.socket.send(data)
              yield* Queue.offer(outgoing, JSON.parse(data))
            }),
          close: (code, reason) =>
            mock.socket
              .close(code, reason)
              .pipe(Effect.andThen(Deferred.succeed(protocolClosed, undefined)), Effect.asVoid),
        }
        const fiber = Effect.runFork(makeGraphQLWSHandler(schema, layer)(socket))
        try {
          mock.sendMessage(JSON.stringify({ type: "connection_init" }))
          await Effect.runPromise(Deferred.await(acknowledging).pipe(Effect.timeout("2 seconds")))
          mock.sendMessage(JSON.stringify({ type: "ping", payload: { barrier: "ack-pending" } }))
          expect(
            await Effect.runPromise(Queue.take(outgoing).pipe(Effect.timeout("2 seconds")))
          ).toEqual({ type: "pong", payload: { barrier: "ack-pending" } })

          if (termination === "subscribe") {
            mock.sendMessage(
              JSON.stringify({ id: "early", type: "subscribe", payload: { query: "{ hello }" } })
            )
            await Effect.runPromise(
              Deferred.await(protocolClosed).pipe(Effect.timeout("2 seconds"))
            )
            expect(mock.closeInfo).toEqual({ code: 4401, reason: "Unauthorized" })
          }
          if (termination === "interrupt") {
            await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.timeout("2 seconds")))
          } else {
            mock.closeConnection(1000, "Done")
            await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("2 seconds")))
          }
          expect(sendFinalized).toBe(1)
          expect(released).toBe(1)
          expect(resolve).not.toHaveBeenCalled()

          Effect.runSync(Deferred.succeed(finishAck, undefined))
          mock.sendMessage(
            JSON.stringify({ id: "late", type: "subscribe", payload: { query: "{ hello }" } })
          )
          mock.sendMessage(JSON.stringify({ type: "ping" }))
          await new Promise<void>((done) => setImmediate(done))
          expect(resolve).not.toHaveBeenCalled()
          expect(mock.sentMessages.map((message) => JSON.parse(message))).toEqual([
            { type: "pong", payload: { barrier: "ack-pending" } },
          ])
        } finally {
          Effect.runSync(Deferred.succeed(finishAck, undefined))
          mock.closeConnection(1000, "Done")
          await Effect.runPromise(Fiber.interrupt(fiber))
        }
      }
    )

    it("terminates closed pulls when an iterator yields from finally", async () => {
      const resolving = Effect.runSync(Deferred.make<void>())
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let cleanup = 0
      let afterYield = false
      let pulls = 0
      const mock = createMockSocket()
      const schema = createTestSchema()
      const field = schema.getSubscriptionType()!.getFields().tick
      field.subscribe = async function* () {
        try {
          yield { tick: { count: 1 } }
        } finally {
          cleanup++
          release()
          yield { tick: { count: 2 } }
          afterYield = true
        }
      }
      field.resolve = async (value) => {
        Effect.runSync(Deferred.succeed(resolving, undefined))
        await gate
        return value.tick
      }
      const createServer = GraphqlWs.makeServer
      const serverSpy = vi.spyOn(GraphqlWs, "makeServer").mockImplementation((options) =>
        createServer({
          ...options,
          onOperation: async (...args) => {
            const result = await options.onOperation?.(...args)
            if (!result || !(Symbol.asyncIterator in result)) return result
            const iterator = result[Symbol.asyncIterator]()
            return {
              [Symbol.asyncIterator]() {
                return this
              },
              next: () => {
                // Bound a regression's microtask loop so it cannot freeze the suite.
                if (++pulls > 3) throw new Error("Closed iterator kept yielding")
                return iterator.next()
              },
              return: (value) => iterator.return!(value),
            }
          },
        })
      )
      const fiber = Effect.runFork(makeGraphQLWSHandler(schema, Layer.empty)(mock.socket))
      try {
        mock.sendMessage(JSON.stringify({ type: "connection_init" }))
        await mock.waitForAck()
        mock.sendMessage(
          JSON.stringify({
            id: "cleanup",
            type: "subscribe",
            payload: { query: "subscription { tick { count } }" },
          })
        )
        await Effect.runPromise(Deferred.await(resolving).pipe(Effect.timeout("2 seconds")))
        mock.closeConnection(1000, "Done")
        await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("2 seconds")))
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(cleanup).toBe(1)
        expect(afterYield).toBe(true)
        expect(pulls).toBe(2)
        expect(mock.sentMessages.map((message) => JSON.parse(message))).toEqual([
          { type: "connection_ack" },
        ])
      } finally {
        release()
        mock.closeConnection(1000, "Done")
        await Effect.runPromise(Fiber.interrupt(fiber))
        serverSpy.mockRestore()
      }
    })

    it("discards messages received while awaiting source and disconnect cleanup", async () => {
      const events: string[] = []
      const pulled = Effect.runSync(Deferred.make<void>())
      const returning = Effect.runSync(Deferred.make<void>())
      const finishReturn = Effect.runSync(Deferred.make<void>())
      const disconnecting = Effect.runSync(Deferred.make<void>())
      const finishDisconnect = Effect.runSync(Deferred.make<void>())
      const pending: Array<(result: IteratorResult<unknown>) => void> = []
      let opened = 0
      const schema = createTestSchema()
      schema.getSubscriptionType()!.getFields().tick.subscribe = () => {
        const id = ++opened
        events.push(`subscribe:${id}`)
        return {
          [Symbol.asyncIterator]() {
            return this
          },
          next: () =>
            new Promise<IteratorResult<unknown>>((resolve) => {
              pending.push(resolve)
              Effect.runSync(Deferred.succeed(pulled, undefined))
            }),
          return: async () => {
            events.push(`return:${id}`)
            for (const resolve of pending) resolve({ done: true, value: undefined })
            Effect.runSync(Deferred.succeed(returning, undefined))
            await Effect.runPromise(Deferred.await(finishReturn))
            events.push(`finalized:${id}`)
            return { done: true, value: undefined }
          },
        }
      }
      const layer = Layer.effectDiscard(
        Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            events.push("released")
          })
        )
      )
      const mock = createMockSocket()
      const fiber = Effect.runFork(
        makeGraphQLWSHandler(schema, layer, {
          onDisconnect: () =>
            Effect.gen(function* () {
              events.push("disconnect:start")
              yield* Deferred.succeed(disconnecting, undefined)
              yield* Deferred.await(finishDisconnect)
              events.push("disconnect:end")
            }),
        })(mock.socket)
      )
      try {
        mock.sendMessage(JSON.stringify({ type: "connection_init" }))
        await mock.waitForAck()
        mock.sendMessage(
          JSON.stringify({
            id: "active",
            type: "subscribe",
            payload: { query: "subscription { tick { count } }" },
          })
        )
        await Effect.runPromise(Deferred.await(pulled).pipe(Effect.timeout("2 seconds")))
        mock.closeConnection(1000, "Done")
        await Effect.runPromise(Deferred.await(returning).pipe(Effect.timeout("2 seconds")))
        mock.sendMessage(
          JSON.stringify({
            id: "queued",
            type: "subscribe",
            payload: { query: "subscription { tick { count } }" },
          })
        )
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(opened).toBe(1)
        expect(events).toEqual(["subscribe:1", "return:1"])

        Effect.runSync(Deferred.succeed(finishReturn, undefined))
        await Effect.runPromise(Deferred.await(disconnecting).pipe(Effect.timeout("2 seconds")))
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(opened).toBe(1)
        expect(events).toEqual(["subscribe:1", "return:1", "finalized:1", "disconnect:start"])

        Effect.runSync(Deferred.succeed(finishDisconnect, undefined))
        await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("2 seconds")))
        expect(events).toEqual([
          "subscribe:1",
          "return:1",
          "finalized:1",
          "disconnect:start",
          "disconnect:end",
          "released",
        ])
      } finally {
        for (const resolve of pending) resolve({ done: true, value: undefined })
        Effect.runSync(Deferred.succeed(finishReturn, undefined))
        Effect.runSync(Deferred.succeed(finishDisconnect, undefined))
        mock.closeConnection(1000, "Done")
        await Effect.runPromise(Fiber.interrupt(fiber))
      }
    })

    it.each([
      ["onConnect", "close"],
      ["onConnect", "interrupt"],
      ["onConnect", "protocol"],
      ["onConnect", "messages"],
      ["onSubscribe", "close"],
      ["onSubscribe", "interrupt"],
      ["onSubscribe", "protocol"],
    ] as const)("interrupts %s setup and awaits its finalizer on %s", async (hook, termination) => {
      const started = Effect.runSync(Deferred.make<void>())
      const finishHook = Effect.runSync(Deferred.make<void>())
      const finalizing = Effect.runSync(Deferred.make<void>())
      const finishFinalizer = Effect.runSync(Deferred.make<void>())
      const protocolClosed = Effect.runSync(Deferred.make<void>())
      const events: string[] = []
      let released = false
      let completed = false
      const setup = Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(finishHook)
        completed = true
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            events.push(`finalizing:${released}`)
            yield* Deferred.succeed(finalizing, undefined)
            yield* Deferred.await(finishFinalizer)
            events.push(`finalized:${released}`)
          })
        )
      )
      const layer = Layer.effectDiscard(
        Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            released = true
            events.push("released")
          })
        )
      )
      const mock = createMockSocket()
      const socket: EffectWebSocket = {
        ...mock.socket,
        messages:
          termination === "messages"
            ? Stream.concat(
                mock.socket.messages,
                Stream.fail(new WebSocketError({ cause: new Error("Message stream failed") }))
              )
            : mock.socket.messages,
        close: (code, reason) =>
          mock.socket
            .close(code, reason)
            .pipe(Effect.andThen(Deferred.succeed(protocolClosed, undefined)), Effect.asVoid),
      }
      const fiber = Effect.runFork(
        makeGraphQLWSHandler(createTestSchema(), layer, { [hook]: () => setup })(socket)
      )
      try {
        mock.sendMessage(JSON.stringify({ type: "connection_init" }))
        if (hook === "onSubscribe") {
          await mock.waitForAck()
          mock.sendMessage(
            JSON.stringify({
              id: "pending",
              type: "subscribe",
              payload: { query: "subscription { tick { count } }" },
            })
          )
        }
        await Effect.runPromise(Deferred.await(started).pipe(Effect.timeout("2 seconds")))
        if (termination === "interrupt") Effect.runFork(Fiber.interrupt(fiber))
        else if (termination === "close") mock.closeConnection(1000, "Done")
        else if (termination === "messages") Effect.runSync(Queue.end(mock.messageQueue))
        else {
          mock.sendMessage("invalid json")
          await Effect.runPromise(Deferred.await(protocolClosed).pipe(Effect.timeout("2 seconds")))
          mock.closeConnection(1000, "Done")
        }
        await Effect.runPromise(Deferred.await(finalizing).pipe(Effect.timeout("2 seconds")))
        expect(completed).toBe(false)
        expect(released).toBe(false)
        Effect.runSync(Deferred.succeed(finishFinalizer, undefined))
        await Effect.runPromise(Fiber.await(fiber).pipe(Effect.timeout("2 seconds")))
        expect(events).toEqual(["finalizing:false", "finalized:false", "released"])
        if (termination === "protocol") {
          expect(mock.closeInfo).toEqual({ code: 4400, reason: "Invalid message received" })
        }
        if (termination === "messages") {
          expect(mock.closeInfo).toEqual({ code: 4403, reason: "Forbidden" })
        }
        Effect.runSync(Deferred.succeed(finishHook, undefined))
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(completed).toBe(false)
      } finally {
        Effect.runSync(Deferred.succeed(finishHook, undefined))
        Effect.runSync(Deferred.succeed(finishFinalizer, undefined))
        mock.closeConnection(1000, "Done")
        await Effect.runPromise(Fiber.interrupt(fiber))
      }
    })

    it.each(["close", "interrupt"] as const)(
      "awaits native asynchronous setup and late iterator cleanup on %s",
      async (termination) => {
        const events: string[] = []
        const started = Effect.runSync(Deferred.make<void>())
        const finishSetup = Effect.runSync(Deferred.make<void>())
        const returning = Effect.runSync(Deferred.make<void>())
        const finishReturn = Effect.runSync(Deferred.make<void>())
        let released = false
        let returns = 0
        const setup = Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(finishSetup)
          events.push(`setup:${released}`)
        })
        const schema = createTestSchema()
        schema.getSubscriptionType()!.getFields().tick.subscribe = async () => {
          await Effect.runPromise(setup)
          events.push(`source:${released}`)
          return {
            [Symbol.asyncIterator]() {
              return this
            },
            next: async () => {
              throw new Error("A closed subscription must not be consumed")
            },
            return: async () => {
              returns++
              events.push(`return:start:${released}`)
              Effect.runSync(Deferred.succeed(returning, undefined))
              await Effect.runPromise(Deferred.await(finishReturn))
              events.push(`return:end:${released}`)
              return { done: true, value: undefined }
            },
          }
        }
        const layer = Layer.effectDiscard(
          Effect.acquireRelease(Effect.void, () =>
            Effect.sync(() => {
              released = true
              events.push("released")
            })
          )
        )
        const mock = createMockSocket()
        const fiber = Effect.runFork(makeGraphQLWSHandler(schema, layer)(mock.socket))
        try {
          mock.sendMessage(JSON.stringify({ type: "connection_init" }))
          await mock.waitForAck()
          mock.sendMessage(
            JSON.stringify({
              id: "pending",
              type: "subscribe",
              payload: { query: "subscription { tick { count } }" },
            })
          )
          await Effect.runPromise(Deferred.await(started).pipe(Effect.timeout("2 seconds")))
          if (termination === "close") mock.closeConnection(1000, "Done")
          else Effect.runFork(Fiber.interrupt(fiber))
          await new Promise<void>((resolve) => setImmediate(resolve))
          expect(released).toBe(false)

          Effect.runSync(Deferred.succeed(finishSetup, undefined))
          await Effect.runPromise(Deferred.await(returning).pipe(Effect.timeout("2 seconds")))
          expect(released).toBe(false)
          expect(returns).toBe(1)

          Effect.runSync(Deferred.succeed(finishReturn, undefined))
          await Effect.runPromise(Fiber.await(fiber).pipe(Effect.timeout("2 seconds")))
          expect(events).toEqual([
            "setup:false",
            "source:false",
            "return:start:false",
            "return:end:false",
            "released",
          ])
          expect(returns).toBe(1)
        } finally {
          Effect.runSync(Deferred.succeed(finishSetup, undefined))
          Effect.runSync(Deferred.succeed(finishReturn, undefined))
          mock.closeConnection(1000, "Done")
          await Effect.runPromise(Fiber.interrupt(fiber))
        }
      }
    )

    it("awaits an in-flight completion hook before releasing connection services", async () => {
      const events: string[] = []
      const completing = Effect.runSync(Deferred.make<void>())
      const finishComplete = Effect.runSync(Deferred.make<void>())
      const layer = Layer.effectDiscard(
        Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            events.push("released")
          })
        )
      )
      const mock = createMockSocket()
      const fiber = Effect.runFork(
        makeGraphQLWSHandler(createTestSchema(), layer, {
          onComplete: () =>
            Effect.gen(function* () {
              events.push("complete:start")
              yield* Deferred.succeed(completing, undefined)
              yield* Deferred.await(finishComplete)
              events.push("complete:end")
            }),
        })(mock.socket)
      )
      try {
        mock.sendMessage(JSON.stringify({ type: "connection_init" }))
        await mock.waitForAck()
        mock.sendMessage(
          JSON.stringify({
            id: "completed",
            type: "subscribe",
            payload: { query: "subscription { tick { count } }" },
          })
        )
        await Effect.runPromise(Deferred.await(completing).pipe(Effect.timeout("2 seconds")))
        mock.closeConnection(1000, "Done")
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(events).toEqual(["complete:start"])
        Effect.runSync(Deferred.succeed(finishComplete, undefined))
        await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("2 seconds")))
        expect(events).toEqual(["complete:start", "complete:end", "released"])
      } finally {
        Effect.runSync(Deferred.succeed(finishComplete, undefined))
        mock.closeConnection(1000, "Done")
        await Effect.runPromise(Fiber.interrupt(fiber))
      }
    })

    it.each(["before", "after"] as const)(
      "awaits setup/registration handoff cleanup %s the close snapshot",
      async (snapshot) => {
        const returning = Effect.runSync(Deferred.make<void>())
        const finishReturn = Effect.runSync(Deferred.make<void>())
        const disconnecting = Effect.runSync(Deferred.make<void>())
        const messageStopping = Effect.runSync(Deferred.make<void>())
        const finishMessageStop = Effect.runSync(Deferred.make<void>())
        const events: string[] = []
        let released = false
        let returns = 0
        const mock = createMockSocket()
        const socket: EffectWebSocket = {
          ...mock.socket,
          messages: mock.socket.messages.pipe(
            Stream.ensuring(
              snapshot === "before"
                ? Deferred.succeed(messageStopping, undefined).pipe(
                    Effect.andThen(Deferred.await(finishMessageStop))
                  )
                : Effect.void
            )
          ),
        }
        const createServer = GraphqlWs.makeServer
        const serverSpy = vi.spyOn(GraphqlWs, "makeServer").mockImplementation((options) =>
          createServer({
            ...options,
            onOperation: async (...args) => {
              const result = await options.onOperation?.(...args)
              // Close after the framework hook returns, before graphql-ws can
              // register its result. Keep the real protocol implementation.
              mock.closeConnection(1000, "Done")
              await Effect.runPromise(
                Deferred.await(snapshot === "before" ? messageStopping : disconnecting)
              )
              return result
            },
          })
        )
        const schema = createTestSchema()
        schema.getSubscriptionType()!.getFields().tick.subscribe = () => ({
          [Symbol.asyncIterator]() {
            return this
          },
          next: async () => {
            throw new Error("A closed subscription must not be consumed")
          },
          return: async () => {
            returns++
            events.push(`return:start:${released}`)
            Effect.runSync(Deferred.succeed(returning, undefined))
            await Effect.runPromise(Deferred.await(finishReturn))
            events.push(`return:end:${released}`)
            return { done: true, value: undefined }
          },
        })
        const layer = Layer.effectDiscard(
          Effect.acquireRelease(Effect.void, () =>
            Effect.sync(() => {
              released = true
              events.push("released")
            })
          )
        )
        const fiber = Effect.runFork(
          makeGraphQLWSHandler(schema, layer, {
            onDisconnect: () => Deferred.succeed(disconnecting, undefined).pipe(Effect.asVoid),
          })(socket)
        )
        try {
          mock.sendMessage(JSON.stringify({ type: "connection_init" }))
          await mock.waitForAck()
          mock.sendMessage(
            JSON.stringify({
              id: "handoff",
              type: "subscribe",
              payload: { query: "subscription { tick { count } }" },
            })
          )
          await Effect.runPromise(Deferred.await(returning).pipe(Effect.timeout("2 seconds")))
          await new Promise<void>((resolve) => setImmediate(resolve))
          expect(released).toBe(false)
          expect(returns).toBe(1)
          Effect.runSync(Deferred.succeed(finishReturn, undefined))
          Effect.runSync(Deferred.succeed(finishMessageStop, undefined))
          await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("2 seconds")))
          expect(returns).toBe(1)
          expect(events).toEqual(["return:start:false", "return:end:false", "released"])
        } finally {
          Effect.runSync(Deferred.succeed(finishReturn, undefined))
          Effect.runSync(Deferred.succeed(finishMessageStop, undefined))
          Effect.runSync(Deferred.succeed(disconnecting, undefined))
          mock.closeConnection(1000, "Done")
          await Effect.runPromise(Fiber.interrupt(fiber))
          serverSpy.mockRestore()
        }
      }
    )

    it("finishes cleanup failures without sending to a closed socket", async () => {
      const ready = Effect.runSync(Deferred.make<void>())
      const finishLateSend = Effect.runSync(Deferred.make<void>())
      const events: string[] = []
      let closed = false
      let lateSends = 0
      const schema = GraphQLSchemaBuilder.empty
        .query("hello", { type: S.String, resolve: () => Effect.succeed("world") })
        .subscription("event", {
          type: S.String,
          subscribe: () =>
            Effect.succeed(
              Stream.make("first").pipe(
                Stream.concat(Stream.never),
                Stream.ensuring(
                  Effect.gen(function* () {
                    yield* Effect.promise(
                      () => new Promise<void>((resolve) => setImmediate(resolve))
                    )
                    events.push("finalized")
                    yield* Effect.die(new Error("Source cleanup failed"))
                  })
                )
              )
            ),
        })
        .buildSchema()
      const layer = Layer.effectDiscard(
        Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            events.push("released")
          })
        )
      )
      const mock = createMockSocket()
      const socket: EffectWebSocket = {
        ...mock.socket,
        closed: mock.socket.closed.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              closed = true
            })
          )
        ),
        send: (data) => {
          if (closed) {
            lateSends++
            return Deferred.await(finishLateSend)
          }
          return mock.socket
            .send(data)
            .pipe(
              Effect.andThen(
                JSON.parse(data).type === "next"
                  ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
                  : Effect.void
              )
            )
        },
      }
      const fiber = Effect.runFork(makeGraphQLWSHandler(schema, layer)(socket))
      try {
        mock.sendMessage(JSON.stringify({ type: "connection_init" }))
        await mock.waitForAck()
        mock.sendMessage(
          JSON.stringify({
            id: "active",
            type: "subscribe",
            payload: { query: "subscription { event }" },
          })
        )
        await Effect.runPromise(Deferred.await(ready).pipe(Effect.timeout("2 seconds")))
        mock.closeConnection(1000, "Done")
        await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("2 seconds")))
        expect(events).toEqual(["finalized", "released"])
        expect(lateSends).toBe(0)
      } finally {
        Effect.runSync(Deferred.succeed(finishLateSend, undefined))
        mock.closeConnection(1000, "Done")
        await Effect.runPromise(Fiber.interrupt(fiber))
      }
    })
  })

  describe("builder subscription operation contexts", () => {
    it("keeps decoded args per operation on one connection and cleans up completion and cancellation", async () => {
      let defaults = 0
      let transforms = 0
      let acquired = 0
      let released = 0
      const finalized: number[] = []
      const finalizedAtRelease: number[][] = []
      const cancelled = Effect.runSync(Deferred.make<void>())
      const Shared = Context.Service<{ readonly prefix: string }>("ws/SharedSubscription")
      const layer = Layer.effect(
        Shared,
        Effect.acquireRelease(
          Effect.sync(() => {
            acquired++
            return { prefix: "shared" }
          }),
          () =>
            Effect.sync(() => {
              released++
              finalizedAtRelease.push([...finalized])
            })
        )
      )
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
            Effect.succeed(
              Stream.make("first", "second").pipe(
                Stream.concat(token === 12 ? Stream.never : Stream.empty),
                Stream.ensuring(
                  Effect.gen(function* () {
                    // Resource cleanup may itself be asynchronous.
                    yield* Effect.promise(() => Promise.resolve())
                    finalized.push(token)
                    if (token === 12) yield* Deferred.succeed(cancelled, undefined)
                  })
                )
              )
            ),
          resolve: (event, { token }) =>
            Effect.map(Shared, ({ prefix }) => `${prefix}:${token}:${event}`),
        })
        .buildSchema()
      const tokenField = schema.getSubscriptionType()!.getFields().token
      const resolveToken = tokenField.resolve!
      tokenField.resolve = async (source, args, context, info) =>
        `${context.user.name}:${await resolveToken(source, args, context, info)}`
      const mock = createMockSocket()
      const outgoing = Effect.runSync(
        Queue.unbounded<{ type: string; id?: string; payload?: unknown }>()
      )
      const socket: EffectWebSocket = {
        ...mock.socket,
        send: (data) =>
          mock.socket
            .send(data)
            .pipe(Effect.andThen(Queue.offer(outgoing, JSON.parse(data))), Effect.asVoid),
      }
      const nextMessage = () =>
        Effect.runPromise(Queue.take(outgoing).pipe(Effect.timeout("2 seconds")))
      const fiber = Effect.runFork(
        makeGraphQLWSHandler(schema, layer, {
          onConnect: () => Effect.succeed({ user: { name: "alice" }, services: "metadata" }),
        })(socket)
      )

      try {
        mock.sendMessage(JSON.stringify({ type: "connection_init" }))
        expect(await nextMessage()).toEqual({ type: "connection_ack" })

        mock.sendMessage(
          JSON.stringify({
            id: "completed",
            type: "subscribe",
            payload: { query: "subscription { token }" },
          })
        )
        expect(await nextMessage()).toEqual({
          id: "completed",
          type: "next",
          payload: { data: { token: "alice:shared:11:first" } },
        })
        expect(await nextMessage()).toEqual({
          id: "completed",
          type: "next",
          payload: { data: { token: "alice:shared:11:second" } },
        })
        expect(await nextMessage()).toEqual({ id: "completed", type: "complete" })

        mock.sendMessage(
          JSON.stringify({
            id: "cancelled",
            type: "subscribe",
            payload: { query: "subscription { token }" },
          })
        )
        expect(await nextMessage()).toEqual({
          id: "cancelled",
          type: "next",
          payload: { data: { token: "alice:shared:12:first" } },
        })
        expect(await nextMessage()).toEqual({
          id: "cancelled",
          type: "next",
          payload: { data: { token: "alice:shared:12:second" } },
        })
        expect(acquired).toBe(1)
        expect(released).toBe(0)
        expect(defaults).toBe(2)
        expect(transforms).toBe(2)

        mock.closeConnection(1000, "Done")
        await Effect.runPromise(Deferred.await(cancelled).pipe(Effect.timeout("2 seconds")))
        await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("2 seconds")))
        expect(finalized).toEqual([11, 12])
        expect(released).toBe(1)
        expect(finalizedAtRelease).toEqual([[11, 12]])
      } finally {
        mock.closeConnection(1000, "Done")
        await Effect.runPromise(Fiber.interrupt(fiber))
      }
    })
  })

  describe("protocol compliance", () => {
    it("should use graphql-transport-ws protocol", async () => {
      const schema = createTestSchema()
      const handler = makeGraphQLWSHandler(schema, Layer.empty)

      const { socket, closeConnection } = createMockSocket()
      expect(socket.protocol).toBe("graphql-transport-ws")

      const fiber = Effect.runFork(handler(socket))
      await new Promise((r) => setTimeout(r, 10))

      closeConnection(1000, "Done")
      await Effect.runPromise(Fiber.join(fiber))
    })

    it("should respond with connection_ack after connection_init", async () => {
      const schema = createTestSchema()
      const handler = makeGraphQLWSHandler(schema, Layer.empty)

      const { socket, sendMessage, sentMessages, closeConnection } = createMockSocket()
      const fiber = Effect.runFork(handler(socket))

      await new Promise((r) => setTimeout(r, 10))

      sendMessage(JSON.stringify({ type: "connection_init" }))
      await new Promise((r) => setTimeout(r, 50))

      const ackIndex = sentMessages.findIndex((m) => {
        try {
          return JSON.parse(m).type === "connection_ack"
        } catch {
          return false
        }
      })
      expect(ackIndex).toBeGreaterThanOrEqual(0)

      closeConnection(1000, "Done")
      await Effect.runPromise(Fiber.join(fiber))
    })

    it("should handle subscription message flow", async () => {
      const schema = createTestSchema()
      const handler = makeGraphQLWSHandler(schema, Layer.empty)

      const { socket, sendMessage, sentMessages, closeConnection } = createMockSocket()
      const fiber = Effect.runFork(handler(socket))

      await new Promise((r) => setTimeout(r, 10))

      sendMessage(JSON.stringify({ type: "connection_init" }))
      await new Promise((r) => setTimeout(r, 50))

      // Verify connection_ack was received
      const hasAck = sentMessages.some((m) => {
        try {
          return JSON.parse(m).type === "connection_ack"
        } catch {
          return false
        }
      })
      expect(hasAck).toBe(true)

      // Start subscription
      sendMessage(
        JSON.stringify({
          id: "sub-1",
          type: "subscribe",
          payload: { query: "subscription { tick { count } }" },
        })
      )

      // Wait for potential subscription events
      await new Promise((r) => setTimeout(r, 100))

      closeConnection(1000, "Done")
      await Effect.runPromise(Fiber.join(fiber))
    })
  })

  describe("Layer integration", () => {
    it("should accept a typed layer parameter", async () => {
      class TestService extends Context.Service<
        TestService,
        {
          readonly getValue: () => string
        }
      >()("TestService") {}

      const testLayer = Layer.succeed(TestService, {
        getValue: () => "test-value",
      })

      const schema = createTestSchema()

      // Verify handler accepts typed layer - this is a compile-time check
      const handler = makeGraphQLWSHandler<TestService>(schema, testLayer, {
        onConnect: () =>
          Effect.gen(function* () {
            const service = yield* TestService
            // If this compiles, the types are correctly propagated
            service.getValue()
            return true
          }),
      })

      expect(typeof handler).toBe("function")

      const { socket, closeConnection } = createMockSocket()
      const fiber = Effect.runFork(handler(socket))

      await new Promise((r) => setTimeout(r, 10))

      closeConnection(1000, "Done")
      await Effect.runPromise(Fiber.join(fiber))
    })

    it("should create runtime from layer for each connection", async () => {
      const schema = createTestSchema()
      let runtimeCreated = false

      // Use a layer that logs when it's used
      const trackingLayer = Layer.effectDiscard(
        Effect.sync(() => {
          runtimeCreated = true
        })
      )

      const handler = makeGraphQLWSHandler(schema, trackingLayer)

      const { socket, closeConnection } = createMockSocket()
      const fiber = Effect.runFork(handler(socket))

      // Allow time for layer to be used
      await new Promise((r) => setTimeout(r, 50))

      expect(runtimeCreated).toBe(true)

      closeConnection(1000, "Done")
      await Effect.runPromise(Fiber.join(fiber))
    })
  })
  describe("ambient connection context", () => {
    it("isolates and releases each connection when its layer is already ambient", async () => {
      const Resource = Context.Service<{ readonly id: number }>("ws/ConnectionResource")
      const Mirror = Context.Service<number>("ws/ConnectionMirror")
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
      const handler = makeGraphQLWSHandler(createTestSchema(), layer, {
        onConnect: () =>
          Effect.gen(function* () {
            observed.push({ id: (yield* Resource).id, mirror: yield* Mirror })
            return true
          }),
      })

      await Effect.runPromise(
        Effect.gen(function* () {
          expect((yield* Resource).id).toBe(1)
          for (let connection = 0; connection < 2; connection++) {
            const mock = createMockSocket()
            const acknowledged = yield* Deferred.make<void>()
            const socket: EffectWebSocket = {
              ...mock.socket,
              send: (message) =>
                mock.socket
                  .send(message)
                  .pipe(
                    Effect.andThen(
                      JSON.parse(message).type === "connection_ack"
                        ? Deferred.succeed(acknowledged, undefined)
                        : Effect.void
                    ),
                    Effect.asVoid
                  ),
            }
            const fiber = yield* Effect.forkChild(handler(socket))
            yield* Queue.offer(mock.messageQueue, JSON.stringify({ type: "connection_init" }))
            yield* Deferred.await(acknowledged)
            yield* Deferred.succeed(mock.closedDeferred, { code: 1000, reason: "Done" })
            yield* Fiber.join(fiber)
            expect(released).toEqual(connection === 0 ? [2] : [2, 3])
          }
          expect((yield* Resource).id).toBe(1)
        }).pipe(Effect.provide(layer), Effect.scoped)
      )

      expect(observed).toEqual([
        { id: 2, mirror: 2 },
        { id: 3, mirror: 3 },
      ])
      expect(acquired).toBe(3)
      expect(released).toEqual([2, 3, 1])
    })

    it("preserves annotations, spans, and explicit services through the graphql-ws protocol", async () => {
      const Setting = Context.Service<string>("ws/AnnotationSetting")
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
      const schema = createTestSchema()
      const mock = createMockSocket()
      const completed = Effect.runSync(Deferred.make<void>())
      const acknowledged = Effect.runSync(Deferred.make<void>())
      const handler = makeGraphQLWSHandler(schema, layer, {
        onConnect: () => observe("connect").pipe(Effect.as(true)),
        onDisconnect: (ctx) =>
          observe("disconnect").pipe(
            Effect.andThen(
              Effect.promise(() => Effect.runPromiseWith(ctx.services)(observe("detached")))
            ),
            Effect.andThen(Deferred.succeed(completed, undefined)),
            Effect.asVoid
          ),
      })
      const socket: EffectWebSocket = {
        ...mock.socket,
        send: (message) =>
          mock.socket
            .send(message)
            .pipe(
              Effect.andThen(
                JSON.parse(message).type === "connection_ack"
                  ? Deferred.succeed(acknowledged, undefined)
                  : Effect.void
              ),
              Effect.asVoid
            ),
      }
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            handler(socket).pipe(
              Effect.provideService(Setting, "ambient"),
              Effect.annotateLogs("connectionId", "ws-connection"),
              Effect.withSpan("ws-connection")
            )
          )
          yield* Queue.offer(mock.messageQueue, JSON.stringify({ type: "connection_init" }))
          yield* Deferred.await(acknowledged)
          yield* Deferred.succeed(mock.closedDeferred, { code: 1000, reason: "Done" })
          yield* Deferred.await(completed)
          yield* Fiber.join(fiber)
        }).pipe(Effect.scoped)
      )

      expect(mock.sentMessages.map((message) => JSON.parse(message))).toEqual([
        { type: "connection_ack" },
      ])
      expect(observations).toEqual(
        ["layer", "connect", "disconnect", "detached"].map((phase) => ({
          phase,
          connectionId: "ws-connection",
          span: "ws-connection",
          setting: phase === "layer" ? "building" : "explicit",
        }))
      )
    })
  })

  describe("ws message stream completion", () => {
    class TestSocket extends EventEmitter implements WsWebSocket {
      protocol = "graphql-transport-ws"
      readyState = 1
      send(_data: string, callback?: (error?: Error) => void): void {
        callback?.()
      }
      close(code = 1000, reason = ""): void {
        this.readyState = 3
        this.emit("close", code, Buffer.from(reason))
      }
    }

    it("closes failed initialization without exposing errors or leaking partial resources", async () => {
      const Resource = Context.Service<string>("ws/PartialConnectionResource")
      const Failed = Context.Service<string>("ws/FailedConnectionResource")
      let released = 0
      const resource = Layer.effect(
        Resource,
        Effect.acquireRelease(Effect.succeed("open"), () =>
          Effect.sync(() => {
            released++
          })
        )
      )
      const layer = Layer.effect(
        Failed,
        Effect.andThen(Resource, Effect.fail(new Error("sensitive acquisition details")))
      ).pipe(Layer.provide(resource))
      const ws = new TestSocket()
      const closed: Array<{ code: number; reason: string }> = []
      ws.on("close", (code: number, reason: Buffer) =>
        closed.push({ code, reason: reason.toString() })
      )

      await Effect.runPromise(
        makeGraphQLWSHandler(createTestSchema(), layer)(toEffectWebSocketFromWs(ws))
      )

      expect(ws.readyState).toBe(3)
      expect(closed).toEqual([{ code: 1011, reason: "Internal server error" }])
      expect(released).toBe(1)
      expect(ws.listenerCount("message")).toBe(0)
      expect(ws.listenerCount("error")).toBe(0)
    })

    it("drains queued messages and succeeds on normal code 1000 closure", async () => {
      const ws = new TestSocket()
      const ready = new Promise<void>((resolve) => {
        ws.on("newListener", (event) => {
          if (event === "close") resolve()
        })
      })
      const result = Effect.runPromise(Stream.runCollect(toEffectWebSocketFromWs(ws).messages))
      await ready
      ws.emit("message", Buffer.from("first"))
      ws.emit("message", "second")
      ws.close(1000, "Done")

      expect(await result).toEqual(["first", "second"])
      expect(ws.listenerCount("message")).toBe(0)
      expect(ws.listenerCount("close")).toBe(0)
      expect(ws.listenerCount("error")).toBe(0)
    })

    it("fails with the socket error instead of silently completing", async () => {
      const ws = new TestSocket()
      const ready = new Promise<void>((resolve) => {
        ws.on("newListener", (event) => {
          if (event === "close") resolve()
        })
      })
      const result = Effect.runPromise(
        Stream.runCollect(toEffectWebSocketFromWs(ws).messages).pipe(Effect.flip)
      )
      await ready
      const failure = new Error("Connection reset")
      ws.emit("error", failure)

      expect(await result).toMatchObject({ _tag: "WebSocketError", cause: failure })
      expect(ws.listenerCount("message")).toBe(0)
      expect(ws.listenerCount("close")).toBe(0)
      expect(ws.listenerCount("error")).toBe(0)
    })
  })
})
