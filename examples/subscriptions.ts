/**
 * Example: GraphQL Subscriptions with Effect Streams
 *
 * This example demonstrates how to use Effect Streams for GraphQL subscriptions.
 * Subscriptions allow clients to receive real-time updates when data changes.
 */

import { Effect, Stream, Layer, Duration, Ref } from "effect"
import * as S from "effect/Schema"
import { printSchema, subscribe, parse } from "graphql"
import { GraphQLSchemaBuilder } from "../src/builder"

// =============================================================================
// Schema Definitions
// =============================================================================

const Tick = S.Struct({
  count: S.Number,
  timestamp: S.Number,
})

const Message = S.Struct({
  id: S.String,
  content: S.String,
  author: S.String,
})

// =============================================================================
// Build the GraphQL Schema
// =============================================================================

const schema = GraphQLSchemaBuilder.empty
  .objectType({ name: "Tick", schema: Tick })
  .objectType({ name: "Message", schema: Message })

  // Simple query for testing
  .query("hello", {
    type: S.String,
    resolve: () => Effect.succeed("Hello, World!"),
  })

  // Subscription: Tick counter (finite stream for testing)
  .subscription("tick", {
    type: Tick,
    description: "Emits numbered ticks",
    subscribe: () =>
      Effect.succeed(
        Stream.range(1, 5).pipe(
          Stream.map((count) => ({
            count,
            timestamp: Date.now(),
          })),
          // Add a small delay between items
          Stream.tap(() => Effect.sleep(Duration.millis(100)))
        )
      ),
  })

  // Subscription with arguments: countdown from N
  .subscription("countdown", {
    type: S.Number,
    args: S.Struct({ from: S.Number }),
    description: "Counts down from a number",
    subscribe: ({ from }) =>
      Effect.succeed(
        Stream.range(0, from).pipe(
          Stream.map((i) => from - i),
          Stream.tap(() => Effect.sleep(Duration.millis(100)))
        )
      ),
  })

  // Subscription with resolve transform
  .subscription("messages", {
    type: Message,
    description: "Receives messages",
    subscribe: () =>
      Effect.succeed(
        Stream.make(
          { id: "1", content: "Hello!", author: "Alice" },
          { id: "2", content: "Hi there!", author: "Bob" },
          { id: "3", content: "Goodbye!", author: "Alice" }
        ).pipe(Stream.tap(() => Effect.sleep(Duration.millis(100))))
      ),
    // Optional: transform each message
    resolve: (msg) =>
      Effect.succeed({
        ...msg,
        content: msg.content.toUpperCase(),
      }),
  })

  .buildSchema()

// =============================================================================
// Test the Subscriptions
// =============================================================================

console.log("=== GraphQL Schema with Subscriptions ===\n")
console.log(printSchema(schema))
console.log("\n")

// Test helper function
async function runSubscription(name: string, query: string) {
  console.log(`=== Testing: ${name} ===\n`)

  const runtime = await Effect.runPromise(Effect.runtime<never>())

  const result = await subscribe({
    schema,
    document: parse(query),
    contextValue: { runtime },
  })

  if (Symbol.asyncIterator in (result as any)) {
    const iterator = result as AsyncIterableIterator<any>
    let count = 0

    for await (const value of iterator) {
      count++
      console.log(`  ${count}:`, JSON.stringify(value.data))

      // Limit to 5 items for safety
      if (count >= 5) {
        await iterator.return?.()
        break
      }
    }

    console.log(`  (Received ${count} items)\n`)
  } else {
    console.log("  Error:", result)
    console.log()
  }
}

// Run tests
async function main() {
  try {
    // Test tick subscription
    await runSubscription(
      "Tick Subscription",
      `subscription { tick { count timestamp } }`
    )

    // Test countdown subscription with argument
    await runSubscription(
      "Countdown Subscription (from: 3)",
      `subscription { countdown(from: 3) }`
    )

    // Test messages subscription with resolve transform
    await runSubscription(
      "Messages Subscription (with transform)",
      `subscription { messages { id content author } }`
    )

    console.log("=== All subscription tests passed! ===\n")
  } catch (error) {
    console.error("Test failed:", error)
    process.exit(1)
  }
}

main()
