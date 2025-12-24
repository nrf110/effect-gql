import { Effect, Layer } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder, execute, objectType, inputType, query, mutation } from "@effect-gql/core"
import { printSchema } from "graphql"

/**
 * Example: Input Types
 *
 * Demonstrates:
 * - Defining input types for complex mutation arguments
 * - Nested input types
 * - Using input types in mutations and queries
 */

// ============================================================================
// Domain Schemas
// ============================================================================

const UserSchema = S.Struct({
  id: S.String,
  name: S.String,
  email: S.String,
  bio: S.optional(S.String),
  website: S.optional(S.String),
})

type User = S.Schema.Type<typeof UserSchema>

// ============================================================================
// Input Type Schemas
// ============================================================================

// Profile input for nested structure
const ProfileInputSchema = S.Struct({
  bio: S.optional(S.String),
  website: S.optional(S.String),
})

type ProfileInput = S.Schema.Type<typeof ProfileInputSchema>

// Create user input
const CreateUserInputSchema = S.Struct({
  name: S.String,
  email: S.String,
  profile: S.optional(ProfileInputSchema),
})

type CreateUserInput = S.Schema.Type<typeof CreateUserInputSchema>

// Update user input
const UpdateUserInputSchema = S.Struct({
  name: S.optional(S.String),
  email: S.optional(S.String),
  profile: S.optional(ProfileInputSchema),
})

type UpdateUserInput = S.Schema.Type<typeof UpdateUserInputSchema>

// Search filter input
const UserFilterInputSchema = S.Struct({
  nameContains: S.optional(S.String),
  emailDomain: S.optional(S.String),
})

type UserFilterInput = S.Schema.Type<typeof UserFilterInputSchema>

// ============================================================================
// Mock Data
// ============================================================================

const users: User[] = [
  { id: "1", name: "Alice", email: "alice@example.com", bio: "Developer", website: "https://alice.dev" },
  { id: "2", name: "Bob", email: "bob@company.com" },
]

let nextId = 3

// ============================================================================
// Build Schema
// ============================================================================

const builder = GraphQLSchemaBuilder.empty.pipe(
  // Register input types first (so they can be used in args)
  inputType({ name: "ProfileInput", schema: ProfileInputSchema, description: "Profile information" }),
  inputType({ name: "CreateUserInput", schema: CreateUserInputSchema, description: "Input for creating a user" }),
  inputType({ name: "UpdateUserInput", schema: UpdateUserInputSchema, description: "Input for updating a user" }),
  inputType({ name: "UserFilterInput", schema: UserFilterInputSchema, description: "Filter criteria for users" }),

  // Register output type
  objectType({ name: "User", schema: UserSchema }),
).pipe(
  // Queries
  query("user", {
    type: UserSchema,
    args: S.Struct({ id: S.String }),
    description: "Get a user by ID",
    resolve: (args: { id: string }) =>
      Effect.sync(() => {
        const user = users.find(u => u.id === args.id)
        if (!user) throw new Error(`User ${args.id} not found`)
        return user
      }),
  }),

  query("users", {
    type: S.Array(UserSchema),
    args: S.Struct({
      filter: S.optional(UserFilterInputSchema),
    }),
    description: "Get users with optional filtering",
    resolve: (args: { filter?: UserFilterInput }) =>
      Effect.succeed(
        args.filter
          ? users.filter(u => {
              if (args.filter!.nameContains && !u.name.toLowerCase().includes(args.filter!.nameContains.toLowerCase())) {
                return false
              }
              if (args.filter!.emailDomain && !u.email.endsWith(`@${args.filter!.emailDomain}`)) {
                return false
              }
              return true
            })
          : users
      ),
  }),

  // Mutations
  mutation("createUser", {
    type: UserSchema,
    args: S.Struct({
      input: CreateUserInputSchema,
    }),
    description: "Create a new user",
    resolve: (args: { input: CreateUserInput }) =>
      Effect.sync(() => {
        const user: User = {
          id: String(nextId++),
          name: args.input.name,
          email: args.input.email,
          bio: args.input.profile?.bio,
          website: args.input.profile?.website,
        }
        users.push(user)
        return user
      }),
  }),

  mutation("updateUser", {
    type: UserSchema,
    args: S.Struct({
      id: S.String,
      input: UpdateUserInputSchema,
    }),
    description: "Update an existing user",
    resolve: (args: { id: string; input: UpdateUserInput }) =>
      Effect.sync(() => {
        const userIndex = users.findIndex(u => u.id === args.id)
        if (userIndex === -1) throw new Error(`User ${args.id} not found`)

        const existingUser = users[userIndex]
        // Create a new user object with updates (Effect Schema types are readonly)
        const updatedUser: User = {
          ...existingUser,
          name: args.input.name ?? existingUser.name,
          email: args.input.email ?? existingUser.email,
          bio: args.input.profile?.bio !== undefined ? args.input.profile.bio : existingUser.bio,
          website: args.input.profile?.website !== undefined ? args.input.profile.website : existingUser.website,
        }
        users[userIndex] = updatedUser

        return updatedUser
      }),
  }),
)

const schema = builder.buildSchema()

// ============================================================================
// Print and Execute
// ============================================================================

console.log("=== GraphQL Schema ===\n")
console.log(printSchema(schema))

const layer = Layer.empty

const runExample = Effect.gen(function*() {
  // Query with filter input
  console.log("\n=== Query: Users filtered by email domain ===")
  const filteredResult = yield* execute(schema, layer)(
    `
      query {
        users(filter: { emailDomain: "example.com" }) {
          id
          name
          email
        }
      }
    `
  )
  console.log(JSON.stringify(filteredResult, null, 2))

  // Create user with input type
  console.log("\n=== Mutation: Create user with profile ===")
  const createResult = yield* execute(schema, layer)(
    `
      mutation {
        createUser(input: {
          name: "Charlie"
          email: "charlie@example.com"
          profile: {
            bio: "Full-stack developer"
            website: "https://charlie.io"
          }
        }) {
          id
          name
          email
          bio
          website
        }
      }
    `
  )
  console.log(JSON.stringify(createResult, null, 2))

  // Update user with partial input
  console.log("\n=== Mutation: Update user profile ===")
  const updateResult = yield* execute(schema, layer)(
    `
      mutation {
        updateUser(id: "2", input: {
          profile: {
            bio: "Backend engineer"
          }
        }) {
          id
          name
          email
          bio
        }
      }
    `
  )
  console.log(JSON.stringify(updateResult, null, 2))

  // Verify update
  console.log("\n=== Query: Get updated user ===")
  const getResult = yield* execute(schema, layer)(
    `
      query {
        user(id: "2") {
          id
          name
          email
          bio
          website
        }
      }
    `
  )
  console.log(JSON.stringify(getResult, null, 2))
})

Effect.runPromise(runExample).catch(console.error)
