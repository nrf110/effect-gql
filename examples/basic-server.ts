import { Effect, Layer, Context } from "effect"
import { GraphQLString, GraphQLObjectType, GraphQLInt, GraphQLNonNull } from "graphql"
import { createServer } from "http"
import {
  createSchemaBuilder,
  resolver,
  createHttpHandler,
  ValidationError,
  NotFoundError,
} from "../src"

// Define a service for user data
interface User {
  id: number
  name: string
  email: string
}

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
    email.includes("@")
      ? Effect.succeed({ id: 2, name, email })
      : Effect.fail(
          new ValidationError({
            message: "Invalid email format",
            field: "email",
          })
        ),
})

// Define GraphQL types
const UserType = new GraphQLObjectType({
  name: "User",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLInt) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    email: { type: new GraphQLNonNull(GraphQLString) },
  },
})

// Build the schema
const buildSchema = async () => {
  const builder = createSchemaBuilder(UserServiceLive)

  return builder.build({
    query: {
      user: {
        type: UserType,
        args: {
          id: { type: new GraphQLNonNull(GraphQLInt) },
        },
        resolve: resolver(({ id }: { id: number }) =>
          Effect.gen(function* () {
            const userService = yield* UserService
            return yield* userService.getUser(id)
          })
        ),
      },
      hello: {
        type: GraphQLString,
        resolve: resolver(() => Effect.succeed("Hello from Effect GraphQL!")),
      },
    },
    mutation: {
      createUser: {
        type: UserType,
        args: {
          name: { type: new GraphQLNonNull(GraphQLString) },
          email: { type: new GraphQLNonNull(GraphQLString) },
        },
        resolve: resolver(
          ({ name, email }: { name: string; email: string }) =>
            Effect.gen(function* () {
              const userService = yield* UserService
              return yield* userService.createUser(name, email)
            })
        ),
      },
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
