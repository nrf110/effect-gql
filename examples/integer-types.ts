import { Effect, Layer } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder, execute, objectType, query } from "../src/builder"
import { printSchema } from "graphql"

/**
 * Example: Integer vs Float Type Detection
 *
 * Demonstrates how Effect Schema integers (S.Int) are mapped to GraphQLInt
 * while regular numbers are mapped to GraphQLFloat.
 */

// Schema with both integers and floats
const ProductSchema = S.Struct({
  id: S.Int,                    // Integer -> GraphQLInt
  name: S.String,
  quantity: S.Int,              // Integer -> GraphQLInt
  price: S.Number,              // Float -> GraphQLFloat
  rating: S.Number,             // Float -> GraphQLFloat
  stockLevel: S.Int.pipe(       // Integer with refinements -> GraphQLInt
    S.greaterThanOrEqualTo(0)
  ),
})

type Product = S.Schema.Type<typeof ProductSchema>

const StatsSchema = S.Struct({
  totalProducts: S.Int,
  averagePrice: S.Number,
  averageRating: S.Number,
})

// Mock data
const products: Product[] = [
  { id: 1, name: "Widget", quantity: 100, price: 29.99, rating: 4.5, stockLevel: 100 },
  { id: 2, name: "Gadget", quantity: 50, price: 49.99, rating: 4.8, stockLevel: 50 },
]

// Build schema
const builder = GraphQLSchemaBuilder.empty.pipe(
  objectType("Product", ProductSchema),
  objectType("Stats", StatsSchema),

  query("product", {
    type: ProductSchema,
    args: S.Struct({
      id: S.Int,  // Integer argument
    }),
    resolve: (args: { id: number }) =>
      Effect.sync(() => {
        const product = products.find(p => p.id === args.id)
        if (!product) throw new Error(`Product ${args.id} not found`)
        return product
      }),
  }),

  query("products", {
    type: S.Array(ProductSchema),
    resolve: () => Effect.succeed(products),
  }),

  query("stats", {
    type: StatsSchema,
    resolve: () =>
      Effect.succeed({
        totalProducts: products.length,
        averagePrice: products.reduce((sum, p) => sum + p.price, 0) / products.length,
        averageRating: products.reduce((sum, p) => sum + p.rating, 0) / products.length,
      }),
  })
)

const schema = builder.buildSchema()

// Print the schema to see the types
console.log("=== GraphQL Schema ===\n")
console.log(printSchema(schema))

// Execute a query
const layer = Layer.empty

const runExample = Effect.gen(function*() {
  console.log("\n=== Query: Product with mixed types ===")
  const result = yield* execute(schema, layer)(
    `
      query {
        product(id: 1) {
          id
          name
          quantity
          price
          rating
          stockLevel
        }
        stats {
          totalProducts
          averagePrice
          averageRating
        }
      }
    `
  )
  console.log(JSON.stringify(result, null, 2))
})

Effect.runPromise(runExample).catch(console.error)
