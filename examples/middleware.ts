import { Effect, Layer, Context, Ref } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder, execute, objectType, middleware, query } from "@effect-gql/core"
import { printSchema } from "graphql"

/**
 * Example: Resolver Middleware
 *
 * Demonstrates:
 * - Global middleware that applies to all resolvers
 * - Pattern-matched middleware using the `match` predicate
 * - Middleware that wraps resolvers in "onion" order (first = outermost)
 * - Accessing the full resolver context (parent, args, info)
 * - Composing middleware with directives
 *
 * Key differences from directives:
 * - Directives are per-field, explicit (`directives: [{ name: "auth" }]`)
 * - Middleware is global or pattern-matched, applied automatically
 */

// ============================================================================
// Services
// ============================================================================

// Auth service for checking permissions
class AuthService extends Context.Tag("AuthService")<
  AuthService,
  {
    readonly requireAdmin: () => Effect.Effect<void, Error>
    readonly getCurrentUser: () => Effect.Effect<{ id: string; role: string }>
  }
>() {}

// Metrics service for tracking resolver execution
class MetricsService extends Context.Tag("MetricsService")<
  MetricsService,
  {
    readonly recordTiming: (fieldName: string, durationMs: number) => Effect.Effect<void>
    readonly recordAccess: (fieldName: string) => Effect.Effect<void>
  }
>() {}

// ============================================================================
// Domain Schemas
// ============================================================================

const UserSchema = S.Struct({
  id: S.String,
  name: S.String,
  email: S.String,
  role: S.String,
})

type User = S.Schema.Type<typeof UserSchema>

// ============================================================================
// Mock Data
// ============================================================================

const users: User[] = [
  { id: "1", name: "Alice", email: "alice@example.com", role: "ADMIN" },
  { id: "2", name: "Bob", email: "bob@example.com", role: "USER" },
  { id: "3", name: "Charlie", email: "charlie@example.com", role: "USER" },
]

// ============================================================================
// Build Schema with Middleware
// ============================================================================

const builder = GraphQLSchemaBuilder.empty.pipe(
  // ---------------------------------------------
  // Middleware 1: Logging (applies to all fields)
  // ---------------------------------------------
  // This is the FIRST registered middleware, so it's the OUTERMOST layer
  // It executes first before any other middleware/resolver, and last after
  middleware({
    name: "logging",
    description: "Logs all field resolutions",
    apply: (effect, ctx) =>
      Effect.gen(function*() {
        const fieldPath = `${ctx.info.parentType.name}.${ctx.info.fieldName}`
        yield* Effect.logInfo(`[START] Resolving ${fieldPath}`)
        const startTime = Date.now()

        const result = yield* effect

        const duration = Date.now() - startTime
        yield* Effect.logInfo(`[END] Resolved ${fieldPath} in ${duration}ms`)
        return result
      }),
  }),

  // ---------------------------------------------
  // Middleware 2: Metrics (applies to all fields)
  // ---------------------------------------------
  // This is the SECOND registered middleware, so it's an INNER layer
  middleware<MetricsService>({
    name: "metrics",
    description: "Records resolver timing metrics",
    apply: (effect, ctx) =>
      Effect.gen(function*() {
        const metrics = yield* MetricsService
        const fieldPath = `${ctx.info.parentType.name}.${ctx.info.fieldName}`

        yield* metrics.recordAccess(fieldPath)
        const startTime = Date.now()

        const result = yield* effect

        yield* metrics.recordTiming(fieldPath, Date.now() - startTime)
        return result
      }),
  }),

  // ---------------------------------------------
  // Middleware 3: Admin-only (pattern matched)
  // ---------------------------------------------
  // Only applies to fields starting with "admin"
  middleware<AuthService>({
    name: "adminOnly",
    description: "Requires admin role for admin* fields",
    match: (info) => info.fieldName.startsWith("admin"),
    apply: (effect) =>
      Effect.gen(function*() {
        const auth = yield* AuthService
        yield* Effect.catchAll(auth.requireAdmin(), (error) =>
          Effect.fail(new Error(`Admin access required: ${error.message}`))
        )
        return yield* effect
      }),
  }),

  // ---------------------------------------------
  // Middleware 4: Error normalization (applies to all)
  // ---------------------------------------------
  // Normalizes errors to a consistent format
  middleware({
    name: "errorNormalization",
    description: "Normalizes errors to a consistent format",
    apply: (effect, ctx) =>
      Effect.catchAll(effect, (error) =>
        Effect.fail(new Error(
          `Error in ${ctx.info.parentType.name}.${ctx.info.fieldName}: ${
            error instanceof Error ? error.message : String(error)
          }`
        ))
      ),
  }),

  // Register types
  objectType({ name: "User", schema: UserSchema }),
).pipe(
  // Public query - all middleware applies except adminOnly (doesn't match pattern)
  query("users", {
    type: S.Array(UserSchema),
    description: "Get all users",
    resolve: () => Effect.succeed(users),
  }),

  // Public query with args
  query("user", {
    type: UserSchema,
    args: S.Struct({ id: S.String }),
    description: "Get a user by ID",
    resolve: (args: { id: string }) =>
      Effect.gen(function*() {
        const user = users.find(u => u.id === args.id)
        if (!user) {
          yield* Effect.fail(new Error(`User not found: ${args.id}`))
        }
        return user!
      }),
  }),

  // Admin-only query - adminOnly middleware applies due to name pattern
  query("adminUsers", {
    type: S.Array(UserSchema),
    description: "Get all users (admin only)",
    resolve: () => Effect.succeed(users),
  }),

  // Another admin query
  query("adminStats", {
    type: S.Struct({
      totalUsers: S.Number,
      adminCount: S.Number,
    }),
    description: "Get admin statistics",
    resolve: () =>
      Effect.succeed({
        totalUsers: users.length,
        adminCount: users.filter(u => u.role === "ADMIN").length,
      }),
  }),
)

const schema = builder.buildSchema()

// ============================================================================
// Print Schema
// ============================================================================

console.log("=== GraphQL Schema ===\n")
console.log(printSchema(schema))

// ============================================================================
// Execute Queries
// ============================================================================

// Track metrics in a ref for demonstration
const createMetricsService = (metricsRef: Ref.Ref<Map<string, { count: number; totalMs: number }>>) =>
  MetricsService.of({
    recordTiming: (fieldName, durationMs) =>
      Ref.update(metricsRef, (m) => {
        const current = m.get(fieldName) ?? { count: 0, totalMs: 0 }
        m.set(fieldName, { count: current.count, totalMs: current.totalMs + durationMs })
        return m
      }),
    recordAccess: (fieldName) =>
      Ref.update(metricsRef, (m) => {
        const current = m.get(fieldName) ?? { count: 0, totalMs: 0 }
        m.set(fieldName, { count: current.count + 1, totalMs: current.totalMs })
        return m
      }),
  })

const runExample = Effect.gen(function*() {
  // Create a metrics ref to track calls
  const metricsRef = yield* Ref.make(new Map<string, { count: number; totalMs: number }>())

  // Admin user auth
  const adminAuth = AuthService.of({
    requireAdmin: () => Effect.void,
    getCurrentUser: () => Effect.succeed({ id: "1", role: "ADMIN" }),
  })

  // Non-admin user auth
  const userAuth = AuthService.of({
    requireAdmin: () => Effect.fail(new Error("User is not an admin")),
    getCurrentUser: () => Effect.succeed({ id: "2", role: "USER" }),
  })

  const adminLayer = Layer.merge(
    Layer.succeed(AuthService, adminAuth),
    Layer.succeed(MetricsService, createMetricsService(metricsRef))
  )

  const userLayer = Layer.merge(
    Layer.succeed(AuthService, userAuth),
    Layer.succeed(MetricsService, createMetricsService(metricsRef))
  )

  // Query 1: Public query - all middleware runs except adminOnly
  console.log("\n=== Query: users (public) ===")
  const usersResult = yield* execute(schema, adminLayer)(
    `query { users { id name role } }`
  )
  console.log(JSON.stringify(usersResult, null, 2))

  // Query 2: Public query with error - tests error normalization
  console.log("\n=== Query: user with invalid ID ===")
  const notFoundResult = yield* execute(schema, adminLayer)(
    `query { user(id: "999") { id name } }`
  )
  console.log(JSON.stringify(notFoundResult, null, 2))

  // Query 3: Admin query as admin - should succeed
  console.log("\n=== Query: adminUsers (as admin) ===")
  const adminUsersResult = yield* execute(schema, adminLayer)(
    `query { adminUsers { id name role } }`
  )
  console.log(JSON.stringify(adminUsersResult, null, 2))

  // Query 4: Admin query as regular user - should fail
  console.log("\n=== Query: adminUsers (as regular user) ===")
  const unauthorizedResult = yield* execute(schema, userLayer)(
    `query { adminUsers { id name role } }`
  )
  console.log(JSON.stringify(unauthorizedResult, null, 2))

  // Query 5: Multiple fields in one query - shows middleware running for each
  console.log("\n=== Query: Multiple fields ===")
  const multiResult = yield* execute(schema, adminLayer)(
    `query {
      users { id name }
      adminStats { totalUsers adminCount }
    }`
  )
  console.log(JSON.stringify(multiResult, null, 2))

  // Print collected metrics
  const metrics = yield* Ref.get(metricsRef)
  console.log("\n=== Collected Metrics ===")
  for (const [field, data] of metrics.entries()) {
    console.log(`${field}: ${data.count} calls, ${data.totalMs}ms total`)
  }
})

Effect.runPromise(runExample).catch((error) => {
  Effect.runPromise(Effect.logError("Example failed", error))
})
