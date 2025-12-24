import { Effect, Layer } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder, execute, objectType, query } from "@effect-gql/core"
import { printSchema } from "graphql"

/**
 * Test: Optional vs Required Fields
 *
 * Verifies that:
 * - Required fields become non-null (String!)
 * - Optional fields remain nullable (String)
 */

// Schema with mix of required and optional fields
const UserSchema = S.Struct({
  id: S.String,                  // Required -> String!
  name: S.String,                // Required -> String!
  email: S.optional(S.String),   // Optional -> String
  age: S.optional(S.Int),        // Optional -> Int
})

const builder = GraphQLSchemaBuilder.empty.pipe(
  objectType({ name: "User", schema: UserSchema }),
  query("user", {
    type: UserSchema,
    resolve: () => Effect.succeed({ id: "1", name: "Alice" }),
  }),
)

const schema = builder.buildSchema()
console.log("=== Schema with Optional Fields ===\n")
console.log(printSchema(schema))

// Verify the output contains expected patterns
const schemaStr = printSchema(schema)
const checks = [
  { pattern: "id: String!", expected: true, desc: "id should be non-null" },
  { pattern: "name: String!", expected: true, desc: "name should be non-null" },
  { pattern: "email: String!", expected: false, desc: "email should be nullable (no !)" },
  { pattern: "age: Int!", expected: false, desc: "age should be nullable (no !)" },
]

console.log("\n=== Verification ===")
let allPassed = true
for (const check of checks) {
  const found = schemaStr.includes(check.pattern)
  const passed = found === check.expected
  console.log(`${passed ? "✓" : "✗"} ${check.desc}: ${passed ? "PASS" : "FAIL"}`)
  if (!passed) allPassed = false
}

if (allPassed) {
  console.log("\n✓ All checks passed!")
} else {
  console.log("\n✗ Some checks failed!")
  process.exit(1)
}
