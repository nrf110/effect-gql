import { Effect, Layer } from "effect"
import { GraphQLSchemaBuilder, execute, compose } from "../../src/builder"
import { userType, userQueries, userMutations } from "./user-schema"
import { postType } from "./post-schema"
import { DatabaseServiceLive, LoggerServiceLive } from "./services"

/**
 * Example: Pipe-based API
 *
 * Demonstrates how to use the pipe-based API to compose schema definitions
 * across multiple files, similar to HttpLayerRouter.
 */

// ============================================================================
// Assemble Schema Using Pipe
// ============================================================================

const builder = GraphQLSchemaBuilder.empty.pipe(
  // Add types (from separate files)
  userType,
  postType,

  // Add queries (use compose for arrays)
  compose(...userQueries),

  // Add mutations
  compose(...userMutations)
)

const schema = builder.buildSchema()

console.log("✓ Schema built successfully using pipe API")

// ============================================================================
// Execute Queries
// ============================================================================

const layer = Layer.mergeAll(DatabaseServiceLive, LoggerServiceLive)

const runExample = Effect.gen(function*() {
  console.log("\n=== Query: User with nested data ===")
  const result1 = yield* execute(schema, layer)(
    `
      query {
        user(id: "1") {
          id
          name
          displayName
          posts(limit: 1) {
            id
            title
            author {
              name
              email
            }
          }
        }
      }
    `
  )
  console.log(JSON.stringify(result1, null, 2))

  console.log("\n=== Query: All users ===")
  const result2 = yield* execute(schema, layer)(
    `
      query {
        users {
          name
          displayName
          posts {
            title
          }
        }
      }
    `
  )
  console.log(JSON.stringify(result2, null, 2))

  console.log("\n=== Mutation: Create user ===")
  const result3 = yield* execute(schema, layer)(
    `
      mutation {
        createUser(name: "Charlie", email: "charlie@example.com") {
          id
          name
          displayName
        }
      }
    `
  )
  console.log(JSON.stringify(result3, null, 2))
})

Effect.runPromise(runExample).catch(console.error)
