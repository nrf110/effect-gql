import { Effect, Layer, Context, Schema as S } from "effect"
import { GraphQLString } from "graphql"
import { createServer } from "http"
import {
  createSchemaBuilder,
  resolver,
  createHttpHandler,
  ValidationError,
  NotFoundError,
  toGraphQLObjectType,
  field,
} from "../src"

// Define User schema with Effect Schema
const UserSchema = S.Struct({
  id: S.Number,
  name: S.String,
  email: S.String,
})

// Derive TypeScript type from schema
type User = S.Schema.Type<typeof UserSchema>

// Derive GraphQL type from schema
const UserType = toGraphQLObjectType("User", UserSchema)

// Define argument schemas with validation
const GetUserArgsSchema = S.Struct({
  id: S.Number.pipe(S.int(), S.positive()),
})

const CreateUserArgsSchema = S.Struct({
  name: S.String.pipe(S.minLength(1), S.maxLength(100)),
  email: S.String.pipe(S.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
})

class UserService extends Context.Tag("UserService")<
  UserService,
  {
    readonly getUser: (id: number) => Effect.Effect<User, NotFoundError>
    readonly createUser: (
      name: string,
      email: string
    ) => Effect.Effect<User, ValidationError>
  }
>() {}

// Mock implementation
const UserServiceLive = Layer.succeed(UserService, {
  getUser: (id: number) =>
    id === 1
      ? Effect.succeed({ id: 1, name: "Alice", email: "alice@example.com" })
      : Effect.fail(new NotFoundError({ message: `User ${id} not found` })),

  createUser: (name: string, email: string) =>
    Effect.succeed({ id: Math.floor(Math.random() * 1000), name, email }),
})

// Build the schema
const buildSchema = async () => {
  const builder = createSchemaBuilder(UserServiceLive)

  return builder.build({
    query: {
      user: field({
        type: UserType,
        argsSchema: GetUserArgsSchema,
        resolve: ({ id }) =>
          Effect.gen(function* () {
            const userService = yield* UserService
            return yield* userService.getUser(id)
          }),
      }),
      hello: {
        type: GraphQLString,
        resolve: resolver(() => Effect.succeed("Hello from Effect GraphQL!")),
      },
    },
    mutation: {
      createUser: field({
        type: UserType,
        argsSchema: CreateUserArgsSchema,
        resolve: ({ name, email }) =>
          Effect.gen(function* () {
            const userService = yield* UserService
            return yield* userService.createUser(name, email)
          }),
      }),
    },
  })
}

// Start the server
const main = Effect.gen(function* () {
  const schema = yield* Effect.promise(() => buildSchema())
  const handler = createHttpHandler(schema)

  const server = createServer(handler)
  
  yield* Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        server.listen(4000, () => {
          console.log("🚀 Server ready at http://localhost:4000")
          console.log("\nTry these queries:")
          console.log('  { hello }')
          console.log('  { user(id: 1) { id name email } }')
          resolve()
        })
      })
  )
})

Effect.runPromise(main)
