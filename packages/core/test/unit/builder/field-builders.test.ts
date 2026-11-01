import { describe, it, expect } from "vitest"
import { Context, Effect, Stream, Option } from "effect"
import * as S from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import {
  GraphQLObjectType,
  GraphQLInterfaceType,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLString,
  GraphQLSchema,
  defaultFieldResolver,
  graphql,
  parse,
  subscribe,
  isNonNullType,
  type GraphQLResolveInfo,
  type GraphQLFieldConfig,
  type ExecutionResult,
} from "graphql"
import {
  buildField,
  buildObjectField,
  buildSubscriptionField,
  FieldBuilderContext,
} from "../../../src/builder/field-builders"
import type { GraphQLEffectContext, MiddlewareContext } from "../../../src/builder/types"

// Minimal metadata for tests that invoke subscription field configs directly.
const subscriptionInfo = {} as GraphQLResolveInfo

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

// Simple test context for effects with no requirements
const createSimpleContext = (): GraphQLEffectContext<never> => ({
  services: Context.empty(),
})

describe("field-builders.ts", () => {
  describe("decoded GraphQL arguments", () => {
    const DecodeOffset = Context.Service<number>("field-builders/DecodeOffset")
    const argsSchema = S.Struct({
      amount: S.NumberFromString.pipe(
        S.check(S.isFinite()),
        S.decodeTo(S.Number, {
          decode: SchemaGetter.transformEffect((amount) =>
            Effect.map(DecodeOffset, (offset) => amount + offset)
          ),
          encode: SchemaGetter.transform((amount) => amount),
        }),
        S.withDecodingDefault(Effect.succeed("20"))
      ),
      label: S.optional(S.String),
    })
    const contextValue = { services: Context.make(DecodeOffset, 1) }

    it.each(["query", "mutation", "object"] as const)(
      "decodes explicit and omitted %s arguments before callbacks and middleware",
      async (kind) => {
        const ctx = createFieldBuilderContext()
        const observed: unknown[] = []
        const order: string[] = []
        ctx.directiveRegistrations.set("trace", {
          name: "trace",
          locations: ["FIELD_DEFINITION"],
          apply: () => (effect) =>
            Effect.suspend(() => {
              order.push("directive")
              return effect
            }),
        })
        ctx.middlewares = [
          {
            name: "trace",
            apply: (effect, context) => {
              observed.push(context.args)
              return Effect.suspend(() => {
                order.push("middleware")
                return effect
              })
            },
          },
        ]
        let calls = 0
        const resolve = (args: S.Schema.Type<typeof argsSchema>) => {
          calls++
          return Effect.sync(() => {
            order.push("resolver")
            return args.amount + args.amount
          })
        }
        const registration = {
          type: S.Number,
          args: argsSchema,
          directives: [{ name: "trace" }],
          resolve,
        }
        const field =
          kind === "object"
            ? buildObjectField(
                {
                  ...registration,
                  resolve: (_parent: unknown, args: S.Schema.Type<typeof argsSchema>) =>
                    resolve(args),
                },
                ctx
              )
            : buildField(registration, ctx)
        const fields = { doubled: field }
        const query = new GraphQLObjectType({
          name: "Query",
          fields:
            kind === "object"
              ? {
                  item: {
                    type: new GraphQLObjectType({ name: "Item", fields }),
                    resolve: () => ({}),
                  },
                }
              : kind === "mutation"
                ? { ready: { type: GraphQLString, resolve: () => "ready" } }
                : fields,
        })
        const schema = new GraphQLSchema({
          query,
          mutation:
            kind === "mutation" ? new GraphQLObjectType({ name: "Mutation", fields }) : undefined,
        })
        const operation = (argumentsText: string) =>
          kind === "object"
            ? `{ item { doubled${argumentsText} } }`
            : `${kind} { doubled${argumentsText} }`

        for (const argumentsText of ['(amount: "20")', ""]) {
          const result = await graphql({ schema, source: operation(argumentsText), contextValue })
          expect(result.errors).toBeUndefined()
          expect(result.data).toEqual(
            kind === "object" ? { item: { doubled: 42 } } : { doubled: 42 }
          )
        }
        expect(calls).toBe(2)
        expect(observed).toEqual([{ amount: 21 }, { amount: 21 }])
        expect(order).toEqual([
          "middleware",
          "directive",
          "resolver",
          "middleware",
          "directive",
          "resolver",
        ])

        const invalid = await graphql({
          schema,
          source: operation('(amount: "not-a-number")'),
          contextValue,
        })
        expect(invalid.errors?.[0].path).toEqual(
          kind === "object" ? ["item", "doubled"] : ["doubled"]
        )
        expect(calls).toBe(2)
        expect(observed).toEqual([{ amount: 21 }, { amount: 21 }])
      }
    )

    it("decodes transformations on the entire argument object", async () => {
      const wholeArgs = S.Struct({ amount: S.NumberFromString }).pipe(
        S.decodeTo(S.Struct({ total: S.Number }), {
          decode: SchemaGetter.transform(({ amount }) => ({ total: amount + amount })),
          encode: SchemaGetter.transform(({ total }) => ({ amount: total / 2 })),
        })
      )
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            doubled: buildField(
              {
                type: S.Number,
                args: wholeArgs,
                resolve: ({ total }: S.Schema.Type<typeof wholeArgs>) => Effect.succeed(total),
              },
              createFieldBuilderContext()
            ),
          },
        }),
      })

      const result = await graphql({
        schema,
        source: '{ doubled(amount: "21") }',
        contextValue: createSimpleContext(),
      })

      expect(result.errors).toBeUndefined()
      expect(result.data).toEqual({ doubled: 42 })
    })

    it("restores only hidden literal tags in root, nested, array, class, and recursive inputs", async () => {
      const Child = S.TaggedStruct("Child", { amount: S.NumberFromString })
      class Entry extends S.TaggedClass<Entry>()("Entry", { amount: S.NumberFromString }) {}
      interface Node {
        readonly _tag: "Node"
        readonly amount: number
        readonly children: readonly Node[]
      }
      interface EncodedNode {
        readonly _tag: "Node"
        readonly amount: string
        readonly children: readonly EncodedNode[]
      }
      const Node: S.Codec<Node, EncodedNode> = S.TaggedStruct("Node", {
        amount: S.NumberFromString,
        children: S.Array(S.suspend(() => Node)),
      })
      const taggedArgs = S.TaggedStruct("Arguments", {
        amount: S.NumberFromString,
        child: Child,
        projected: S.toEncoded(Child),
        items: S.Array(Child),
        entry: Entry,
        node: Node,
        label: S.optional(S.String),
      })
      let receivedClass = false
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            inspect: buildField(
              {
                type: S.String,
                args: taggedArgs,
                resolve: (args: S.Schema.Type<typeof taggedArgs>) => {
                  receivedClass = args.entry instanceof Entry
                  return Effect.succeed(JSON.stringify(args))
                },
              },
              createFieldBuilderContext()
            ),
          },
        }),
      })
      const result = await graphql({
        schema,
        source: `{
          inspect(
            amount: "1"
            child: { amount: "2" }
            projected: { amount: "3" }
            items: [{ amount: "4" }]
            entry: { amount: "5" }
            node: { amount: "6", children: [{ amount: "7", children: [] }] }
          )
        }`,
        contextValue: createSimpleContext(),
      })

      expect(result.errors).toBeUndefined()
      expect(receivedClass).toBe(true)
      expect(JSON.parse(String(result.data?.inspect))).toEqual({
        _tag: "Arguments",
        amount: 1,
        child: { _tag: "Child", amount: 2 },
        projected: { _tag: "Child", amount: "3" },
        items: [{ _tag: "Child", amount: 4 }],
        entry: { _tag: "Entry", amount: 5 },
        node: {
          _tag: "Node",
          amount: 6,
          children: [{ _tag: "Node", amount: 7, children: [] }],
        },
      })
    })

    it("normalizes nullable Option inputs without bypassing codecs, defaults, or validation", async () => {
      const value = argsSchema.fields.amount
      const options = S.Struct({
        value: S.Option(value),
        optional: S.optionalKey(S.Option(S.String)),
        fallback: S.Option(S.String).pipe(
          S.withDecodingDefault(Effect.succeed(Option.some("fallback")))
        ),
        nullable: S.OptionFromNullOr(S.NumberFromString),
      })
      const observed: S.Schema.Type<typeof options>[] = []
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            inspect: buildField(
              {
                type: S.String,
                args: options,
                resolve: (args: S.Schema.Type<typeof options>) => {
                  observed.push(args)
                  return Effect.succeed(
                    JSON.stringify({
                      value: Option.getOrNull(args.value),
                      optionalPresent: Object.hasOwn(args, "optional"),
                      fallback: Option.getOrNull(args.fallback),
                      nullable: Option.getOrNull(args.nullable),
                    })
                  )
                },
              },
              createFieldBuilderContext()
            ),
          },
        }),
      })
      for (const [argumentsText, expected] of [
        ['(value: "20", nullable: "7")', { value: 21, nullable: 7 }],
        ["(value: null, nullable: null)", { value: null, nullable: null }],
        ["", { value: null, nullable: null }],
      ] as const) {
        const result = await graphql({
          schema,
          source: `{ inspect${argumentsText} }`,
          contextValue,
        })
        expect(result.errors).toBeUndefined()
        expect(JSON.parse(String(result.data?.inspect))).toEqual({
          ...expected,
          optionalPresent: false,
          fallback: "fallback",
        })
      }
      const invalid = await graphql({
        schema,
        source: '{ inspect(value: "invalid", nullable: null) }',
        contextValue,
      })
      expect(invalid.errors?.[0].path).toEqual(["inspect"])
      expect(observed).toHaveLength(3)
    })

    it("normalizes Option values recursively inside tagged, class, list, and recursive inputs", async () => {
      const Child = S.TaggedStruct("OptionChild", { value: S.Option(S.NumberFromString) })
      class Entry extends S.TaggedClass<Entry>()("OptionEntry", {
        child: S.Option(Child),
      }) {}
      interface Node {
        readonly value: Option.Option<number>
        readonly next: Option.Option<Node>
      }
      interface EncodedNode {
        readonly value: Option.Option<string>
        readonly next: Option.Option<EncodedNode>
      }
      const Node: S.Codec<Node, EncodedNode> = S.Struct({
        value: S.Option(S.NumberFromString),
        next: S.Option(S.suspend(() => Node)),
      }).annotate({ identifier: "OptionNode" })
      const options = S.Struct({
        entry: Entry,
        children: S.Array(S.Option(Child)),
        node: Node,
        nullable: S.OptionFromNullOr(Child),
      })
      let receivedClass = false
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            inspect: buildField(
              {
                type: S.String,
                args: options,
                resolve: (args: S.Schema.Type<typeof options>) => {
                  receivedClass = args.entry instanceof Entry
                  return Effect.succeed(JSON.stringify(args))
                },
              },
              createFieldBuilderContext()
            ),
          },
        }),
      })
      const result = await graphql({
        schema,
        source: `{
          inspect(
            entry: { child: { value: "1" } }
            children: [{ value: "2" }, null, {}]
            node: { value: "3", next: { value: null } }
            nullable: { value: "4" }
          )
        }`,
        contextValue: createSimpleContext(),
      })
      expect(result.errors).toBeUndefined()
      expect(receivedClass).toBe(true)
      expect(JSON.parse(String(result.data?.inspect))).toMatchObject({
        entry: {
          _tag: "OptionEntry",
          child: {
            _tag: "Some",
            value: {
              _tag: "OptionChild",
              value: { _tag: "Some", value: 1 },
            },
          },
        },
        children: [
          { _tag: "Some", value: { _tag: "OptionChild", value: { _tag: "Some", value: 2 } } },
          { _tag: "None" },
          { _tag: "Some", value: { _tag: "OptionChild", value: { _tag: "None" } } },
        ],
        node: {
          value: { _tag: "Some", value: 3 },
          next: { _tag: "Some", value: { value: { _tag: "None" }, next: { _tag: "None" } } },
        },
        nullable: {
          _tag: "Some",
          value: {
            _tag: "OptionChild",
            value: { _tag: "Some", value: 4 },
          },
        },
      })
    })

    it("decodes subscription defaults and transforms once with isolated concurrent operation args", async () => {
      let defaults = 0
      let transforms = 0
      const args = S.Struct({
        token: S.NumberFromString.pipe(
          S.decodeTo(S.Number, {
            decode: SchemaGetter.transform((value) => {
              transforms++
              return value
            }),
            encode: SchemaGetter.transform((value) => value),
          }),
          S.withDecodingDefault(Effect.sync(() => String(++defaults)))
        ),
      })
      const subscribed: S.Schema.Type<typeof args>[] = []
      const resolved: S.Schema.Type<typeof args>[] = []
      const middleware: unknown[] = []
      const parents: unknown[] = []
      const closed: number[] = []
      const ctx = createFieldBuilderContext()
      ctx.middlewares = [
        {
          name: "capture",
          apply: (effect, context) => {
            middleware.push(context.args)
            parents.push(context.parent)
            return effect
          },
        },
      ]
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: { ready: { type: GraphQLString, resolve: () => "ready" } },
        }),
        subscription: new GraphQLObjectType({
          name: "Subscription",
          fields: {
            event: buildSubscriptionField(
              {
                type: S.Option(S.String),
                args,
                subscribe: (args: S.Schema.Type<typeof args>) => {
                  subscribed.push(args)
                  return Effect.succeed(
                    Stream.make("first", "second").pipe(
                      Stream.ensuring(
                        Effect.sync(() => {
                          closed.push(args.token)
                        })
                      )
                    )
                  )
                },
                resolve: (value: string, args: S.Schema.Type<typeof args>) => {
                  resolved.push(args)
                  return Effect.succeed(Option.some(`${value}:${args.token}`))
                },
              },
              ctx
            ),
          },
        }),
      })
      const document = parse("subscription { event }")
      const { services } = createSimpleContext()
      const [first, second] = await Promise.all([
        subscribe({ schema, document, contextValue: { services } }),
        subscribe({ schema, document, contextValue: { services } }),
      ])
      if (!(Symbol.asyncIterator in first) || !(Symbol.asyncIterator in second)) {
        throw new Error("Subscriptions failed")
      }
      const a = first[Symbol.asyncIterator]()
      const b = second[Symbol.asyncIterator]()
      expect(await a.next()).toEqual({ done: false, value: { data: { event: "first:1" } } })
      expect(await b.next()).toEqual({ done: false, value: { data: { event: "first:2" } } })
      expect(await a.next()).toEqual({ done: false, value: { data: { event: "second:1" } } })
      expect(await b.next()).toEqual({ done: false, value: { data: { event: "second:2" } } })
      await a.return?.()
      await b.return?.()
      expect(defaults).toBe(2)
      expect(transforms).toBe(2)
      expect(resolved).toEqual([subscribed[0], subscribed[1], subscribed[0], subscribed[1]])
      expect(resolved[0]).toBe(subscribed[0])
      expect(resolved[1]).toBe(subscribed[1])
      expect(resolved[2]).toBe(subscribed[0])
      expect(resolved[3]).toBe(subscribed[1])
      expect(subscribed[0]).not.toBe(subscribed[1])
      expect(middleware).toEqual([
        subscribed[0],
        subscribed[1],
        subscribed[0],
        subscribed[1],
        subscribed[0],
        subscribed[1],
      ])
      expect(middleware[2]).toBe(subscribed[0])
      expect(parents.slice(2)).toEqual(["first", "first", "second", "second"])
      expect(closed.sort()).toEqual([1, 2])
    })

    it("decodes subscription subscribe and event resolve arguments with request services", async () => {
      const ctx = createFieldBuilderContext()
      const observed: unknown[] = []
      ctx.middlewares = [
        {
          name: "capture",
          apply: (effect, context) => {
            observed.push(context.args)
            return effect
          },
        },
      ]
      let subscribeCalls = 0
      let resolveCalls = 0
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: { ready: { type: GraphQLString, resolve: () => "ready" } },
        }),
        subscription: new GraphQLObjectType({
          name: "Subscription",
          fields: {
            doubled: buildSubscriptionField(
              {
                type: S.Number,
                args: argsSchema,
                subscribe: (args: S.Schema.Type<typeof argsSchema>) => {
                  subscribeCalls++
                  return Effect.succeed(Stream.make(args.amount + args.amount))
                },
                resolve: (value: number, args: S.Schema.Type<typeof argsSchema>) => {
                  resolveCalls++
                  return Effect.succeed(value + args.amount + args.amount)
                },
              },
              ctx
            ),
          },
        }),
      })

      for (const argumentsText of ['(amount: "20")', ""]) {
        const result = await subscribe({
          schema,
          document: parse(`subscription { doubled${argumentsText} }`),
          contextValue: { services: contextValue.services },
        })
        if (!(Symbol.asyncIterator in result)) {
          throw new Error(`Subscription failed: ${JSON.stringify(result)}`)
        }
        const iterator = result[Symbol.asyncIterator]()
        const event = await iterator.next()
        expect(event.value).toEqual({ data: { doubled: 84 } })
        expect(await iterator.next()).toEqual({ value: undefined, done: true })
      }
      expect(subscribeCalls).toBe(2)
      expect(resolveCalls).toBe(2)
      expect(observed).toEqual(Array.from({ length: 4 }, () => ({ amount: 21 })))

      const invalid = await subscribe({
        schema,
        document: parse('subscription { doubled(amount: "not-a-number") }'),
        contextValue: { services: contextValue.services },
      })
      if (Symbol.asyncIterator in invalid) {
        throw new Error("Invalid arguments unexpectedly started a subscription")
      }
      expect(invalid.errors?.[0].path).toEqual(["doubled"])
      expect(subscribeCalls).toBe(2)
      expect(resolveCalls).toBe(2)
    })
  })

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
        apply:
          (args: { text: string }) =>
          <A, E, R>(effect: Effect.Effect<A, E, R>) =>
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
        apply:
          () =>
          <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.map(effect, (value) => `[1:${value}]` as unknown as A),
      })

      ctx.directiveRegistrations.set("wrap2", {
        name: "wrap2",
        locations: [],
        apply:
          () =>
          <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.map(effect, (value) => `[2:${value}]` as unknown as A),
      })

      const config = buildField(
        {
          type: S.String,
          directives: [{ name: "wrap1" }, { name: "wrap2" }],
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
        apply:
          () =>
          <A, E, R>(effect: Effect.Effect<A, E, R>) =>
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
      const iterable = await config.subscribe!(null, {}, testContext, subscriptionInfo)
      const iterator = (iterable as AsyncIterable<string>)[Symbol.asyncIterator]()

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
      const iterable = await config.subscribe!(null, {}, testContext, subscriptionInfo)
      const typedIterator = (iterable as AsyncIterable<string>)[Symbol.asyncIterator]()

      const result = await typedIterator.next()
      expect(result.done).toBe(true)
    })
  })

  describe("native subscription context ownership", () => {
    const makeSchema = (field: GraphQLFieldConfig<unknown, GraphQLEffectContext<never>>) =>
      new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: { ready: { type: GraphQLString, resolve: () => "ready" } },
        }),
        subscription: new GraphQLObjectType({
          name: "Subscription",
          fields: { event: field },
        }),
      })

    const expectInitialError = (
      result: AsyncIterable<ExecutionResult> | ExecutionResult,
      code: string
    ) => {
      if (Symbol.asyncIterator in result) {
        throw new Error("Invalid context unexpectedly started a subscription")
      }
      expect(result.data).toBeUndefined()
      expect(result.errors).toHaveLength(1)
      expect(result.errors?.[0]).toMatchObject({
        path: ["event"],
        extensions: { code },
      })
      return result.errors![0]
    }

    it("rejects a concurrent duplicate before repeating argument decoding or source setup", async () => {
      let defaults = 0
      let transforms = 0
      let setups = 0
      let releaseDecode!: () => void
      let enteredDecode!: () => void
      const decodeGate = new Promise<void>((resolve) => {
        releaseDecode = resolve
      })
      const decoding = new Promise<void>((resolve) => {
        enteredDecode = resolve
      })
      const args = S.Struct({
        token: S.NumberFromString.pipe(
          S.decodeTo(S.Number, {
            decode: SchemaGetter.transform((value) => {
              transforms++
              return value
            }),
            encode: SchemaGetter.transform((value) => value),
          }),
          S.withDecodingDefault(
            Effect.promise(async () => {
              const token = ++defaults
              if (token === 1) {
                enteredDecode()
                await decodeGate
              }
              return String(token)
            })
          )
        ),
      })
      const subscribed: S.Schema.Type<typeof args>[] = []
      const resolved: S.Schema.Type<typeof args>[] = []
      const schema = makeSchema(
        buildSubscriptionField(
          {
            type: S.Number,
            args,
            subscribe: (operationArgs: S.Schema.Type<typeof args>) => {
              setups++
              subscribed.push(operationArgs)
              return Effect.succeed(Stream.make(10))
            },
            resolve: (value: number, operationArgs: S.Schema.Type<typeof args>) => {
              resolved.push(operationArgs)
              return Effect.succeed(value + operationArgs.token)
            },
          },
          createFieldBuilderContext()
        )
      )
      const contextValue = Object.freeze(createSimpleContext())
      const request = { schema, document: parse("subscription { event }"), contextValue }
      const firstPending = subscribe(request)
      await decoding
      try {
        const error = expectInitialError(await subscribe(request), "SUBSCRIPTION_CONTEXT_REUSED")
        expect(error.message).toMatch(/fresh|new|one.use|unique/i)
        expect(defaults).toBe(1)
        expect(transforms).toBe(0)
        expect(setups).toBe(0)
      } finally {
        releaseDecode()
      }
      const first = await firstPending
      const fresh = await subscribe({
        ...request,
        contextValue: Object.freeze({ services: contextValue.services }),
      })
      if (!(Symbol.asyncIterator in first) || !(Symbol.asyncIterator in fresh)) {
        throw new Error("Fresh subscription contexts failed")
      }
      const a = first[Symbol.asyncIterator]()
      const b = fresh[Symbol.asyncIterator]()
      try {
        expect(await a.next()).toEqual({ done: false, value: { data: { event: 11 } } })
        expect(await b.next()).toEqual({ done: false, value: { data: { event: 12 } } })
        expect(defaults).toBe(2)
        expect(transforms).toBe(2)
        expect(setups).toBe(2)
        expect(resolved[0]).toBe(subscribed[0])
        expect(resolved[1]).toBe(subscribed[1])
        expect(subscribed[0]).not.toBe(subscribed[1])
      } finally {
        await a.return?.()
        await b.return?.()
      }
    })

    it("keeps no-args default-resolver contexts consumed after completion and cancellation", async () => {
      let setups = 0
      const schema = makeSchema(
        buildSubscriptionField(
          {
            type: S.String,
            subscribe: () => {
              setups++
              return Effect.succeed(Stream.make("raw"))
            },
          },
          createFieldBuilderContext()
        )
      )
      const { services } = createSimpleContext()
      const document = parse("subscription { event }")
      const completedContext = Object.freeze({ services })
      const cancelledContext = Object.freeze({ services })
      const start = (contextValue: GraphQLEffectContext<never>) =>
        subscribe({ schema, document, contextValue })

      const completed = await start(completedContext)
      if (!(Symbol.asyncIterator in completed)) throw new Error("Subscription failed")
      const completedIterator = completed[Symbol.asyncIterator]()
      expect(await completedIterator.next()).toEqual({
        done: false,
        value: { data: { event: "raw" } },
      })
      expect(await completedIterator.next()).toEqual({ done: true, value: undefined })
      expectInitialError(await start(completedContext), "SUBSCRIPTION_CONTEXT_REUSED")

      const cancelled = await start(cancelledContext)
      if (!(Symbol.asyncIterator in cancelled)) throw new Error("Subscription failed")
      const cancelledIterator = cancelled[Symbol.asyncIterator]()
      expect(await cancelledIterator.next()).toEqual({
        done: false,
        value: { data: { event: "raw" } },
      })
      await cancelledIterator.return?.()
      expectInitialError(await start(cancelledContext), "SUBSCRIPTION_CONTEXT_REUSED")
      expect(setups).toBe(2)

      const fresh = await start({ services })
      if (!(Symbol.asyncIterator in fresh)) throw new Error("Fresh context failed")
      const freshIterator = fresh[Symbol.asyncIterator]()
      expect(await freshIterator.next()).toEqual({
        done: false,
        value: { data: { event: "raw" } },
      })
      await freshIterator.return?.()
      expect(setups).toBe(3)
    })

    it("keeps contexts consumed when argument decoding or source setup fails", async () => {
      let defaults = 0
      let transforms = 0
      let setups = 0
      const args = S.Struct({
        token: S.NumberFromString.pipe(
          S.check(S.isFinite()),
          S.decodeTo(S.Number, {
            decode: SchemaGetter.transform((value) => {
              transforms++
              return value
            }),
            encode: SchemaGetter.transform((value) => value),
          }),
          S.withDecodingDefault(
            Effect.sync(() => {
              defaults++
              return "invalid"
            })
          )
        ),
      })
      const schema = makeSchema(
        buildSubscriptionField(
          {
            type: S.Number,
            args,
            subscribe: (operationArgs: S.Schema.Type<typeof args>) => {
              setups++
              return setups === 1
                ? Effect.fail(new Error("Source setup failed"))
                : Effect.succeed(Stream.make(operationArgs.token))
            },
          },
          createFieldBuilderContext()
        )
      )
      const { services } = createSimpleContext()
      const decodeContext = Object.freeze({ services })
      const setupContext = Object.freeze({ services })
      const omitted = parse("subscription { event }")
      const explicit = parse('subscription { event(token: "7") }')
      const invalid = await subscribe({ schema, document: omitted, contextValue: decodeContext })
      if (Symbol.asyncIterator in invalid) throw new Error("Invalid arguments were accepted")
      expect(invalid.errors?.[0].path).toEqual(["event"])
      expectInitialError(
        await subscribe({ schema, document: explicit, contextValue: decodeContext }),
        "SUBSCRIPTION_CONTEXT_REUSED"
      )
      expect(defaults).toBe(1)
      expect(transforms).toBe(0)
      expect(setups).toBe(0)

      const failed = await subscribe({ schema, document: explicit, contextValue: setupContext })
      if (Symbol.asyncIterator in failed) throw new Error("Failed source setup was accepted")
      expect(failed.errors?.[0].message).toContain("Source setup failed")
      expectInitialError(
        await subscribe({ schema, document: explicit, contextValue: setupContext }),
        "SUBSCRIPTION_CONTEXT_REUSED"
      )
      expect(transforms).toBe(1)
      expect(setups).toBe(1)

      const fresh = await subscribe({ schema, document: explicit, contextValue: { services } })
      if (!(Symbol.asyncIterator in fresh)) throw new Error("Fresh context failed")
      const iterator = fresh[Symbol.asyncIterator]()
      expect(await iterator.next()).toEqual({ done: false, value: { data: { event: 7 } } })
      await iterator.return?.()
      expect(defaults).toBe(1)
      expect(transforms).toBe(2)
      expect(setups).toBe(2)
    })

    it("returns actionable initial errors for missing, primitive, or invalid Effect contexts", async () => {
      let setups = 0
      const schema = makeSchema(
        buildSubscriptionField(
          {
            type: S.String,
            subscribe: () => {
              setups++
              return Effect.succeed(Stream.make("raw"))
            },
          },
          createFieldBuilderContext()
        )
      )
      const document = parse("subscription { event }")
      for (const contextValue of [undefined, "not-an-object", { services: {} }]) {
        const error = expectInitialError(
          await subscribe({ schema, document, contextValue }),
          "SUBSCRIPTION_CONTEXT_REQUIRED"
        )
        expect(error.message).toMatch(/context/i)
        expect(error.message).toMatch(/services/)
      }
      expect(setups).toBe(0)
      const fresh = await subscribe({ schema, document, contextValue: createSimpleContext() })
      if (!(Symbol.asyncIterator in fresh)) throw new Error("Valid Effect context failed")
      const iterator = fresh[Symbol.asyncIterator]()
      expect(await iterator.next()).toEqual({ done: false, value: { data: { event: "raw" } } })
      await iterator.return?.()
      expect(setups).toBe(1)
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

      // When no custom resolve, it should return the value directly (but async for Option encoding)
      const result = await config.resolve!("payload", {}, createSimpleContext(), {} as any)
      expect(result).toBe("payload")
    })

    it.each([false, true])(
      "resolves subscription events with arguments enabled: %s",
      async (withArgs) => {
        const field = buildSubscriptionField(
          {
            type: S.String,
            args: withArgs ? S.Struct({ suffix: S.String }) : undefined,
            subscribe: () => Effect.succeed(Stream.make("hello")),
            resolve: (value: string, args: { suffix?: string }) =>
              Effect.succeed(`${value.toUpperCase()}${args.suffix ?? ""}`),
          },
          createFieldBuilderContext()
        )
        const schema = new GraphQLSchema({
          query: new GraphQLObjectType({
            name: "Query",
            fields: { ready: { type: GraphQLString, resolve: () => "ready" } },
          }),
          subscription: new GraphQLObjectType({
            name: "Subscription",
            fields: { event: field },
          }),
        })
        const result = await subscribe({
          schema,
          document: parse(`subscription { event${withArgs ? '(suffix: "!")' : ""} }`),
          contextValue: createSimpleContext(),
        })
        if (!(Symbol.asyncIterator in result)) throw new Error("Subscription failed")
        const iterator = result[Symbol.asyncIterator]()
        expect(await iterator.next()).toEqual({
          done: false,
          value: { data: { event: withArgs ? "HELLO!" : "HELLO" } },
        })
        await iterator.return?.()
      }
    )

    it.each([
      { payload: Object.freeze({ id: "event-1" }), id: "event-1", rootId: "event-1" },
      { payload: "primitive-event", id: "resolved", rootId: "primitive-event" },
      { payload: null, id: "resolved", rootId: "null" },
    ])(
      "exposes the original $payload root to middleware match and apply",
      async ({ payload, id, rootId }) => {
        const ctx = createFieldBuilderContext()
        const matched: GraphQLResolveInfo[] = []
        const applied: GraphQLResolveInfo[] = []
        ctx.middlewares = [
          {
            name: "rootPayload",
            match: (info) => {
              // Subscription setup has no emitted root value yet.
              if (info.rootValue === undefined) return false
              matched.push(info)
              return info.rootValue === payload
            },
            apply: <A, E, R>(effect: Effect.Effect<A, E, R>, context: MiddlewareContext) => {
              applied.push(context.info)
              return context.info.fieldName === "rootId"
                ? Effect.map(
                    effect,
                    () => String(context.info.rootValue?.id ?? context.info.rootValue) as A
                  )
                : effect
            },
          },
        ]
        const Event = S.Struct({ id: S.String })
        const eventType = new GraphQLObjectType({
          name: "Event",
          fields: () => ({
            id: { type: GraphQLString },
            rootId: buildObjectField(
              { type: S.String, resolve: () => Effect.succeed("unmatched") },
              ctx
            ),
          }),
        })
        ctx.types.set("Event", { name: "Event", schema: Event })
        ctx.typeRegistry.set("Event", eventType)
        const schema = new GraphQLSchema({
          query: new GraphQLObjectType({
            name: "Query",
            fields: { ready: { type: GraphQLString, resolve: () => "ready" } },
          }),
          subscription: new GraphQLObjectType({
            name: "Subscription",
            fields: {
              event: buildSubscriptionField(
                {
                  type: Event,
                  subscribe: () => Effect.succeed(Stream.make(payload)),
                  resolve: (value: typeof payload) =>
                    Effect.succeed(
                      typeof value === "object" && value !== null ? value : { id: "resolved" }
                    ),
                },
                ctx
              ),
            },
          }),
        })
        const result = await subscribe({
          schema,
          document: parse("subscription { event { id rootId } }"),
          contextValue: createSimpleContext(),
        })
        if (!(Symbol.asyncIterator in result)) throw new Error("Subscription failed")
        const iterator = result[Symbol.asyncIterator]()
        try {
          expect(await iterator.next()).toEqual({
            done: false,
            value: { data: { event: { id, rootId } } },
          })
          expect(matched.map((info) => info.fieldName)).toEqual(["event", "rootId"])
          expect(applied.map((info) => info.fieldName)).toEqual(["event", "rootId"])
          for (const info of [...matched, ...applied]) {
            expect(info.rootValue).toBe(payload)
          }
        } finally {
          await iterator.return?.()
        }
      }
    )

    it.each(["frozen", "primitive", "null", "undefined"] as const)(
      "preserves native %s roots across concurrent asynchronously wrapped event resolvers",
      async (kind) => {
        const roots: string[] = []
        const recordRoot = (surface: string, info: GraphQLResolveInfo) => {
          expect(info.rootValue).toBe(payload)
          roots.push(surface)
        }
        const rootDefault = (_args: unknown, _context: unknown, info: GraphQLResolveInfo) => {
          recordRoot("sourceFunction", info)
          return rootId
        }
        const payload =
          kind === "frozen"
            ? Object.freeze({ id: "event-1", rootDefault })
            : kind === "primitive"
              ? "primitive-event"
              : kind === "null"
                ? null
                : undefined
        const rootId = kind === "frozen" ? "event-1" : String(payload)
        let defaults = 0
        let transforms = 0
        let closed = 0
        const args = S.Struct({
          token: S.NumberFromString.pipe(
            S.decodeTo(S.Number, {
              decode: SchemaGetter.transform((value) => {
                transforms++
                return value
              }),
              encode: SchemaGetter.transform((value) => value),
            }),
            S.withDecodingDefault(Effect.sync(() => String(++defaults)))
          ),
        })
        const subscribed: S.Schema.Type<typeof args>[] = []
        const resolved: S.Schema.Type<typeof args>[] = []
        const ctx = createFieldBuilderContext()
        const Event = S.Struct({ id: S.String })
        const eventInterface = new GraphQLInterfaceType({
          name: "EventInterface",
          fields: {
            id: { type: GraphQLString },
            token: { type: GraphQLString },
            rootNative: { type: GraphQLString },
            rootDefault: { type: GraphQLString },
            rootCustom: { type: GraphQLString },
          },
          resolveType: (_value, _context, info) => {
            recordRoot("resolveType", info)
            return "Event"
          },
        })
        const eventType = new GraphQLObjectType({
          name: "Event",
          interfaces: [eventInterface],
          fields: {
            id: { type: GraphQLString },
            token: { type: GraphQLString },
            rootNative: {
              type: GraphQLString,
              resolve: (_parent, _args, _context, info) => {
                recordRoot("nativeResolve", info)
                return rootId
              },
            },
            rootDefault: { type: GraphQLString },
            rootCustom: { type: GraphQLString },
          },
          isTypeOf: (_value, _context, info) => {
            recordRoot("isTypeOf", info)
            return true
          },
        })
        ctx.types.set("Event", { name: "Event", schema: Event })
        ctx.typeRegistry.set("Event", eventType)
        const field = buildSubscriptionField(
          {
            type: Event,
            args,
            subscribe: (operationArgs: S.Schema.Type<typeof args>) => {
              subscribed.push(operationArgs)
              return Effect.succeed(
                Stream.make(payload, payload).pipe(
                  Stream.ensuring(
                    Effect.sync(() => {
                      closed++
                    })
                  )
                )
              )
            },
            resolve: (_value: typeof payload, operationArgs: S.Schema.Type<typeof args>) => {
              expect(_value).toBe(payload)
              resolved.push(operationArgs)
              return Effect.succeed({ id: rootId, token: operationArgs.token, rootDefault })
            },
          },
          ctx
        )
        const schema = new GraphQLSchema({
          types: [eventType],
          query: new GraphQLObjectType({
            name: "Query",
            fields: { ready: { type: GraphQLString } },
          }),
          subscription: new GraphQLObjectType({
            name: "Subscription",
            fields: { event: { ...field, type: eventInterface } },
          }),
        })
        const actualField = schema.getSubscriptionType()!.getFields().event
        const originalResolve = actualField.resolve!
        const releases: (() => void)[] = []
        const gates = [
          new Promise<void>((resolve) => {
            releases[0] = resolve
          }),
          new Promise<void>((resolve) => {
            releases[1] = resolve
          }),
        ]
        let allEntered!: () => void
        const ready = new Promise<void>((resolve) => {
          allEntered = resolve
        })
        let entered = 0
        const request = {
          schema,
          document: Object.freeze(
            parse("subscription { event { id token rootNative rootDefault rootCustom } }")
          ),
          variableValues: Object.freeze({}),
          fieldResolver: (
            parent: unknown,
            fieldArgs: Record<string, unknown>,
            context: unknown,
            info: GraphQLResolveInfo
          ) => {
            recordRoot("fieldResolver", info)
            return info.fieldName === "rootCustom"
              ? rootId
              : defaultFieldResolver(parent, fieldArgs, context, info)
          },
        }
        const { services } = createSimpleContext()
        const sources = await Promise.all([
          subscribe({ ...request, contextValue: Object.freeze({ services }) }),
          subscribe({ ...request, contextValue: Object.freeze({ services }) }),
        ])
        const iterators = sources.map((source) => {
          if (!(Symbol.asyncIterator in source)) throw new Error("Subscription failed")
          return source[Symbol.asyncIterator]()
        })
        actualField.resolve = async (value, fieldArgs, context, info) => {
          recordRoot("asyncRootWrapper", info)
          const index = entered++
          if (entered === 2) allEntered()
          await gates[index]
          return originalResolve(value, fieldArgs, context, info)
        }
        try {
          const pending = iterators.map((iterator) => iterator.next())
          await ready
          releases[1]()
          const second = await pending[1]
          releases[0]()
          const first = await pending[0]
          for (const [event, token] of [
            [first, "1"],
            [second, "2"],
          ] as const) {
            expect(event).toEqual({
              done: false,
              value: {
                data: {
                  event: {
                    id: rootId,
                    token,
                    rootNative: rootId,
                    rootDefault: rootId,
                    rootCustom: rootId,
                  },
                },
              },
            })
          }
          expect(defaults).toBe(2)
          expect(transforms).toBe(2)
          expect(subscribed[0]).not.toBe(subscribed[1])
          expect(resolved[0]).toBe(subscribed[1])
          expect(resolved[1]).toBe(subscribed[0])
          for (const surface of [
            "nativeResolve",
            "sourceFunction",
            "fieldResolver",
            "resolveType",
            "isTypeOf",
            "asyncRootWrapper",
          ]) {
            expect(roots.filter((root) => root === surface)).toHaveLength(
              surface === "fieldResolver" ? 8 : 2
            )
          }
        } finally {
          releases.forEach((release) => release())
          for (const iterator of iterators) await iterator.return?.()
        }
        expect(closed).toBe(2)
      }
    )
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
      const iterable = await config.subscribe!(null, {}, testContext, subscriptionInfo)
      const typedIterator = (iterable as AsyncIterable<string>)[Symbol.asyncIterator]()

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
      ctx.middlewares = [
        {
          name: "uppercase",
          apply: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.map(effect, (value) => String(value).toUpperCase() as unknown as A),
        },
      ]

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

      ctx.middlewares = [
        {
          name: "adminOnly",
          match: (info) => info.fieldName.startsWith("admin"),
          apply: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.map(effect, (value) => `ADMIN:${value}` as unknown as A),
        },
      ]

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
      ctx.middlewares = [
        {
          name: "capture",
          apply: <A, E, R>(effect: Effect.Effect<A, E, R>, context: any) => {
            capturedContext = context
            return effect
          },
        },
      ]

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
        apply:
          (args: { text: string }) =>
          <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.map(effect, (value) => `${args.text}${value}` as unknown as A),
      })

      // Middleware wraps second (outermost)
      ctx.middlewares = [
        {
          name: "wrap",
          apply: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.map(effect, (value) => `[${value}]` as unknown as A),
        },
      ]

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
      ctx.middlewares = [
        {
          name: "captureParent",
          apply: <A, E, R>(effect: Effect.Effect<A, E, R>, context: any) => {
            capturedParent = context.parent
            return effect
          },
        },
      ]

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

  // ==========================================================================
  // Middleware Edge Cases
  // ==========================================================================
  describe("Middleware Edge Cases", () => {
    it("should propagate errors thrown by middleware", async () => {
      const ctx = createFieldBuilderContext()

      ctx.middlewares = [
        {
          name: "errorMiddleware",
          apply: <A, E, R2>(_effect: Effect.Effect<A, E, R2>) =>
            Effect.fail(new Error("Middleware error")) as unknown as Effect.Effect<A, E, R2>,
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

      await expect(config.resolve!(null, {}, testContext, mockInfo)).rejects.toThrow(
        "Middleware error"
      )
    })

    it("should handle Effect-based middleware operations", async () => {
      const ctx = createFieldBuilderContext()
      const operationOrder: string[] = []

      ctx.middlewares = [
        {
          name: "loggingMiddleware",
          apply: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.gen(function* () {
              operationOrder.push("before")
              const result = yield* effect
              operationOrder.push("after")
              return result
            }) as Effect.Effect<A, E, R>,
        },
      ]

      const config = buildField(
        {
          type: S.String,
          resolve: () =>
            Effect.sync(() => {
              operationOrder.push("resolve")
              return "value"
            }),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const mockInfo = { fieldName: "test", parentType: { name: "Query" } } as any
      const result = await config.resolve!(null, {}, testContext, mockInfo)

      expect(result).toBe("value")
      expect(operationOrder).toEqual(["before", "resolve", "after"])
    })

    it("should short-circuit when middleware returns early", async () => {
      const ctx = createFieldBuilderContext()
      let resolverEffectRan = false

      ctx.middlewares = [
        {
          name: "shortCircuit",
          apply: <A, E, R>(_effect: Effect.Effect<A, E, R>) =>
            Effect.succeed("cached" as unknown as A),
        },
      ]

      const config = buildField(
        {
          type: S.String,
          resolve: () =>
            Effect.sync(() => {
              resolverEffectRan = true
              return "value"
            }),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const mockInfo = { fieldName: "test", parentType: { name: "Query" } } as any
      const result = await config.resolve!(null, {}, testContext, mockInfo)

      expect(result).toBe("cached")
      // The resolver Effect was not executed because middleware short-circuited
      expect(resolverEffectRan).toBe(false)
    })

    it("should preserve error type through middleware chain", async () => {
      const ctx = createFieldBuilderContext()

      ctx.middlewares = [
        {
          name: "passthrough",
          apply: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
        },
      ]

      const config = buildField(
        {
          type: S.String,
          resolve: () => Effect.fail(new Error("Test error")),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const mockInfo = { fieldName: "test", parentType: { name: "Query" } } as any

      await expect(config.resolve!(null, {}, testContext, mockInfo)).rejects.toThrow("Test error")
    })

    it("should handle middleware that recovers from errors", async () => {
      const ctx = createFieldBuilderContext()

      ctx.middlewares = [
        {
          name: "fallbackMiddleware",
          apply: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.catch(effect, () => Effect.succeed("fallback" as unknown as A)),
        },
      ]

      const config = buildField(
        {
          type: S.String,
          resolve: () => Effect.fail(new Error("Original error")),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const mockInfo = { fieldName: "test", parentType: { name: "Query" } } as any
      const result = await config.resolve!(null, {}, testContext, mockInfo)

      expect(result).toBe("fallback")
    })

    it("should apply match predicate for each middleware independently", async () => {
      const ctx = createFieldBuilderContext()

      ctx.middlewares = [
        {
          name: "queryOnly",
          match: (info) => info.parentType.name === "Query",
          apply: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.map(effect, (v) => `Q:${v}` as unknown as A),
        },
        {
          name: "mutationOnly",
          match: (info) => info.parentType.name === "Mutation",
          apply: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.map(effect, (v) => `M:${v}` as unknown as A),
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

      // Query context - only queryOnly middleware applies
      const queryInfo = { fieldName: "test", parentType: { name: "Query" } } as any
      const queryResult = await config.resolve!(null, {}, testContext, queryInfo)
      expect(queryResult).toBe("Q:value")

      // Mutation context - only mutationOnly middleware applies
      const mutationInfo = { fieldName: "test", parentType: { name: "Mutation" } } as any
      const mutationResult = await config.resolve!(null, {}, testContext, mutationInfo)
      expect(mutationResult).toBe("M:value")

      // Other context - no middleware applies
      const otherInfo = { fieldName: "test", parentType: { name: "Subscription" } } as any
      const otherResult = await config.resolve!(null, {}, testContext, otherInfo)
      expect(otherResult).toBe("value")
    })
  })

  // ==========================================================================
  // Option Type Encoding
  // ==========================================================================
  describe("Option Type Encoding", () => {
    it("should encode Option.none() to null for S.OptionFromNullOr", async () => {
      const ctx = createFieldBuilderContext()
      const config = buildField(
        {
          type: S.OptionFromNullOr(S.String),
          resolve: () => Effect.succeed(Option.none()),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const result = await config.resolve!(null, {}, testContext, {} as any)
      expect(result).toBe(null)
    })

    it("should encode Option.some(value) to value for S.OptionFromNullOr", async () => {
      const ctx = createFieldBuilderContext()
      const config = buildField(
        {
          type: S.OptionFromNullOr(S.String),
          resolve: () => Effect.succeed(Option.some("hello")),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const result = await config.resolve!(null, {}, testContext, {} as any)
      expect(result).toBe("hello")
    })

    it("should encode Option.none() to undefined for S.OptionFromUndefinedOr", async () => {
      const ctx = createFieldBuilderContext()
      const config = buildField(
        {
          type: S.OptionFromUndefinedOr(S.String),
          resolve: () => Effect.succeed(Option.none()),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const result = await config.resolve!(null, {}, testContext, {} as any)
      expect(result).toBe(undefined)
    })

    it("should encode Option.some(value) to value for S.OptionFromUndefinedOr", async () => {
      const ctx = createFieldBuilderContext()
      const config = buildField(
        {
          type: S.OptionFromUndefinedOr(S.String),
          resolve: () => Effect.succeed(Option.some("world")),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const result = await config.resolve!(null, {}, testContext, {} as any)
      expect(result).toBe("world")
    })

    it("should encode Option with Int inner type", async () => {
      const ctx = createFieldBuilderContext()
      const config = buildField(
        {
          type: S.OptionFromNullOr(S.Int),
          resolve: () => Effect.succeed(Option.some(42)),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const result = await config.resolve!(null, {}, testContext, {} as any)
      expect(result).toBe(42)
    })

    it("should not modify non-Option types", async () => {
      const ctx = createFieldBuilderContext()
      const config = buildField(
        {
          type: S.String,
          resolve: () => Effect.succeed("plain string"),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const result = await config.resolve!(null, {}, testContext, {} as any)
      expect(result).toBe("plain string")
    })

    it("should encode Option in object fields", async () => {
      const ctx = createFieldBuilderContext()
      const config = buildObjectField(
        {
          type: S.OptionFromNullOr(S.String),
          resolve: (parent: { value: Option.Option<string> }) => Effect.succeed(parent.value),
        },
        ctx
      )

      const testContext = createSimpleContext()

      // Test with Some
      const someResult = await config.resolve!(
        { value: Option.some("test") },
        {},
        testContext,
        {} as any
      )
      expect(someResult).toBe("test")

      // Test with None
      const noneResult = await config.resolve!({ value: Option.none() }, {}, testContext, {} as any)
      expect(noneResult).toBe(null)
    })

    it("should encode Option with object inner type", async () => {
      const UserSchema = S.Struct({ id: S.String, name: S.String })
      const ctx = createFieldBuilderContext()
      const config = buildField(
        {
          type: S.OptionFromNullOr(UserSchema),
          resolve: () => Effect.succeed(Option.some({ id: "1", name: "Alice" })),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const result = await config.resolve!(null, {}, testContext, {} as any)
      expect(result).toEqual({ id: "1", name: "Alice" })
    })

    it("should encode Option.none() with object inner type to null", async () => {
      const UserSchema = S.Struct({ id: S.String, name: S.String })
      const ctx = createFieldBuilderContext()
      const config = buildField(
        {
          type: S.OptionFromNullOr(UserSchema),
          resolve: () => Effect.succeed(Option.none()),
        },
        ctx
      )

      const testContext = createSimpleContext()
      const result = await config.resolve!(null, {}, testContext, {} as any)
      expect(result).toBe(null)
    })
  })
})
