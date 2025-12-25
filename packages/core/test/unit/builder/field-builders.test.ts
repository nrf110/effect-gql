import { describe, it, expect } from "vitest"
import { Effect, Stream, Layer, Runtime, Fiber } from "effect"
import * as S from "effect/Schema"
import {
  GraphQLObjectType,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLString,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  isNonNullType,
} from "graphql"
import {
  buildField,
  buildObjectField,
  buildSubscriptionField,
  FieldBuilderContext,
} from "../../../src/builder/field-builders"
import type { GraphQLEffectContext } from "../../../src/builder/types"

// Helper to create a minimal field builder context
const createFieldBuilderContext = (): FieldBuilderContext => ({
  types: new Map(),
  interfaces: new Map(),
  enums: new Map(),
  unions: new Map(),
  inputs: new Map(),
  typeRegistry: new Map(),
  interfaceRegistry: new Map(),
  enumRegistry: new Map(),
  unionRegistry: new Map(),
  inputRegistry: new Map(),
  directiveRegistrations: new Map(),
  middlewares: [],
})

// Helper to create test runtime context
const createTestContext = <R>(layer: Layer.Layer<R, never, never>): Promise<GraphQLEffectContext<R>> =>
  Effect.runPromise(
    Effect.scoped(Layer.toRuntime(layer)).pipe(
      Effect.map((runtime) => ({ runtime }))
    )
  )

// Simple test context for effects with no requirements
const createSimpleContext = (): GraphQLEffectContext<never> => ({
  runtime: Runtime.defaultRuntime,
})

describe("field-builders.ts", () => {
  // ==========================================================================
  // buildField - Basic
  // ==========================================================================
  describe("buildField - Basic", () => {
    it("should create field config with type", () => {
      const ctx = createFieldBuilderContext()
      const config = buildField(
        {
          type: S.String,
          resolve: () => Effect.succeed("hello"),
        },
        ctx
      )

      expect(config.type).toBe(GraphQLString)
    })

    it("should include description when provided", () => {
      const ctx = createFieldBuilderContext()
      const config = buildField(
        {
          type: S.String,
          description: "Test field description",
          resolve: () => Effect.succeed("hello"),
        },
        ctx
      )

      expect(config.description).toBe("Test field description")
    })

    it("should not include description when not provided", () => {
      const ctx = createFieldBuilderContext()
      const config = buildField(
        {
          type: S.String,
          resolve: () => Effect.succeed("hello"),
        },
        ctx
      )

      expect(config.description).toBeUndefined()
    })
  })

  // ==========================================================================
  // buildField - Args
  // ==========================================================================
  describe("buildField - Args", () => {
    it("should convert args schema to GraphQL args", () => {
      const ctx = createFieldBuilderContext()
      const config = buildField(
        {
          type: S.String,
          args: S.Struct({
            id: S.String,
            limit: S.optional(S.Int),
          }),
          resolve: (args) => Effect.succeed(`id: ${args.id}`),
        },
        ctx
      )

      expect(config.args).toBeDefined()
      expect(config.args?.id).toBeDefined()
      expect(config.args?.limit).toBeDefined()
      expect(isNonNullType(config.args?.id.type)).toBe(true)
      expect(isNonNullType(config.args?.limit.type)).toBe(false)
    })

    it("should use enum registry for enum args", () => {
      const StatusEnum = new GraphQLEnumType({
        name: "Status",
        values: { ACTIVE: { value: "ACTIVE" } },
      })

      const ctx = createFieldBuilderContext()
      ctx.enums.set("Status", { name: "Status", values: ["ACTIVE"] })
      ctx.enumRegistry.set("Status", StatusEnum)

      const config = buildField(
        {
          type: S.String,
          args: S.Struct({
            status: S.Literal("ACTIVE"),
          }),
          resolve: () => Effect.succeed("done"),
        },
        ctx
      )

      const statusArgType = isNonNullType(config.args?.status.type)
        ? (config.args?.status.type as any).ofType
        : config.args?.status.type

      expect(statusArgType).toBe(StatusEnum)
    })

    it("should not include args when not provided", () => {
      const ctx = createFieldBuilderContext()
      const config = buildField(
        {
          type: S.String,
          resolve: () => Effect.succeed("hello"),
        },
        ctx
      )

      expect(config.args).toBeUndefined()
    })
  })

  // ==========================================================================
  // buildField - Resolver
  // ==========================================================================
  describe("buildField - Resolver", () => {
    it("should execute resolver with runtime context", async () => {
      const ctx = createFieldBuilderContext()
      const config = buildField(
        {
          type: S.String,
          resolve: () => Effect.succeed("result"),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const result = await config.resolve!(null, {}, testContext, {} as any)
      expect(result).toBe("result")
    })

    it("should pass args to resolver", async () => {
      const ctx = createFieldBuilderContext()
      const config = buildField(
        {
          type: S.String,
          args: S.Struct({ name: S.String }),
          resolve: (args: { name: string }) => Effect.succeed(`Hello, ${args.name}`),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const result = await config.resolve!(null, { name: "World" }, testContext, {} as any)
      expect(result).toBe("Hello, World")
    })

    it("should handle Effect errors", async () => {
      const ctx = createFieldBuilderContext()
      const config = buildField(
        {
          type: S.String,
          resolve: () => Effect.fail(new Error("Test error")),
        },
        ctx
      )

      const testContext = createSimpleContext()
      await expect(config.resolve!(null, {}, testContext, {} as any)).rejects.toThrow("Test error")
    })
  })

  // ==========================================================================
  // buildField - Directives
  // ==========================================================================
  describe("buildField - Directives", () => {
    it("should apply directive transformer to resolver", async () => {
      const ctx = createFieldBuilderContext()

      // Register a directive that prepends text
      ctx.directiveRegistrations.set("prefix", {
        name: "prefix",
        locations: [],
        apply: (args: { text: string }) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.map(effect, (value) => `${args.text}${value}` as unknown as A),
      })

      const config = buildField(
        {
          type: S.String,
          directives: [{ name: "prefix", args: { text: "PREFIX:" } }],
          resolve: () => Effect.succeed("value"),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const result = await config.resolve!(null, {}, testContext, {} as any)
      expect(result).toBe("PREFIX:value")
    })

    it("should apply multiple directives in order", async () => {
      const ctx = createFieldBuilderContext()

      ctx.directiveRegistrations.set("wrap1", {
        name: "wrap1",
        locations: [],
        apply: () => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.map(effect, (value) => `[1:${value}]` as unknown as A),
      })

      ctx.directiveRegistrations.set("wrap2", {
        name: "wrap2",
        locations: [],
        apply: () => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.map(effect, (value) => `[2:${value}]` as unknown as A),
      })

      const config = buildField(
        {
          type: S.String,
          directives: [
            { name: "wrap1" },
            { name: "wrap2" },
          ],
          resolve: () => Effect.succeed("value"),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const result = await config.resolve!(null, {}, testContext, {} as any)
      // wrap1 applied first, then wrap2
      expect(result).toBe("[2:[1:value]]")
    })

    it("should skip non-executable directives (no apply function)", async () => {
      const ctx = createFieldBuilderContext()

      // Register a metadata-only directive
      ctx.directiveRegistrations.set("deprecated", {
        name: "deprecated",
        locations: [],
        // No apply function
      })

      const config = buildField(
        {
          type: S.String,
          directives: [{ name: "deprecated" }],
          resolve: () => Effect.succeed("value"),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const result = await config.resolve!(null, {}, testContext, {} as any)
      expect(result).toBe("value")
    })
  })

  // ==========================================================================
  // buildObjectField
  // ==========================================================================
  describe("buildObjectField", () => {
    it("should pass parent to resolver", async () => {
      const ctx = createFieldBuilderContext()
      const config = buildObjectField(
        {
          type: S.String,
          resolve: (parent: { name: string }) => Effect.succeed(parent.name.toUpperCase()),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const result = await config.resolve!({ name: "test" }, {}, testContext, {} as any)
      expect(result).toBe("TEST")
    })

    it("should pass both parent and args to resolver", async () => {
      const ctx = createFieldBuilderContext()
      const config = buildObjectField(
        {
          type: S.String,
          args: S.Struct({ suffix: S.String }),
          resolve: (parent: { name: string }, args: { suffix: string }) =>
            Effect.succeed(`${parent.name}${args.suffix}`),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const result = await config.resolve!(
        { name: "hello" },
        { suffix: "!" },
        testContext,
        {} as any
      )
      expect(result).toBe("hello!")
    })

    it("should include description", () => {
      const ctx = createFieldBuilderContext()
      const config = buildObjectField(
        {
          type: S.String,
          description: "Gets the full name",
          resolve: () => Effect.succeed("test"),
        },
        ctx
      )

      expect(config.description).toBe("Gets the full name")
    })

    it("should apply directives", async () => {
      const ctx = createFieldBuilderContext()
      ctx.directiveRegistrations.set("uppercase", {
        name: "uppercase",
        locations: [],
        apply: () => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.map(effect, (value) => String(value).toUpperCase() as unknown as A),
      })

      const config = buildObjectField(
        {
          type: S.String,
          directives: [{ name: "uppercase" }],
          resolve: () => Effect.succeed("hello"),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const result = await config.resolve!(null, {}, testContext, {} as any)
      expect(result).toBe("HELLO")
    })
  })

  // ==========================================================================
  // buildSubscriptionField - Basic
  // ==========================================================================
  describe("buildSubscriptionField - Basic", () => {
    it("should create subscription field config", () => {
      const ctx = createFieldBuilderContext()
      const config = buildSubscriptionField(
        {
          type: S.String,
          subscribe: () => Effect.succeed(Stream.make("a", "b", "c")),
        },
        ctx
      )

      expect(config.type).toBe(GraphQLString)
      expect(config.subscribe).toBeDefined()
      expect(config.resolve).toBeDefined()
    })

    it("should include description", () => {
      const ctx = createFieldBuilderContext()
      const config = buildSubscriptionField(
        {
          type: S.String,
          description: "Subscription description",
          subscribe: () => Effect.succeed(Stream.empty),
        },
        ctx
      )

      expect(config.description).toBe("Subscription description")
    })

    it("should include args", () => {
      const ctx = createFieldBuilderContext()
      const config = buildSubscriptionField(
        {
          type: S.String,
          args: S.Struct({ channel: S.String }),
          subscribe: () => Effect.succeed(Stream.empty),
        },
        ctx
      )

      expect(config.args).toBeDefined()
      expect(config.args?.channel).toBeDefined()
    })
  })

  // ==========================================================================
  // buildSubscriptionField - Subscribe
  // ==========================================================================
  describe("buildSubscriptionField - Subscribe", () => {
    it("should return AsyncIterator from subscribe", async () => {
      const ctx = createFieldBuilderContext()
      const config = buildSubscriptionField(
        {
          type: S.String,
          subscribe: () => Effect.succeed(Stream.make("a", "b", "c")),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const iterator = await config.subscribe!(null, {}, testContext, {} as any)

      expect(iterator).toBeDefined()
      const typedIterator = iterator as AsyncIterator<string>

      expect(typeof typedIterator.next).toBe("function")
    })

    it("should yield values from stream", async () => {
      const ctx = createFieldBuilderContext()
      const config = buildSubscriptionField(
        {
          type: S.String,
          subscribe: () => Effect.succeed(Stream.make("first", "second")),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const iterator = await config.subscribe!(null, {}, testContext, {} as any)

      const result1 = await (iterator as AsyncIterator<string>).next()
      expect(result1.done).toBe(false)
      expect(result1.value).toBe("first")

      const result2 = await (iterator as AsyncIterator<string>).next()
      expect(result2.done).toBe(false)
      expect(result2.value).toBe("second")

      const result3 = await (iterator as AsyncIterator<string>).next()
      expect(result3.done).toBe(true)
    })

    it("should handle empty stream", async () => {
      const ctx = createFieldBuilderContext()
      const config = buildSubscriptionField(
        {
          type: S.String,
          subscribe: () => Effect.succeed(Stream.empty),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const iterator = await config.subscribe!(null, {}, testContext, {} as any)
      const typedIterator = iterator as AsyncIterator<string>

      const result = await typedIterator.next()
      expect(result.done).toBe(true)
    })
  })

  // ==========================================================================
  // buildSubscriptionField - Resolve
  // ==========================================================================
  describe("buildSubscriptionField - Resolve", () => {
    it("should use identity when no resolve provided", async () => {
      const ctx = createFieldBuilderContext()
      const config = buildSubscriptionField(
        {
          type: S.String,
          subscribe: () => Effect.succeed(Stream.make("value")),
        },
        ctx
      )

      // When no custom resolve, it should return the value directly
      const result = config.resolve!("payload", {}, createSimpleContext(), {} as any)
      expect(result).toBe("payload")
    })

    it("should transform values with custom resolve", async () => {
      const ctx = createFieldBuilderContext()
      const config = buildSubscriptionField(
        {
          type: S.String,
          subscribe: () => Effect.succeed(Stream.make("hello")),
          resolve: (value: string) => Effect.succeed(value.toUpperCase()),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const result = await config.resolve!("hello", {}, testContext, {} as any)
      expect(result).toBe("HELLO")
    })

    it("should pass args to custom resolve", async () => {
      const ctx = createFieldBuilderContext()
      const config = buildSubscriptionField(
        {
          type: S.String,
          args: S.Struct({ suffix: S.String }),
          subscribe: () => Effect.succeed(Stream.make("value")),
          resolve: (value: string, args: { suffix: string }) =>
            Effect.succeed(`${value}${args.suffix}`),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const result = await config.resolve!("value", { suffix: "!" }, testContext, {} as any)
      expect(result).toBe("value!")
    })
  })

  // ==========================================================================
  // buildSubscriptionField - Iterator cleanup
  // ==========================================================================
  describe("buildSubscriptionField - Iterator cleanup", () => {
    it("should handle return() for early termination", async () => {
      const ctx = createFieldBuilderContext()
      const config = buildSubscriptionField(
        {
          type: S.String,
          subscribe: () => Effect.succeed(Stream.make("a", "b", "c")),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const iterator = await config.subscribe!(null, {}, testContext, {} as any)
      const typedIterator = iterator as AsyncIterator<string>

      // Get first value
      await typedIterator.next()

      // Early termination
      const returnResult = await typedIterator.return!()
      expect(returnResult.done).toBe(true)

      // Subsequent next calls should return done
      const nextResult = await typedIterator.next()
      expect(nextResult.done).toBe(true)
    })
  })

  // ==========================================================================
  // Type conversion with registered types
  // ==========================================================================
  describe("Type conversion with registered types", () => {
    it("should use registered type for field return type", () => {
      const UserSchema = S.Struct({ id: S.String, name: S.String })
      const userType = new GraphQLObjectType({
        name: "User",
        fields: { id: { type: GraphQLString }, name: { type: GraphQLString } },
      })

      const ctx = createFieldBuilderContext()
      ctx.types.set("User", { name: "User", schema: UserSchema })
      ctx.typeRegistry.set("User", userType)

      const config = buildField(
        {
          type: UserSchema,
          resolve: () => Effect.succeed({ id: "1", name: "Test" }),
        },
        ctx
      )

      expect(config.type).toBe(userType)
    })

    it("should use registered input type for args", () => {
      const FilterInput = S.Struct({ name: S.optional(S.String) })
      const filterInputType = new GraphQLInputObjectType({
        name: "FilterInput",
        fields: { name: { type: GraphQLString } },
      })

      const ctx = createFieldBuilderContext()
      ctx.inputs.set("FilterInput", { name: "FilterInput", schema: FilterInput })
      ctx.inputRegistry.set("FilterInput", filterInputType)

      const config = buildField(
        {
          type: S.Array(S.String),
          args: S.Struct({ filter: FilterInput }),
          resolve: () => Effect.succeed([]),
        },
        ctx
      )

      const filterArgType = isNonNullType(config.args?.filter.type)
        ? (config.args?.filter.type as any).ofType
        : config.args?.filter.type

      expect(filterArgType).toBe(filterInputType)
    })
  })

  // ==========================================================================
  // buildField - Middleware
  // ==========================================================================
  describe("buildField - Middleware", () => {
    it("should apply middleware to resolver", async () => {
      const ctx = createFieldBuilderContext()

      // Register a middleware that transforms the result
      ctx.middlewares = [{
        name: "uppercase",
        apply: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.map(effect, (value) => String(value).toUpperCase() as unknown as A),
      }]

      const config = buildField(
        {
          type: S.String,
          resolve: () => Effect.succeed("hello"),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const mockInfo = { fieldName: "test", parentType: { name: "Query" } } as any
      const result = await config.resolve!(null, {}, testContext, mockInfo)
      expect(result).toBe("HELLO")
    })

    it("should apply multiple middleware in onion order", async () => {
      const ctx = createFieldBuilderContext()

      // First registered = outermost (executes first before, last after)
      ctx.middlewares = [
        {
          name: "outer",
          apply: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.map(effect, (value) => `[outer:${value}]` as unknown as A),
        },
        {
          name: "inner",
          apply: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.map(effect, (value) => `[inner:${value}]` as unknown as A),
        },
      ]

      const config = buildField(
        {
          type: S.String,
          resolve: () => Effect.succeed("value"),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const mockInfo = { fieldName: "test", parentType: { name: "Query" } } as any
      const result = await config.resolve!(null, {}, testContext, mockInfo)
      // Outer wraps inner wraps value: outer sees inner's output
      expect(result).toBe("[outer:[inner:value]]")
    })

    it("should apply middleware only to matching fields when match is provided", async () => {
      const ctx = createFieldBuilderContext()

      ctx.middlewares = [{
        name: "adminOnly",
        match: (info) => info.fieldName.startsWith("admin"),
        apply: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.map(effect, (value) => `ADMIN:${value}` as unknown as A),
      }]

      const config = buildField(
        {
          type: S.String,
          resolve: () => Effect.succeed("data"),
        },
        ctx
      )

      const testContext = createSimpleContext()

      // Field that matches - middleware applies
      const adminInfo = { fieldName: "adminUsers", parentType: { name: "Query" } } as any
      const adminResult = await config.resolve!(null, {}, testContext, adminInfo)
      expect(adminResult).toBe("ADMIN:data")

      // Field that doesn't match - middleware skipped
      const userInfo = { fieldName: "users", parentType: { name: "Query" } } as any
      const userResult = await config.resolve!(null, {}, testContext, userInfo)
      expect(userResult).toBe("data")
    })

    it("should receive context with parent, args, and info", async () => {
      const ctx = createFieldBuilderContext()

      let capturedContext: any = null
      ctx.middlewares = [{
        name: "capture",
        apply: <A, E, R>(effect: Effect.Effect<A, E, R>, context: any) => {
          capturedContext = context
          return effect
        },
      }]

      const config = buildField(
        {
          type: S.String,
          args: S.Struct({ name: S.String }),
          resolve: () => Effect.succeed("result"),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const mockInfo = { fieldName: "greeting", parentType: { name: "Query" } } as any
      await config.resolve!(null, { name: "World" }, testContext, mockInfo)

      expect(capturedContext).not.toBeNull()
      expect(capturedContext.parent).toBeNull()
      expect(capturedContext.args).toEqual({ name: "World" })
      expect(capturedContext.info.fieldName).toBe("greeting")
    })

    it("should compose with directives correctly", async () => {
      const ctx = createFieldBuilderContext()

      // Directive wraps first (innermost)
      ctx.directiveRegistrations.set("prefix", {
        name: "prefix",
        locations: [],
        apply: (args: { text: string }) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.map(effect, (value) => `${args.text}${value}` as unknown as A),
      })

      // Middleware wraps second (outermost)
      ctx.middlewares = [{
        name: "wrap",
        apply: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.map(effect, (value) => `[${value}]` as unknown as A),
      }]

      const config = buildField(
        {
          type: S.String,
          directives: [{ name: "prefix", args: { text: "DIR:" } }],
          resolve: () => Effect.succeed("value"),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const mockInfo = { fieldName: "test", parentType: { name: "Query" } } as any
      const result = await config.resolve!(null, {}, testContext, mockInfo)
      // Directive applied first, then middleware wraps the result
      expect(result).toBe("[DIR:value]")
    })

    it("should work with no middleware registered", async () => {
      const ctx = createFieldBuilderContext()
      // middlewares is empty by default

      const config = buildField(
        {
          type: S.String,
          resolve: () => Effect.succeed("value"),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const mockInfo = { fieldName: "test", parentType: { name: "Query" } } as any
      const result = await config.resolve!(null, {}, testContext, mockInfo)
      expect(result).toBe("value")
    })
  })

  // ==========================================================================
  // buildObjectField - Middleware
  // ==========================================================================
  describe("buildObjectField - Middleware", () => {
    it("should apply middleware with correct parent", async () => {
      const ctx = createFieldBuilderContext()

      let capturedParent: any = null
      ctx.middlewares = [{
        name: "captureParent",
        apply: <A, E, R>(effect: Effect.Effect<A, E, R>, context: any) => {
          capturedParent = context.parent
          return effect
        },
      }]

      const config = buildObjectField(
        {
          type: S.String,
          resolve: (parent: { name: string }) => Effect.succeed(parent.name),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const mockInfo = { fieldName: "name", parentType: { name: "User" } } as any
      await config.resolve!({ name: "Alice" }, {}, testContext, mockInfo)

      expect(capturedParent).toEqual({ name: "Alice" })
    })
  })
})
