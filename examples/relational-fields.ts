import { Effect, Layer, Context, Schema as S } from "effect"
import { GraphQLString, GraphQLList, GraphQLNonNull } from "graphql"
import { createServer } from "http"
import {
  createSchemaBuilder,
  resolver,
  createHttpHandler,
  NotFoundError,
  objectType,
  toGraphQLArgs,
  field,
} from "../src"

// Define schemas
const UserSchema = S.Struct({
  id: S.Number,
  name: S.String,
  email: S.String,
})

const OrderSchema = S.Struct({
  id: S.Number,
  userId: S.Number,
  product: S.String,
  amount: S.Number,
  date: S.String,
})

type User = S.Schema.Type<typeof UserSchema>
type Order = S.Schema.Type<typeof OrderSchema>

// Define services
class UserService extends Context.Tag("UserService")<
  UserService,
  {
    readonly getUser: (id: number) => Effect.Effect<User, NotFoundError>
  }
>() {}

class OrderService extends Context.Tag("OrderService")<
  OrderService,
  {
    readonly getOrdersForUser: (
      userId: number,
      startDate?: string,
      endDate?: string
    ) => Effect.Effect<Order[]>
  }
>() {}

// Mock implementations
const UserServiceLive = Layer.succeed(UserService, {
  getUser: (id: number) =>
    id === 1
      ? Effect.succeed({ id: 1, name: "Alice", email: "alice@example.com" })
      : Effect.fail(new NotFoundError({ message: `User ${id} not found` })),
})

const OrderServiceLive = Layer.succeed(OrderService, {
  getOrdersForUser: (userId: number, startDate?: string, endDate?: string) => {
    const allOrders = [
      {
        id: 1,
        userId: 1,
        product: "Laptop",
        amount: 1200,
        date: "2024-01-15",
      },
      {
        id: 2,
        userId: 1,
        product: "Mouse",
        amount: 25,
        date: "2024-02-20",
      },
      {
        id: 3,
        userId: 1,
        product: "Keyboard",
        amount: 80,
        date: "2024-03-10",
      },
    ]

    let filtered = allOrders.filter((o) => o.userId === userId)

    if (startDate) {
      filtered = filtered.filter((o) => o.date >= startDate)
    }
    if (endDate) {
      filtered = filtered.filter((o) => o.date <= endDate)
    }

    return Effect.succeed(filtered)
  },
})

const AppLayer = Layer.mergeAll(UserServiceLive, OrderServiceLive)

// Define argument schema for orders field
const OrdersArgsSchema = S.Struct({
  startDate: S.optional(S.String),
  endDate: S.optional(S.String),
})

// Build the schema
const buildSchema = async () => {
  const builder = createSchemaBuilder(AppLayer)

  // Create Order type (simple, no computed fields)
  const OrderType = objectType<Order>("Order", OrderSchema).build()

  // Create User type with computed orders field
  const UserTypeBuilder = objectType<User, UserService | OrderService>(
    "User",
    UserSchema
  )
    .field("orders", {
      type: new GraphQLList(new GraphQLNonNull(OrderType)),
      argsSchema: OrdersArgsSchema,
      description: "Get orders for this user, optionally filtered by date range",
      resolve: (parent, args: S.Schema.Type<typeof OrdersArgsSchema>) =>
        Effect.gen(function* () {
          const orderService = yield* OrderService
          return yield* orderService.getOrdersForUser(
            parent.id,
            args.startDate,
            args.endDate
          )
        }),
    })

  // Register the builder so it gets the runtime
  builder.registerObjectType(UserTypeBuilder)

  const UserType = UserTypeBuilder.build()

  // Define query schema
  const GetUserArgsSchema = S.Struct({
    id: S.Number.pipe(S.int(), S.positive()),
  })

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
        resolve: resolver(() =>
          Effect.succeed("Try querying user with orders!")
        ),
      },
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
          console.log("\nTry these queries:")
          console.log("  { user(id: 1) { id name email orders { id product amount date } } }")
          console.log('  { user(id: 1) { name orders(startDate: "2024-02-01") { product date } } }')
          console.log(
            '  { user(id: 1) { name orders(startDate: "2024-02-01", endDate: "2024-02-28") { product } } }'
          )
          resolve()
        })
      })
  )
})

Effect.runPromise(main)
