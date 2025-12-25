import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { GraphQLSchema, GraphQLObjectType, GraphQLString, GraphQLList, GraphQLInt, GraphQLNonNull, buildSchema } from "graphql"
import {
  validateComplexity,
  defaultComplexityCalculator,
  depthOnlyCalculator,
  combineCalculators,
  ComplexityLimitExceededError,
  ComplexityAnalysisError,
  type FieldComplexityMap,
  type ComplexityConfig,
} from "../../../src/server/complexity"

// Helper to run complexity validation
const runValidation = (
  query: string,
  schema: GraphQLSchema,
  config: ComplexityConfig,
  fieldComplexities: FieldComplexityMap = new Map(),
  operationName?: string,
  variables?: Record<string, unknown>
) =>
  Effect.runPromiseExit(
    validateComplexity(query, operationName, variables, schema, fieldComplexities, config)
  )

// Test schema
const testSchema = buildSchema(`
  type Query {
    user(id: ID!): User
    users(limit: Int = 10): [User]
    hello: String
  }

  type User {
    id: ID!
    name: String
    email: String
    posts(limit: Int = 10): [Post]
    friends: [User]
  }

  type Post {
    id: ID!
    title: String
    content: String
    author: User
    comments: [Comment]
  }

  type Comment {
    id: ID!
    text: String
    author: User
  }
`)

describe("Complexity Analysis", () => {
  describe("validateComplexity", () => {
    it("should pass when query is within limits", async () => {
      const query = `{ hello }`
      const result = await runValidation(query, testSchema, {
        maxDepth: 10,
        maxComplexity: 100,
      })

      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(result.value.depth).toBe(1)
        expect(result.value.complexity).toBeGreaterThan(0)
      }
    })

    it("should fail when depth exceeds limit", async () => {
      const query = `{
        user(id: "1") {
          posts {
            comments {
              author {
                name
              }
            }
          }
        }
      }`

      const result = await runValidation(query, testSchema, {
        maxDepth: 3,
      })

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const error = result.cause
        expect(error._tag).toBe("Fail")
        if (error._tag === "Fail") {
          expect(error.error._tag).toBe("ComplexityLimitExceededError")
          if (error.error._tag === "ComplexityLimitExceededError") {
            expect(error.error.limitType).toBe("depth")
          }
        }
      }
    })

    it("should fail when complexity exceeds limit", async () => {
      const query = `{
        users {
          id
          name
          email
          posts {
            id
            title
            content
          }
        }
      }`

      const result = await runValidation(query, testSchema, {
        maxComplexity: 5,
      })

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const error = result.cause
        expect(error._tag).toBe("Fail")
        if (error._tag === "Fail") {
          expect(error.error._tag).toBe("ComplexityLimitExceededError")
          if (error.error._tag === "ComplexityLimitExceededError") {
            expect(error.error.limitType).toBe("complexity")
          }
        }
      }
    })

    it("should fail when alias count exceeds limit", async () => {
      const query = `{
        a1: hello
        a2: hello
        a3: hello
        a4: hello
        a5: hello
      }`

      const result = await runValidation(query, testSchema, {
        maxAliases: 3,
      })

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const error = result.cause
        expect(error._tag).toBe("Fail")
        if (error._tag === "Fail") {
          expect(error.error._tag).toBe("ComplexityLimitExceededError")
          if (error.error._tag === "ComplexityLimitExceededError") {
            expect(error.error.limitType).toBe("aliases")
          }
        }
      }
    })

    it("should fail when field count exceeds limit", async () => {
      const query = `{
        user(id: "1") {
          id
          name
          email
          posts {
            id
            title
            content
          }
        }
      }`

      const result = await runValidation(query, testSchema, {
        maxFields: 5,
      })

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const error = result.cause
        expect(error._tag).toBe("Fail")
        if (error._tag === "Fail") {
          expect(error.error._tag).toBe("ComplexityLimitExceededError")
          if (error.error._tag === "ComplexityLimitExceededError") {
            expect(error.error.limitType).toBe("fields")
          }
        }
      }
    })

    it("should use custom field complexities", async () => {
      const query = `{ users { id } }`

      const fieldComplexities: FieldComplexityMap = new Map([
        ["Query.users", 50], // High cost for users field
      ])

      const result = await runValidation(query, testSchema, {
        maxComplexity: 40,
      }, fieldComplexities)

      expect(result._tag).toBe("Failure")
    })

    it("should use dynamic field complexity based on arguments", async () => {
      const query = `{ users(limit: 100) { id } }`

      const fieldComplexities: FieldComplexityMap = new Map([
        ["Query.users", (args: Record<string, unknown>) => ((args.limit as number) ?? 10) * 2],
      ])

      const result = await runValidation(query, testSchema, {
        maxComplexity: 100,
      }, fieldComplexities)

      expect(result._tag).toBe("Failure")
    })

    it("should handle fragments correctly", async () => {
      const query = `
        fragment UserFields on User {
          id
          name
          email
        }

        query {
          user(id: "1") {
            ...UserFields
          }
        }
      `

      const result = await runValidation(query, testSchema, {
        maxDepth: 10,
        maxComplexity: 100,
      })

      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(result.value.fieldCount).toBeGreaterThan(3) // user + fragment fields
      }
    })

    it("should handle inline fragments correctly", async () => {
      const query = `{
        user(id: "1") {
          ... on User {
            id
            name
          }
        }
      }`

      const result = await runValidation(query, testSchema, {
        maxDepth: 10,
      })

      expect(result._tag).toBe("Success")
    })

    it("should handle multiple operations with operationName", async () => {
      const query = `
        query GetUser {
          user(id: "1") { id }
        }

        query GetHello {
          hello
        }
      `

      const result = await runValidation(query, testSchema, {
        maxDepth: 10,
      }, new Map(), "GetHello")

      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(result.value.depth).toBe(1)
      }
    })

    it("should fail for multiple operations without operationName", async () => {
      const query = `
        query GetUser {
          user(id: "1") { id }
        }

        query GetHello {
          hello
        }
      `

      const result = await runValidation(query, testSchema, {
        maxDepth: 10,
      })

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const error = result.cause
        expect(error._tag).toBe("Fail")
        if (error._tag === "Fail") {
          expect(error.error._tag).toBe("ComplexityAnalysisError")
        }
      }
    })

    it("should call onExceeded hook when limit is exceeded", async () => {
      const query = `{
        user(id: "1") {
          posts {
            comments {
              author {
                name
              }
            }
          }
        }
      }`

      let hookCalled = false
      let hookInfo: any = null

      const result = await runValidation(query, testSchema, {
        maxDepth: 3,
        onExceeded: (info) =>
          Effect.sync(() => {
            hookCalled = true
            hookInfo = info
          }),
      })

      expect(hookCalled).toBe(true)
      expect(hookInfo?.exceededLimit).toBe("depth")
      expect(result._tag).toBe("Failure")
    })

    it("should fail on invalid query syntax", async () => {
      // Use a truly invalid query with missing closing brace
      const query = `{ hello `

      const result = await runValidation(query, testSchema, {
        maxDepth: 10,
      })

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const error = result.cause
        expect(error._tag).toBe("Fail")
        if (error._tag === "Fail") {
          expect(error.error._tag).toBe("ComplexityAnalysisError")
        }
      }
    })

    it("should use defaultFieldComplexity", async () => {
      const query = `{ hello }`

      const result = await runValidation(query, testSchema, {
        maxComplexity: 100,
        defaultFieldComplexity: 50,
      })

      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(result.value.complexity).toBe(50)
      }
    })

    it("should skip introspection fields in complexity", async () => {
      const query = `{ __typename }`

      const result = await runValidation(query, testSchema, {
        maxComplexity: 100,
      })

      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(result.value.complexity).toBe(0)
      }
    })
  })

  describe("defaultComplexityCalculator", () => {
    it("should calculate correct depth for nested queries", async () => {
      const query = `{
        user(id: "1") {
          posts {
            comments {
              text
            }
          }
        }
      }`

      const result = await runValidation(query, testSchema, {
        maxDepth: 10,
      })

      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(result.value.depth).toBe(4) // user.posts.comments.text
      }
    })

    it("should count all fields including nested", async () => {
      const query = `{
        user(id: "1") {
          id
          name
          posts {
            id
            title
          }
        }
      }`

      const result = await runValidation(query, testSchema, {
        maxDepth: 10,
      })

      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(result.value.fieldCount).toBe(6) // user, id, name, posts, id, title
      }
    })
  })

  describe("depthOnlyCalculator", () => {
    it("should only calculate depth", async () => {
      const query = `{
        user(id: "1") {
          posts {
            title
          }
        }
      }`

      const result = await runValidation(query, testSchema, {
        maxDepth: 10,
        calculator: depthOnlyCalculator,
      })

      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(result.value.depth).toBe(3)
        expect(result.value.complexity).toBe(0) // depth-only doesn't calculate complexity
        expect(result.value.fieldCount).toBe(0)
        expect(result.value.aliasCount).toBe(0)
      }
    })
  })

  describe("combineCalculators", () => {
    it("should return maximum values from all calculators", async () => {
      const customCalculator = () =>
        Effect.succeed({
          depth: 100,
          complexity: 5,
          fieldCount: 50,
          aliasCount: 25,
        })

      const combined = combineCalculators(
        defaultComplexityCalculator(1),
        customCalculator
      )

      const query = `{ hello }`

      const result = await runValidation(query, testSchema, {
        maxDepth: 200,
        maxComplexity: 200,
        calculator: combined,
      })

      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(result.value.depth).toBe(100) // Max from custom
        expect(result.value.complexity).toBe(5) // Max from custom
        expect(result.value.fieldCount).toBe(50) // Max from custom
        expect(result.value.aliasCount).toBe(25) // Max from custom
      }
    })
  })

  describe("edge cases", () => {
    it("should handle empty query", async () => {
      const query = `{}`

      // Empty selection set is a syntax error in GraphQL
      const result = await runValidation(query, testSchema, {
        maxDepth: 10,
      })

      expect(result._tag).toBe("Failure")
    })

    it("should handle deeply nested fragments without infinite loops", async () => {
      const query = `
        fragment A on User {
          ...B
        }

        fragment B on User {
          id
          friends {
            ...A
          }
        }

        query {
          user(id: "1") {
            ...A
          }
        }
      `

      // Should not infinite loop - fragments are tracked
      const result = await runValidation(query, testSchema, {
        maxDepth: 10,
      })

      expect(result._tag).toBe("Success")
    })

    it("should handle variables in arguments", async () => {
      const query = `
        query GetUsers($limit: Int!) {
          users(limit: $limit) {
            id
          }
        }
      `

      const fieldComplexities: FieldComplexityMap = new Map([
        ["Query.users", (args: Record<string, unknown>) => ((args.limit as number) ?? 10) * 2],
      ])

      const result = await runValidation(
        query,
        testSchema,
        { maxComplexity: 100 },
        fieldComplexities,
        undefined,
        { limit: 30 }
      )

      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        // 30 * 2 = 60, plus 1 for id field
        expect(result.value.complexity).toBe(61)
      }
    })
  })
})
