import { describe, it, expect } from "vitest"
import { resolverTracingMiddleware } from "../../src"

describe("tracing", () => {
  describe("resolverTracingMiddleware", () => {
    it("should filter introspection fields by default", () => {
      const mw = resolverTracingMiddleware()
      const info = {
        fieldName: "__schema",
        parentType: { name: "Query" },
        path: { key: "__schema", prev: undefined },
      } as any

      expect(mw.match!(info)).toBe(false)
    })

    it("should trace introspection fields when enabled", () => {
      const mw = resolverTracingMiddleware({ traceIntrospection: true })
      const info = {
        fieldName: "__schema",
        parentType: { name: "Query" },
        path: { key: "__schema", prev: undefined },
      } as any

      expect(mw.match!(info)).toBe(true)
    })

    it("should filter by depth when configured", () => {
      const mw = resolverTracingMiddleware({ minDepth: 1 })
      const rootInfo = {
        fieldName: "users",
        parentType: { name: "Query" },
        path: { key: "users", prev: undefined },
      } as any

      expect(mw.match!(rootInfo)).toBe(false)

      const nestedInfo = {
        fieldName: "name",
        parentType: { name: "User" },
        path: {
          key: "name",
          prev: { key: "users", prev: undefined },
        },
      } as any

      expect(mw.match!(nestedInfo)).toBe(true)
    })

    it("should filter by exclude patterns", () => {
      const mw = resolverTracingMiddleware({
        excludePatterns: [/\.id$/, /^Query\.health/],
      })

      const idField = {
        fieldName: "id",
        parentType: { name: "User" },
        path: { key: "id", prev: undefined },
      } as any

      expect(mw.match!(idField)).toBe(false)

      const healthField = {
        fieldName: "health",
        parentType: { name: "Query" },
        path: { key: "health", prev: undefined },
      } as any

      expect(mw.match!(healthField)).toBe(false)

      const nameField = {
        fieldName: "name",
        parentType: { name: "User" },
        path: { key: "name", prev: undefined },
      } as any

      expect(mw.match!(nameField)).toBe(true)
    })
  })

})
