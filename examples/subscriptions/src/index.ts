/**
 * GraphQL Subscriptions Example
 *
 * This example demonstrates real-time GraphQL subscriptions using Effect Streams.
 * It showcases:
 * - Basic subscriptions with automatic interval updates
 * - Subscriptions with arguments
 * - Message broadcasting with Effect Ref
 * - WebSocket transport via graphql-ws protocol
 */

import { Effect, Stream, Layer, Duration, Ref, PubSub, Queue, Schedule } from "effect"
import * as S from "effect/Schema"
import { HttpMiddleware, HttpRouter, HttpServerResponse } from "@effect/platform"
import {
  GraphQLSchemaBuilder,
  query,
  mutation,
  subscription,
  makeGraphQLRouter,
} from "@effect-gql/core"
import { serve } from "@effect-gql/node"

// =============================================================================
// Domain Models
// =============================================================================

/**
 * A tick event for the interval subscription
 */
const Tick = S.Struct({
  count: S.Number,
  timestamp: S.Number,
})

/**
 * A chat message
 */
const Message = S.Struct({
  id: S.String,
  content: S.String,
  author: S.String,
  createdAt: S.Number,
})
type Message = S.Schema.Type<typeof Message>

// =============================================================================
// State Management with Effect Ref
// =============================================================================

/**
 * We use Effect Ref to manage mutable state in a safe way.
 * PubSub is used to broadcast messages to all subscribers.
 */
let messageIdCounter = 0
const messagesRef = Ref.unsafeMake<Message[]>([])
const messagePubSub = Effect.runSync(PubSub.unbounded<Message>())

// =============================================================================
// GraphQL Schema
// =============================================================================

const schema = GraphQLSchemaBuilder.empty
  .pipe(
    // Simple query to verify the server is working
    query("hello", {
      type: S.String,
      resolve: () => Effect.succeed("Hello from Subscriptions Example!"),
    }),

    // Query to get all messages
    query("messages", {
      type: S.Array(Message),
      description: "Get all messages",
      resolve: () => Ref.get(messagesRef),
    }),

    // Mutation to send a new message
    mutation("sendMessage", {
      args: S.Struct({
        content: S.String,
        author: S.String,
      }),
      type: Message,
      description: "Send a new message",
      resolve: (args) =>
        Effect.gen(function* () {
          const message: Message = {
            id: String(++messageIdCounter),
            content: args.content,
            author: args.author,
            createdAt: Date.now(),
          }

          // Add to message list
          yield* Ref.update(messagesRef, (msgs) => [...msgs, message])

          // Broadcast to all subscribers
          yield* PubSub.publish(messagePubSub, message)

          console.log(`📨 New message from ${args.author}: "${args.content}"`)

          return message
        }),
    }),

    // =============================================================================
    // Subscriptions
    // =============================================================================

    /**
     * Subscription 1: Simple tick counter
     *
     * Emits a tick every second with the count and timestamp.
     * Great for testing that subscriptions are working.
     */
    subscription("tick", {
      type: Tick,
      description: "Emits a tick every second",
      subscribe: () =>
        Effect.succeed(
          Stream.iterate(1, (n) => n + 1).pipe(
            Stream.schedule(Schedule.spaced(Duration.seconds(1))),
            Stream.map((count) => ({
              count,
              timestamp: Date.now(),
            }))
          )
        ),
    }),

    /**
     * Subscription 2: Countdown with arguments
     *
     * Counts down from a given number to zero.
     * Demonstrates how to use arguments in subscriptions.
     */
    subscription("countdown", {
      type: S.Number,
      args: S.Struct({ from: S.Number }),
      description: "Counts down from a number to zero",
      subscribe: ({ from }) =>
        Effect.succeed(
          Stream.range(0, from).pipe(
            Stream.map((i) => from - i),
            Stream.schedule(Schedule.spaced(Duration.seconds(1)))
          )
        ),
    }),

    /**
     * Subscription 3: New messages
     *
     * Subscribers receive real-time updates when new messages are posted.
     * Uses Effect PubSub for broadcasting.
     */
    subscription("newMessage", {
      type: Message,
      description: "Receive real-time message updates",
      subscribe: () =>
        Effect.gen(function* () {
          const queue = yield* PubSub.subscribe(messagePubSub)

          return Stream.fromQueue(queue).pipe(
            Stream.tap((msg) =>
              Effect.sync(() =>
                console.log(`📤 Broadcasting message to subscriber: ${msg.id}`)
              )
            )
          )
        }),
    }),

    /**
     * Subscription 4: Filtered messages by author
     *
     * Only receive messages from a specific author.
     * Demonstrates filtering subscription streams.
     */
    subscription("messagesByAuthor", {
      type: Message,
      args: S.Struct({ author: S.String }),
      description: "Receive messages from a specific author",
      subscribe: ({ author }) =>
        Effect.gen(function* () {
          const queue = yield* PubSub.subscribe(messagePubSub)

          return Stream.fromQueue(queue).pipe(
            Stream.filter((msg) => msg.author === author),
            Stream.tap((msg) =>
              Effect.sync(() =>
                console.log(`📤 Filtered message for ${author}: ${msg.id}`)
              )
            )
          )
        }),
    })
  )
  .buildSchema()

// =============================================================================
// HTTP Router
// =============================================================================

const graphqlRouter = makeGraphQLRouter(schema, Layer.empty, {
  path: "/graphql",
  graphiql: {
    path: "/graphiql",
    endpoint: "/graphql",
  },
})

/**
 * CORS middleware to allow cross-origin requests.
 */
const cors = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const response = yield* app
    return response.pipe(
      HttpServerResponse.setHeader("Access-Control-Allow-Origin", "*"),
      HttpServerResponse.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
      HttpServerResponse.setHeader("Access-Control-Allow-Headers", "Content-Type")
    )
  })
)

const app = HttpRouter.empty.pipe(
  HttpRouter.options(
    "/graphql",
    HttpServerResponse.empty().pipe(
      HttpServerResponse.setStatus(204),
      HttpServerResponse.setHeader("Access-Control-Allow-Origin", "*"),
      HttpServerResponse.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
      HttpServerResponse.setHeader("Access-Control-Allow-Headers", "Content-Type"),
      Effect.orDie
    )
  ),
  HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" })),
  HttpRouter.concat(graphqlRouter),
  cors
)

// =============================================================================
// Server Startup
// =============================================================================

/**
 * Start the server with WebSocket subscription support.
 *
 * The `subscriptions` option enables the graphql-ws protocol on the same
 * endpoint, allowing clients to establish WebSocket connections.
 */
serve(app, Layer.empty, {
  port: 4002,
  subscriptions: {
    schema,
    path: "/graphql",
  },
  onStart: (url: string) => {
    console.log(`🚀 Subscriptions Example Server ready at ${url}`)
    console.log(`📊 GraphQL endpoint: ${url}/graphql`)
    console.log(`🎮 GraphiQL playground: ${url}/graphiql`)
    console.log(`🔌 WebSocket subscriptions: ws://localhost:4002/graphql`)
    console.log("")
    console.log("Try these subscriptions in GraphiQL:")
    console.log(`
  # Tick every second
  subscription { tick { count timestamp } }

  # Countdown from 10
  subscription { countdown(from: 10) }

  # Real-time messages (then send a message in another tab)
  subscription { newMessage { id content author } }
`)
    console.log("To send a message, use this mutation:")
    console.log(`
  mutation {
    sendMessage(content: "Hello!", author: "Alice") {
      id
      content
      author
    }
  }
`)
  },
})
