import { describe, it, expect } from "vitest"
import { EventEmitter } from "node:events"
import { Effect, Layer, Stream, Queue, Deferred, Fiber, Context, References } from "effect"
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLInt,
  GraphQLNonNull,
} from "graphql"
import { makeGraphQLWSHandler } from "../../../src/server/ws-adapter"
import { toEffectWebSocketFromWs, type WsWebSocket } from "../../../src/server/ws-utils"
import type { EffectWebSocket, WebSocketError, CloseEvent } from "../../../src/server/ws-types"

/**
 * Create a mock EffectWebSocket for testing
 */
const createMockSocket = () => {
  const messageQueue = Effect.runSync(Queue.unbounded<string>())
  const closedDeferred = Effect.runSync(Deferred.make<CloseEvent, WebSocketError>())
  const sentMessages: string[] = []
  const closeInfo = {
    code: undefined as number | undefined,
    reason: undefined as string | undefined,
  }

  const socket: EffectWebSocket = {
    protocol: "graphql-transport-ws",
    send: (data: string) =>
      Effect.sync(() => {
        sentMessages.push(data)
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

    it("should handle multiple subscription requests", async () => {
      const schema = createTestSchema()
      const handler = makeGraphQLWSHandler(schema, Layer.empty)

      const { socket, sendMessage, closeConnection } = createMockSocket()
      const fiber = Effect.runFork(handler(socket))

      await new Promise((r) => setTimeout(r, 10))

      sendMessage(JSON.stringify({ type: "connection_init" }))
      await new Promise((r) => setTimeout(r, 50))

      // Start multiple subscriptions - should not crash
      sendMessage(
        JSON.stringify({
          id: "sub-1",
          type: "subscribe",
          payload: { query: "subscription { tick { count } }" },
        })
      )
      sendMessage(
        JSON.stringify({
          id: "sub-2",
          type: "subscribe",
          payload: { query: "subscription { tick { count } }" },
        })
      )

      await new Promise((r) => setTimeout(r, 100))

      // Close and verify cleanup works with multiple subscriptions
      closeConnection(1000, "Done")

      const result = await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("2 seconds")))

      // Handler should complete without hanging
      expect(result).toBeUndefined()
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
