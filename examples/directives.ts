import { Effect, Layer, Context } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder, execute, objectType, directive, query, DirectiveLocation } from "@effect-gql/core"
import { printSchema } from "graphql"

/**
 * Example: Schema Directives
 *
 * Demonstrates:
 * - Defining custom directives with the builder API
 * - Executable directives that transform resolver Effects (e.g., @auth, @log)
 * - Metadata-only directives (e.g., @deprecated)
 * - Applying directives to query/mutation fields
 */

// ============================================================================
// Services
// ============================================================================

// Auth service for checking permissions
class AuthService extends Context.Tag("AuthService")<
  AuthService,
  {
    readonly checkRole: (role: string) => Effect.Effect<void, Error>
    readonly getCurrentUser: () => Effect.Effect<{ id: string; role: string }>
  }
>() {}

// Logger service for logging
class LoggerService extends Context.Tag("LoggerService")<
  LoggerService,
  {
    readonly log: (message: string) => Effect.Effect<void>
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

const SecretSchema = S.Struct({
  id: S.String,
  content: S.String,
})

// ============================================================================
// Mock Data
// ============================================================================

const users: User[] = [
  { id: "1", name: "Alice", email: "alice@example.com", role: "ADMIN" },
  { id: "2", name: "Bob", email: "bob@example.com", role: "USER" },
]

const secrets = [
  { id: "1", content: "Super secret admin data" },
  { id: "2", content: "Another secret" },
]

// ============================================================================
// Build Schema with Directives
// ============================================================================

const builder = GraphQLSchemaBuilder.empty.pipe(
  // Register executable directive: @auth
  // This directive checks if the current user has the required role
  directive<{ readonly role: string }, AuthService>({
    name: "auth",
    description: "Requires authentication with a specific role",
    locations: [DirectiveLocation.FIELD_DEFINITION],
    args: S.Struct({
      role: S.String,
    }),
    apply: (args) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function*() {
        const auth = yield* AuthService
        // Use orDie to convert service errors to defects (preserves E type)
        yield* Effect.orDie(auth.checkRole(args.role))
        return yield* effect
      }),
  }),

  // Register executable directive: @log
  // This directive logs when a resolver is executed
  directive<{ readonly message?: string }, LoggerService>({
    name: "log",
    description: "Logs when this field is accessed",
    locations: [DirectiveLocation.FIELD_DEFINITION],
    args: S.Struct({
      message: S.optional(S.String),
    }),
    apply: (args) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function*() {
        const logger = yield* LoggerService
        yield* logger.log(args.message ?? "Field accessed")
        const result = yield* effect
        yield* logger.log(`Field resolved successfully`)
        return result
      }),
  }),

  // Register metadata-only directive: @deprecated
  // This directive just adds metadata to the schema, no runtime behavior
  directive({
    name: "deprecated",
    description: "Marks a field as deprecated",
    locations: [DirectiveLocation.FIELD_DEFINITION],
    args: S.Struct({
      reason: S.optional(S.String),
    }),
    // No apply function - this is just schema metadata
  }),

  // Register types
  objectType({ name: "User", schema: UserSchema }),
  objectType({ name: "Secret", schema: SecretSchema }),
).pipe(
  // Public query - no directives
  query("users", {
    type: S.Array(UserSchema),
    description: "Get all users (public)",
    resolve: () => Effect.succeed(users),
  }),

  // Query with @log directive
  query("user", {
    type: UserSchema,
    args: S.Struct({ id: S.String }),
    description: "Get a user by ID",
    directives: [{ name: "log", args: { message: "Fetching user by ID" } }],
    resolve: (args: { id: string }) =>
      Effect.sync(() => {
        const user = users.find(u => u.id === args.id)
        if (!user) throw new Error(`User ${args.id} not found`)
        return user
      }),
  }),

  // Query with @auth directive - requires ADMIN role
  query("secrets", {
    type: S.Array(SecretSchema),
    description: "Get all secrets (admin only)",
    directives: [{ name: "auth", args: { role: "ADMIN" } }],
    resolve: () => Effect.succeed(secrets),
  }),

  // Query with multiple directives - @log AND @auth
  query("secret", {
    type: SecretSchema,
    args: S.Struct({ id: S.String }),
    description: "Get a secret by ID (admin only, logged)",
    directives: [
      { name: "log", args: { message: "Accessing secret data" } },
      { name: "auth", args: { role: "ADMIN" } },
    ],
    resolve: (args: { id: string }) =>
      Effect.sync(() => {
        const secret = secrets.find(s => s.id === args.id)
        if (!secret) throw new Error(`Secret ${args.id} not found`)
        return secret
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

// Create service implementations
const authServiceImpl = AuthService.of({
  checkRole: (requiredRole: string) =>
    Effect.gen(function*() {
      const currentUser = { id: "1", role: "ADMIN" } // Simulated current user
      if (currentUser.role !== requiredRole) {
        yield* Effect.fail(new Error(`Access denied: requires ${requiredRole} role`))
      }
    }),
  getCurrentUser: () => Effect.succeed({ id: "1", role: "ADMIN" }),
})

const loggerServiceImpl = LoggerService.of({
  log: (message: string) =>
    Effect.sync(() => console.log(`[LOG] ${message}`)),
})

const layer = Layer.merge(
  Layer.succeed(AuthService, authServiceImpl),
  Layer.succeed(LoggerService, loggerServiceImpl)
)

const runExample = Effect.gen(function*() {
  // Public query - should work
  console.log("\n=== Query: Users (public) ===")
  const usersResult = yield* execute(schema, layer)(
    `query { users { id name email } }`
  )
  console.log(JSON.stringify(usersResult, null, 2))

  // Query with @log directive
  console.log("\n=== Query: User with @log ===")
  const userResult = yield* execute(schema, layer)(
    `query { user(id: "1") { id name email } }`
  )
  console.log(JSON.stringify(userResult, null, 2))

  // Query with @auth directive - should work (we're ADMIN)
  console.log("\n=== Query: Secrets with @auth (as ADMIN) ===")
  const secretsResult = yield* execute(schema, layer)(
    `query { secrets { id content } }`
  )
  console.log(JSON.stringify(secretsResult, null, 2))

  // Query with multiple directives
  console.log("\n=== Query: Secret with @log and @auth ===")
  const secretResult = yield* execute(schema, layer)(
    `query { secret(id: "1") { id content } }`
  )
  console.log(JSON.stringify(secretResult, null, 2))

  // Now test with a non-admin user
  console.log("\n=== Query: Secrets as non-ADMIN (should fail) ===")
  const nonAdminAuth = AuthService.of({
    checkRole: (requiredRole: string) =>
      Effect.fail(new Error(`Access denied: requires ${requiredRole} role, but user is USER`)),
    getCurrentUser: () => Effect.succeed({ id: "2", role: "USER" }),
  })
  const nonAdminLayer = Layer.merge(
    Layer.succeed(AuthService, nonAdminAuth),
    Layer.succeed(LoggerService, loggerServiceImpl)
  )
  const failResult = yield* execute(schema, nonAdminLayer)(
    `query { secrets { id content } }`
  )
  console.log(JSON.stringify(failResult, null, 2))
})

Effect.runPromise(runExample).catch(console.error)
