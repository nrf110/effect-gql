import { Effect, Layer } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder, execute, extension, query, ExtensionsService } from "@effect-gql/core"
import { printSchema } from "graphql"

/**
 * Example: GraphQL Extensions
 *
 * Demonstrates:
 * - Extension lifecycle hooks (onParse, onValidate, onExecuteStart, onExecuteEnd)
 * - Writing data to the response extensions field
 * - Using set() and merge() for extension data
 * - Multiple extensions composing data
 *
 * Key differences from middleware:
 * - Extensions hook into request lifecycle phases, not individual resolvers
 * - Extensions write to the response `extensions` field for metadata
 * - Middleware wraps resolver execution, extensions wrap request processing
 */

// ============================================================================
// Build Schema with Extensions
// ============================================================================

const builder = GraphQLSchemaBuilder.empty.pipe(
  // ---------------------------------------------
  // Extension 1: Tracing
  // ---------------------------------------------
  // Tracks request timing across execution phases
  extension({
    name: "tracing",
    description: "Tracks request execution timing",
    onExecuteStart: () =>
      Effect.gen(function* () {
        const ext = yield* ExtensionsService
        yield* ext.set("tracing", {
          startTime: Date.now(),
          version: "1.0.0",
        })
      }),
    onExecuteEnd: () =>
      Effect.gen(function* () {
        const ext = yield* ExtensionsService
        const data = yield* ext.get()
        const tracing = data.tracing as { startTime: number } | undefined
        if (tracing?.startTime) {
          yield* ext.merge("tracing", {
            endTime: Date.now(),
            durationMs: Date.now() - tracing.startTime,
          })
        }
      }),
  }),

  // ---------------------------------------------
  // Extension 2: Query Complexity
  // ---------------------------------------------
  // Reports complexity score after validation
  extension({
    name: "complexity",
    description: "Reports query complexity metrics",
    onValidate: (document, errors) =>
      Effect.gen(function* () {
        if (errors.length > 0) return

        // Simple complexity calculation based on selection depth
        let complexity = 0
        const visit = (selections: any, depth: number) => {
          if (!selections) return
          for (const sel of selections) {
            complexity += depth
            if (sel.selectionSet) {
              visit(sel.selectionSet.selections, depth + 1)
            }
          }
        }

        for (const def of document.definitions) {
          if (def.kind === "OperationDefinition" && def.selectionSet) {
            visit(def.selectionSet.selections, 1)
          }
        }

        const ext = yield* ExtensionsService
        yield* ext.set("complexity", {
          score: complexity,
          limit: 100,
          exceeded: complexity > 100,
        })
      }),
  }),

  // ---------------------------------------------
  // Extension 3: Request Info
  // ---------------------------------------------
  // Captures parse and validation info
  extension({
    name: "requestInfo",
    description: "Captures request processing info",
    onParse: (source, document) =>
      Effect.gen(function* () {
        const ext = yield* ExtensionsService
        yield* ext.set("requestInfo", {
          queryLength: source.length,
          operationCount: document.definitions.filter(
            (d) => d.kind === "OperationDefinition"
          ).length,
        })
      }),
    onValidate: (document, errors) =>
      Effect.gen(function* () {
        const ext = yield* ExtensionsService
        yield* ext.merge("requestInfo", {
          validationErrors: errors.length,
          validated: true,
        })
      }),
  }),
)

// Add queries to the builder
const schemaBuilder = builder.pipe(
  query("hello", {
    type: S.String,
    description: "A simple greeting",
    resolve: () => Effect.succeed("Hello, World!"),
  }),

  query("user", {
    type: S.Struct({
      id: S.String,
      name: S.String,
      posts: S.Array(
        S.Struct({
          id: S.String,
          title: S.String,
        })
      ),
    }),
    args: S.Struct({ id: S.String }),
    description: "Get a user with their posts",
    resolve: (args: { id: string }) =>
      Effect.succeed({
        id: args.id,
        name: "Alice",
        posts: [
          { id: "1", title: "First Post" },
          { id: "2", title: "Second Post" },
        ],
      }),
  }),

  query("slow", {
    type: S.String,
    description: "A slow query for testing timing",
    resolve: () =>
      Effect.gen(function* () {
        yield* Effect.sleep("100 millis")
        return "Done after 100ms"
      }),
  }),
)

const schema = schemaBuilder.buildSchema()
const extensions = schemaBuilder.getExtensions()

// ============================================================================
// Print Schema
// ============================================================================

console.log("=== GraphQL Schema ===\n")
console.log(printSchema(schema))

// ============================================================================
// Execute Queries
// ============================================================================

const runExample = Effect.gen(function* () {
  // Query 1: Simple query - see tracing and complexity
  console.log("\n=== Query: hello ===")
  const helloResult = yield* execute(schema, Layer.empty, extensions)("{ hello }")
  console.log(JSON.stringify(helloResult, null, 2))

  // Query 2: Nested query - see complexity increase
  console.log("\n=== Query: user with nested posts ===")
  const userResult = yield* execute(schema, Layer.empty, extensions)(
    `query { user(id: "1") { id name posts { id title } } }`
  )
  console.log(JSON.stringify(userResult, null, 2))

  // Query 3: Slow query - see timing
  console.log("\n=== Query: slow (100ms delay) ===")
  const slowResult = yield* execute(schema, Layer.empty, extensions)("{ slow }")
  console.log(JSON.stringify(slowResult, null, 2))

  // Query 4: Multiple operations in document
  console.log("\n=== Query: multiple fields ===")
  const multiResult = yield* execute(schema, Layer.empty, extensions)(
    `query { hello user(id: "2") { name } }`
  )
  console.log(JSON.stringify(multiResult, null, 2))

  // Query 5: Invalid query - see validation error in requestInfo
  console.log("\n=== Query: invalid field ===")
  const invalidResult = yield* execute(schema, Layer.empty, extensions)(
    "{ nonExistent }"
  )
  console.log(JSON.stringify(invalidResult, null, 2))

  // Query 6: Parse error - see only parse-related extensions
  console.log("\n=== Query: syntax error ===")
  const parseErrorResult = yield* execute(schema, Layer.empty, extensions)(
    "{ invalid syntax"
  )
  console.log(JSON.stringify(parseErrorResult, null, 2))
})

Effect.runPromise(runExample).catch((error) => {
  Effect.runPromise(Effect.logError("Example failed", error))
})
