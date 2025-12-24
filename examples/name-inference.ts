import { Effect, Layer } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder, execute, objectType, query } from "@effect-gql/core"
import { printSchema } from "graphql"

/**
 * Example: Name Inference
 *
 * Demonstrates:
 * - Automatic name inference from TaggedStruct
 * - Automatic name inference from Schema.Class
 * - Automatic name inference from TaggedClass
 */

// ============================================================================
// Test 1: TaggedStruct - should infer name "Person"
// ============================================================================

const PersonSchema = S.TaggedStruct("Person", {
  id: S.String,
  name: S.String,
})

type Person = S.Schema.Type<typeof PersonSchema>

// ============================================================================
// Test 2: Schema.Class - should infer name "Animal"
// ============================================================================

class Animal extends S.Class<Animal>("Animal")({
  id: S.String,
  species: S.String,
}) {}

// ============================================================================
// Test 3: TaggedClass - should infer name "Vehicle"
// ============================================================================

class Vehicle extends S.TaggedClass<Vehicle>()("Vehicle", {
  id: S.String,
  type: S.String,
}) {}

// ============================================================================
// Build Schema - No explicit names provided!
// ============================================================================

const builder = GraphQLSchemaBuilder.empty.pipe(
  // No name provided - should be inferred from _tag / identifier
  objectType({ schema: PersonSchema }),
  objectType({ schema: Animal }),
  objectType({ schema: Vehicle }),

  query("person", {
    type: PersonSchema,
    resolve: () => Effect.succeed({ _tag: "Person" as const, id: "1", name: "Alice" }),
  }),
  query("animal", {
    type: Animal,
    resolve: () => Effect.succeed(new Animal({ id: "1", species: "Dog" })),
  }),
  query("vehicle", {
    type: Vehicle,
    resolve: () => Effect.succeed(new Vehicle({ id: "1", type: "Car" })),
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
  console.log("\n=== Query: Person ===")
  const personResult = yield* execute(schema, layer)(
    `
      query {
        person {
          id
          name
        }
      }
    `
  )
  console.log(JSON.stringify(personResult, null, 2))

  console.log("\n=== Query: Animal ===")
  const animalResult = yield* execute(schema, layer)(
    `
      query {
        animal {
          id
          species
        }
      }
    `
  )
  console.log(JSON.stringify(animalResult, null, 2))

  console.log("\n=== Query: Vehicle ===")
  const vehicleResult = yield* execute(schema, layer)(
    `
      query {
        vehicle {
          id
          type
        }
      }
    `
  )
  console.log(JSON.stringify(vehicleResult, null, 2))
})

Effect.runPromise(runExample).catch(console.error)
