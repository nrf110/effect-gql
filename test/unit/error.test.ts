import { describe, it, expect } from "vitest"
import { Effect, Exit } from "effect"
import {
  GraphQLError,
  ValidationError,
  AuthorizationError,
  NotFoundError,
} from "../../src/error"

describe("error.ts", () => {
  // ==========================================================================
  // GraphQLError
  // ==========================================================================
  describe("GraphQLError", () => {
    it("should create error with message only", () => {
      const error = new GraphQLError({ message: "Something went wrong" })

      expect(error.message).toBe("Something went wrong")
      expect(error._tag).toBe("GraphQLError")
      expect(error.extensions).toBeUndefined()
    })

    it("should create error with message and extensions", () => {
      const error = new GraphQLError({
        message: "Operation failed",
        extensions: { code: "INTERNAL_ERROR", timestamp: 123456 },
      })

      expect(error.message).toBe("Operation failed")
      expect(error._tag).toBe("GraphQLError")
      expect(error.extensions).toEqual({ code: "INTERNAL_ERROR", timestamp: 123456 })
    })

    it("should be usable with Effect.fail", () => {
      const program = Effect.fail(new GraphQLError({ message: "Test error" }))
      const exit = Effect.runSyncExit(program)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = exit.cause
        expect(error._tag).toBe("Fail")
      }
    })

    it("should be catchable with Effect.catchTag", () => {
      const program = Effect.fail(new GraphQLError({ message: "Caught error" })).pipe(
        Effect.catchTag("GraphQLError", (e) => Effect.succeed(`Caught: ${e.message}`))
      )
      const result = Effect.runSync(program)

      expect(result).toBe("Caught: Caught error")
    })
  })

  // ==========================================================================
  // ValidationError
  // ==========================================================================
  describe("ValidationError", () => {
    it("should create error with message only", () => {
      const error = new ValidationError({ message: "Invalid input" })

      expect(error.message).toBe("Invalid input")
      expect(error._tag).toBe("ValidationError")
      expect(error.field).toBeUndefined()
    })

    it("should create error with message and field", () => {
      const error = new ValidationError({
        message: "Email is invalid",
        field: "email",
      })

      expect(error.message).toBe("Email is invalid")
      expect(error._tag).toBe("ValidationError")
      expect(error.field).toBe("email")
    })

    it("should be catchable with Effect.catchTag", () => {
      const program = Effect.fail(
        new ValidationError({ message: "Bad value", field: "name" })
      ).pipe(
        Effect.catchTag("ValidationError", (e) =>
          Effect.succeed(`Field ${e.field}: ${e.message}`)
        )
      )
      const result = Effect.runSync(program)

      expect(result).toBe("Field name: Bad value")
    })
  })

  // ==========================================================================
  // AuthorizationError
  // ==========================================================================
  describe("AuthorizationError", () => {
    it("should create error with message", () => {
      const error = new AuthorizationError({ message: "Access denied" })

      expect(error.message).toBe("Access denied")
      expect(error._tag).toBe("AuthorizationError")
    })

    it("should be catchable with Effect.catchTag", () => {
      const program = Effect.fail(
        new AuthorizationError({ message: "Not authorized" })
      ).pipe(
        Effect.catchTag("AuthorizationError", (e) =>
          Effect.succeed(`Auth error: ${e.message}`)
        )
      )
      const result = Effect.runSync(program)

      expect(result).toBe("Auth error: Not authorized")
    })
  })

  // ==========================================================================
  // NotFoundError
  // ==========================================================================
  describe("NotFoundError", () => {
    it("should create error with message only", () => {
      const error = new NotFoundError({ message: "Resource not found" })

      expect(error.message).toBe("Resource not found")
      expect(error._tag).toBe("NotFoundError")
      expect(error.resource).toBeUndefined()
    })

    it("should create error with message and resource", () => {
      const error = new NotFoundError({
        message: "User not found",
        resource: "User",
      })

      expect(error.message).toBe("User not found")
      expect(error._tag).toBe("NotFoundError")
      expect(error.resource).toBe("User")
    })

    it("should be catchable with Effect.catchTag", () => {
      const program = Effect.fail(
        new NotFoundError({ message: "Not found", resource: "Post" })
      ).pipe(
        Effect.catchTag("NotFoundError", (e) =>
          Effect.succeed(`${e.resource} error: ${e.message}`)
        )
      )
      const result = Effect.runSync(program)

      expect(result).toBe("Post error: Not found")
    })
  })

  // ==========================================================================
  // Error Discrimination
  // ==========================================================================
  describe("Error discrimination", () => {
    it("should discriminate between error types using _tag", () => {
      const errors = [
        new GraphQLError({ message: "GQL" }),
        new ValidationError({ message: "Val" }),
        new AuthorizationError({ message: "Auth" }),
        new NotFoundError({ message: "NF" }),
      ]

      const tags = errors.map((e) => e._tag)

      expect(tags).toEqual([
        "GraphQLError",
        "ValidationError",
        "AuthorizationError",
        "NotFoundError",
      ])
    })

    it("should catch specific errors while letting others pass", () => {
      const handleValidation = <E extends { _tag: string }>(error: E) => {
        if (error._tag === "ValidationError") {
          return Effect.succeed("handled validation")
        }
        return Effect.fail(error)
      }

      const program1 = Effect.fail(new ValidationError({ message: "test" })).pipe(
        Effect.catchAll(handleValidation)
      )
      expect(Effect.runSync(program1)).toBe("handled validation")

      const program2 = Effect.fail(new NotFoundError({ message: "test" })).pipe(
        Effect.catchAll(handleValidation)
      )
      const exit = Effect.runSyncExit(program2)
      expect(Exit.isFailure(exit)).toBe(true)
    })
  })
})
