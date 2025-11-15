import { Effect, Layer, Context, Schema as S } from "effect"
import { GraphQLString } from "graphql"
import { createServer } from "http"
import {
  createSchemaBuilder,
  resolver,
  createHttpHandler,
  ValidationError,
  toGraphQLObjectType,
  field,
} from "../src"

// Define schemas with validation
const EmailSchema = S.String.pipe(
  S.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
  S.brand("Email")
)

const UserSchema = S.Struct({
  id: S.Number,
  name: S.String.pipe(S.minLength(1), S.maxLength(100)),
  email: EmailSchema,
  age: S.optional(S.Number.pipe(S.int(), S.greaterThanOrEqualTo(0))),
})

type User = S.Schema.Type<typeof UserSchema>

// Derive GraphQL type
const UserType = toGraphQLObjectType("User", UserSchema)

// Define argument schema with validation
const CreateUserArgsSchema = S.Struct({
  name: S.String.pipe(S.minLength(1), S.maxLength(100)),
  email: EmailSchema,
  age: S.optional(S.Number.pipe(S.int(), S.greaterThanOrEqualTo(0), S.lessThanOrEqualTo(150))),
})

// Service
class UserService extends Context.Tag("UserService")<
  UserService,
  {
    readonly createUser: (input: {
      name: string
      email: string
      age?: number
    }) => Effect.Effect<User, ValidationError>
  }
>() {}

const UserServiceLive = Layer.succeed(UserService, {
  createUser: (input) =>
    Effect.gen(function* () {
      // Validate the complete user object with the schema
      const user = yield* S.decodeUnknown(UserSchema)({
        id: Math.floor(Math.random() * 1000),
        ...input,
      }).pipe(
        Effect.mapError(
          (error) =>
            new ValidationError({
              message: `User validation failed: ${error.message}`,
            })
        )
      )
      return user
    }),
})

// Build schema
const buildSchema = async () => {
  const builder = createSchemaBuilder(UserServiceLive)

  return builder.build({
    query: {
      hello: {
        type: GraphQLString,
        resolve: resolver(() =>
          Effect.succeed("Try the createUser mutation with validation!")
        ),
      },
    },
    mutation: {
      createUser: field({
        type: UserType,
        argsSchema: CreateUserArgsSchema,
        description: "Create a new user with validated input",
        resolve: ({ name, email, age }) =>
          Effect.gen(function* () {
            const userService = yield* UserService
            return yield* userService.createUser({ name, email, age })
          }),
      }),
    },
  })
}

// Start server
const main = Effect.gen(function* () {
  const schema = yield* Effect.promise(() => buildSchema())
  const handler = createHttpHandler(schema)

  const server = createServer(handler)

  yield* Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        server.listen(4000, () => {
          console.log("🚀 Server ready at http://localhost:4000")
          console.log("\nTry this mutation:")
          console.log('  mutation { createUser(name: "Bob", email: "bob@example.com", age: 25) { id name email age } }')
          console.log("\nThis will fail validation:")
          console.log('  mutation { createUser(name: "", email: "invalid-email") { id name email } }')
          resolve()
        })
      })
  )
})

Effect.runPromise(main)
