import { describe, it, expect, beforeAll, afterAll } from "vitest"
import {
  startTestServer,
  startTestServerWithWS,
  executeQuery,
  executeSubscription,
  getGraphiQL,
} from "../helpers/test-utils"

/**
 * Bun Server Integration Tests
 *
 * Note: These tests run on Node.js via vitest to verify the GraphQL routing
 * logic works correctly. The test utilities use Node.js http server with
 * HttpApp.toWebHandlerLayer(), which tests the same code paths that would
 * be used by the Bun server.
 *
 * For true Bun runtime testing, use `bun test` with Bun's native test runner.
 */
describe("Bun Server Integration", () => {
  let port: number
  let stop: () => Promise<void>

  beforeAll(async () => {
    // Use WebSocket-enabled server for all tests
    const server = await startTestServerWithWS()
    port = server.port
    stop = server.stop
  })

  afterAll(async () => {
    await stop()
  })

  // ==========================================================================
  // Queries
  // ==========================================================================
  describe("queries", () => {
    it("should execute a simple query", async () => {
      const result = await executeQuery(port, "{ hello }")
      expect(result).toEqual({ data: { hello: "world" } })
    })

    it("should execute a query with arguments", async () => {
      const result = await executeQuery(port, '{ echo(message: "test message") }')
      expect(result).toEqual({ data: { echo: "test message" } })
    })

    it("should execute a query with variables", async () => {
      const result = await executeQuery(port, "query Echo($msg: String!) { echo(message: $msg) }", {
        msg: "hello from variables",
      })
      expect(result).toEqual({ data: { echo: "hello from variables" } })
    })

    it("should handle invalid queries", async () => {
      const result = await executeQuery(port, "{ nonExistentField }")
      expect(result.errors).toBeDefined()
      expect(result.errors!.length).toBeGreaterThan(0)
    })
  })

  // ==========================================================================
  // Mutations
  // ==========================================================================
  describe("mutations", () => {
    it("should execute a simple mutation", async () => {
      const result = await executeQuery(port, 'mutation { createUser(name: "Alice") { id name } }')
      expect(result).toEqual({
        data: {
          createUser: { id: "1", name: "Alice" },
        },
      })
    })

    it("should execute a mutation with variables", async () => {
      const result = await executeQuery(
        port,
        "mutation CreateUser($name: String!) { createUser(name: $name) { id name } }",
        { name: "Bob" }
      )
      expect(result).toEqual({
        data: {
          createUser: { id: "1", name: "Bob" },
        },
      })
    })
  })

  // ==========================================================================
  // Nested Queries
  // ==========================================================================
  describe("nested queries", () => {
    it("should resolve nested object fields", async () => {
      const result = await executeQuery(port, '{ user(id: "123") { id name posts { id title } } }')
      expect(result.data).toBeDefined()
      const data = result.data as { user: { id: string; name: string; posts: unknown[] } }
      expect(data.user.id).toBe("123")
      expect(data.user.name).toBe("Test User")
      expect(data.user.posts).toHaveLength(2)
    })

    it("should handle partial selection on nested fields", async () => {
      const result = await executeQuery(port, '{ user(id: "456") { name posts { title } } }')
      expect(result.data).toBeDefined()
      const data = result.data as { user: { name: string; posts: { title: string }[] } }
      expect(data.user.name).toBe("Test User")
      expect(data.user.posts[0].title).toBe("First Post")
    })
  })

  // ==========================================================================
  // Directives
  // ==========================================================================
  describe("directives", () => {
    it("should apply directive transformers to field results", async () => {
      const result = await executeQuery(port, "{ greeting }")
      expect(result).toEqual({ data: { greeting: "HELLO" } })
    })
  })

  // ==========================================================================
  // Subscriptions
  // ==========================================================================
  describe("subscriptions", () => {
    it("should stream subscription events", async () => {
      const results = await executeSubscription<{ countdown: number }>(
        port,
        "subscription { countdown(from: 3) }"
      )

      expect(results).toHaveLength(3)
      expect(results.map((r) => r.countdown)).toEqual([3, 2, 1])
    })

    it("should handle subscription with variables", async () => {
      const results = await executeSubscription<{ countdown: number }>(
        port,
        "subscription Countdown($from: Int!) { countdown(from: $from) }",
        { from: 5 }
      )

      expect(results).toHaveLength(5)
      expect(results.map((r) => r.countdown)).toEqual([5, 4, 3, 2, 1])
    })

    it("should complete subscription when stream ends", async () => {
      const startTime = Date.now()
      const results = await executeSubscription<{ countdown: number }>(
        port,
        "subscription { countdown(from: 2) }"
      )
      const elapsed = Date.now() - startTime

      // Should complete quickly since stream is synchronous
      expect(elapsed).toBeLessThan(5000)
      expect(results).toHaveLength(2)
    })
  })

  // ==========================================================================
  // GraphiQL
  // ==========================================================================
  describe("GraphiQL", () => {
    it("should serve GraphiQL interface", async () => {
      const result = await getGraphiQL(port)
      expect(result.status).toBe(200)
      expect(result.body).toContain("GraphiQL")
    })

    it("should include the correct GraphQL endpoint in GraphiQL", async () => {
      const result = await getGraphiQL(port)
      expect(result.body).toContain("/graphql")
    })
  })

  // ==========================================================================
  // Error Handling
  // ==========================================================================
  describe("error handling", () => {
    it("should return proper error format for syntax errors", async () => {
      const result = await executeQuery(port, "{ invalid syntax")
      expect(result.errors).toBeDefined()
      expect(result.errors!.length).toBeGreaterThan(0)
    })

    it("should return proper error format for validation errors", async () => {
      const result = await executeQuery(port, '{ user(wrongArg: "test") { id } }')
      expect(result.errors).toBeDefined()
    })
  })
})
