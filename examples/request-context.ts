/**
 * Example: Using Request-Scoped Context
 *
 * This example demonstrates how to access request-specific data
 * (headers, query, variables) in your resolvers using Effect's
 * Context system.
 */

import { Effect, Layer, Context } from "effect"
import * as S from "effect/Schema"
import {
  GraphQLSchemaBuilder,
  GraphQLRequestContext,
  makeRequestContextLayer,
  execute,
} from "@effect-gql/core"

// =============================================================================
// Define a simple auth service that uses request context
// =============================================================================

interface AuthService {
  readonly getCurrentUserId: () => Effect.Effect<string, Error, GraphQLRequestContext>
}

const AuthService = Context.GenericTag<AuthService>("AuthService")

const AuthServiceLive = Layer.succeed(AuthService, {
  getCurrentUserId: () =>
    Effect.gen(function* () {
      const ctx = yield* GraphQLRequestContext
      const authHeader = ctx.request.headers["authorization"]

      if (!authHeader?.startsWith("Bearer ")) {
        return yield* Effect.fail(new Error("Missing or invalid authorization header"))
      }

      // In a real app, you'd validate the token here
      const token = authHeader.slice(7)
      return `user_${token}`
    }),
})

// =============================================================================
// Define schemas and build the GraphQL schema
// =============================================================================

const UserSchema = S.Struct({
  id: S.String,
  name: S.String,
})

const schema = GraphQLSchemaBuilder.empty
  .objectType({ name: "User", schema: UserSchema })
  .query("me", {
    type: UserSchema,
    description: "Get the currently authenticated user",
    resolve: () =>
      Effect.gen(function* () {
        const auth = yield* AuthService
        const userId = yield* auth.getCurrentUserId()
        return { id: userId, name: "Current User" }
      }),
  })
  .query("requestInfo", {
    type: S.Struct({
      query: S.String,
      hasVariables: S.Boolean,
      operationName: S.optional(S.String),
    }),
    description: "Returns information about the current GraphQL request",
    resolve: () =>
      Effect.gen(function* () {
        const ctx = yield* GraphQLRequestContext
        return {
          query: ctx.request.query,
          hasVariables: Object.keys(ctx.request.variables ?? {}).length > 0,
          operationName: ctx.request.operationName,
        }
      }),
  })
  .buildSchema()

// =============================================================================
// Execute a query with request context
// =============================================================================

const runExample = async () => {
  const query = `
    query GetMe {
      me { id name }
      requestInfo { query hasVariables operationName }
    }
  `

  // Create request-scoped layer with headers and request data
  const requestLayer = makeRequestContextLayer({
    request: {
      headers: {
        authorization: "Bearer abc123",
        "content-type": "application/json",
      },
      query,
      variables: {},
      operationName: "GetMe",
    },
  })

  // Combine request context with services
  const fullLayer = Layer.merge(requestLayer, AuthServiceLive)

  // Execute the query
  const result = await Effect.runPromise(execute(schema, fullLayer)(query))

  console.log("Result:", JSON.stringify(result, null, 2))
}

runExample().catch(console.error)
