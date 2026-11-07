import { describe, expect, expectTypeOf, it } from "vitest"
import { Context, Effect, Layer, Stream } from "effect"
import * as S from "effect/Schema"
import * as Getter from "effect/SchemaGetter"
import { graphql, parse, subscribe } from "graphql"
import { HttpRouter } from "effect/http"
import {
  GraphQLSchemaBuilder,
  makeSubscriptionContext,
  type FieldRegistration,
  type ObjectFieldRegistration,
  type SubscriptionFieldRegistration,
} from "../../../src/builder"
import * as api from "../../../src/builder/pipe-api"
import { toRouter } from "../../../src/server/schema-builder-extensions"

type BuilderRequirements<Builder> = Builder extends GraphQLSchemaBuilder<infer R> ? R : never
describe("argument decoding service requirements", () => {
  const Offset = Context.Service<{ offset: number }>("argument-services/Offset")
  const Label = Context.Service<{ label: string }>("argument-services/Label")
  const args = S.Struct({
    amount: S.String.pipe(
      S.decodeTo(S.Number, {
        decode: Getter.transformEffect((value) =>
          Effect.map(Offset, ({ offset }) => Number(value) + offset)
        ),
        encode: Getter.transform(String),
      })
    ),
  })
  const Box = S.Struct({ id: S.String })
  const services = Context.make(Offset, { offset: 10 }).pipe(Context.add(Label, { label: "ready" }))
  type Requirements =
    | Context.Service.Identifier<typeof Offset>
    | Context.Service.Identifier<typeof Label>

  it.each(["methods", "pipe"] as const)(
    "keeps absent and present optional pure fields service-free through %s",
    async (style) => {
      type PureField = ObjectFieldRegistration<
        S.Schema.Type<typeof Box>,
        void,
        string,
        never,
        never
      >
      for (const present of [false, true]) {
        const fields: { readonly text?: PureField } = present
          ? { text: { type: S.String, resolve: (parent) => Effect.succeed(parent.id) } }
          : {}
        const base = GraphQLSchemaBuilder.empty.query("box", {
          type: Box,
          resolve: () => Effect.succeed({ id: "box" }),
        })
        const builder =
          style === "methods"
            ? base.objectType({ name: "Box", schema: Box, fields })
            : base.pipe(api.objectType({ name: "Box", schema: Box, fields }))
        expectTypeOf<BuilderRequirements<typeof builder>>().toEqualTypeOf<never>()
        const app = HttpRouter.toWebHandler(toRouter(builder, Layer.empty))
        try {
          const response = await app.handler(
            new Request("http://localhost/graphql", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ query: present ? "{ box { id text } }" : "{ box { id } }" }),
            })
          )
          expect(await response.json()).toEqual({
            data: { box: present ? { id: "box", text: "box" } : { id: "box" } },
          })
        } finally {
          await app.dispose()
        }
      }
    }
  )

  it.each(["methods", "pipe"] as const)(
    "retains optional fields' decoder and resolver services through %s",
    async (style) => {
      type OptionalField = ObjectFieldRegistration<
        S.Schema.Type<typeof Box>,
        S.Schema.Type<typeof args>,
        string,
        never,
        Context.Service.Identifier<typeof Label>,
        Context.Service.Identifier<typeof Offset>
      >
      const fields: Partial<Record<"text", OptionalField>> = {
        text: {
          type: S.String,
          args,
          resolve: (parent, { amount }) =>
            Effect.map(Label, ({ label }) => `${label}:${parent.id}:${amount}`),
        },
      }
      const base = GraphQLSchemaBuilder.empty.query("box", {
        type: Box,
        resolve: () => Effect.succeed({ id: "box" }),
      })
      const builder =
        style === "methods"
          ? base.objectType({ name: "Box", schema: Box, fields })
          : base.pipe(api.objectType({ name: "Box", schema: Box, fields }))
      expectTypeOf<BuilderRequirements<typeof builder>>().toEqualTypeOf<Requirements>()
      const _missingServices = () => {
        // @ts-expect-error optional fields still require their argument decoder service
        toRouter(builder, Layer.succeed(Label, { label: "ready" }))
        // @ts-expect-error optional fields still require their resolver service
        toRouter(builder, Layer.succeed(Offset, { offset: 10 }))
      }
      const app = HttpRouter.toWebHandler(
        toRouter(
          builder,
          Layer.merge(
            Layer.succeed(Offset, { offset: 10 }),
            Layer.succeed(Label, { label: "ready" })
          )
        )
      )
      try {
        const response = await app.handler(
          new Request("http://localhost/graphql", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: '{ box { text(amount: "2") } }' }),
          })
        )
        expect(await response.json()).toEqual({ data: { box: { text: "ready:box:12" } } })
      } finally {
        await app.dispose()
      }
    }
  )

  it.each(["methods", "pipe"] as const)(
    "infers every branch of reusable pure field maps through %s",
    async (style) => {
      const first = {
        type: S.String,
        resolve: (parent: S.Schema.Type<typeof Box>) => Effect.succeed(`first:${parent.id}`),
      }
      const second = {
        type: S.String,
        resolve: (parent: S.Schema.Type<typeof Box>) => Effect.succeed(`second:${parent.id}`),
      }
      const makeFields = (
        useFirst: boolean
      ): { first: typeof first } | { second: typeof second } => (useFirst ? { first } : { second })
      for (const useFirst of [false, true]) {
        const fields = makeFields(useFirst)
        const base = GraphQLSchemaBuilder.empty.query("box", {
          type: Box,
          resolve: () => Effect.succeed({ id: "box" }),
        })
        const builder =
          style === "methods"
            ? base.objectType({ name: "Box", schema: Box, fields })
            : base.pipe(api.objectType({ name: "Box", schema: Box, fields }))
        expectTypeOf<BuilderRequirements<typeof builder>>().toEqualTypeOf<never>()
        const field = useFirst ? "first" : "second"
        expect(
          await graphql({
            schema: builder.buildSchema(),
            source: `{ box { ${field} } }`,
            contextValue: { services: Context.empty() },
          })
        ).toEqual({ data: { box: { [field]: `${field}:box` } } })
      }
    }
  )

  it.each(["methods", "pipe"] as const)(
    "retains services across optional field config unions through %s",
    async (style) => {
      const decoded = {
        type: S.String,
        args,
        resolve: (parent: S.Schema.Type<typeof Box>, { amount }: S.Schema.Type<typeof args>) =>
          Effect.map(Label, ({ label }) => `${label}:${parent.id}:${amount}`),
      }
      const plain = {
        type: S.String,
        resolve: (parent: S.Schema.Type<typeof Box>) => Effect.succeed(parent.id),
      }
      const makeFields = (withArgs: boolean): { text?: typeof decoded | typeof plain } => ({
        text: withArgs ? decoded : plain,
      })
      for (const withArgs of [false, true]) {
        const fields = makeFields(withArgs)
        const base = GraphQLSchemaBuilder.empty.query("box", {
          type: Box,
          resolve: () => Effect.succeed({ id: "box" }),
        })
        const builder =
          style === "methods"
            ? base.objectType({ name: "Box", schema: Box, fields })
            : base.pipe(api.objectType({ name: "Box", schema: Box, fields }))
        expectTypeOf<BuilderRequirements<typeof builder>>().toEqualTypeOf<Requirements>()
        const _missingServices = () => {
          // @ts-expect-error an optional config union still requires its decoder service
          toRouter(builder, Layer.succeed(Label, { label: "ready" }))
          // @ts-expect-error an optional config union still requires its resolver service
          toRouter(builder, Layer.succeed(Offset, { offset: 10 }))
        }
        const app = HttpRouter.toWebHandler(
          toRouter(
            builder,
            Layer.merge(
              Layer.succeed(Offset, { offset: 10 }),
              Layer.succeed(Label, { label: "ready" })
            )
          )
        )
        try {
          const response = await app.handler(
            new Request("http://localhost/graphql", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                query: withArgs ? '{ box { text(amount: "2") } }' : "{ box { text } }",
              }),
            })
          )
          expect(await response.json()).toEqual({
            data: { box: { text: withArgs ? "ready:box:12" : "box" } },
          })
        } finally {
          await app.dispose()
        }
      }
    }
  )

  it.each(["methods", "pipe"] as const)(
    "retains services from disjoint reusable field maps through %s",
    async (style) => {
      const decoded = {
        type: S.String,
        args,
        resolve: (parent: S.Schema.Type<typeof Box>, { amount }: S.Schema.Type<typeof args>) =>
          Effect.map(Label, ({ label }) => `${label}:${parent.id}:${amount}`),
      }
      const plain = {
        type: S.String,
        resolve: (parent: S.Schema.Type<typeof Box>) => Effect.succeed(parent.id),
      }
      const makeFields = (
        withArgs: boolean
      ): { decoded: typeof decoded } | { plain: typeof plain } =>
        withArgs ? { decoded } : { plain }
      for (const withArgs of [false, true]) {
        const fields = makeFields(withArgs)
        const base = GraphQLSchemaBuilder.empty.query("box", {
          type: Box,
          resolve: () => Effect.succeed({ id: "box" }),
        })
        const builder =
          style === "methods"
            ? base.objectType({ name: "Box", schema: Box, fields })
            : base.pipe(api.objectType({ name: "Box", schema: Box, fields }))
        expectTypeOf<BuilderRequirements<typeof builder>>().toEqualTypeOf<Requirements>()
        const _missingServices = () => {
          // @ts-expect-error disjoint maps still require their argument decoder service
          toRouter(builder, Layer.succeed(Label, { label: "ready" }))
          // @ts-expect-error disjoint maps still require their resolver service
          toRouter(builder, Layer.succeed(Offset, { offset: 10 }))
        }
        expect(
          await graphql({
            schema: builder.buildSchema(),
            source: withArgs ? '{ box { decoded(amount: "2") } }' : "{ box { plain } }",
            contextValue: { services },
          })
        ).toEqual({
          data: { box: withArgs ? { decoded: "ready:box:12" } : { plain: "box" } },
        })
      }
    }
  )
  it.each(["methods", "pipe"] as const)(
    "keeps explicitly typed service-free registrations runnable with Layer.empty through %s",
    async (style) => {
      const hello: FieldRegistration<void, string, never, never> = {
        type: S.String,
        resolve: () => Effect.succeed("world"),
      }
      const idCopy: ObjectFieldRegistration<
        S.Schema.Type<typeof Box>,
        void,
        string,
        never,
        never
      > = {
        type: S.String,
        resolve: (parent) => Effect.succeed(parent.id),
      }
      const updates: SubscriptionFieldRegistration<void, string, never, never> = {
        type: S.String,
        subscribe: () => Effect.succeed(Stream.make("updated")),
      }
      const base = GraphQLSchemaBuilder.empty.query("box", {
        type: Box,
        resolve: () => Effect.succeed({ id: "box" }),
      })
      const builder =
        style === "methods"
          ? base
              .query("hello", hello)
              .mutation("hello", hello)
              .objectType({ name: "Box", schema: Box, fields: { idCopy } })
              .field("Box", "idAgain", idCopy)
              .subscription("updates", updates)
          : base.pipe(
              api.query("hello", hello),
              api.mutation("hello", hello),
              api.objectType({ name: "Box", schema: Box, fields: { idCopy } }),
              api.field("Box", "idAgain", idCopy),
              api.subscription("updates", updates)
            )
      expectTypeOf<BuilderRequirements<typeof builder>>().toEqualTypeOf<never>()
      const app = HttpRouter.toWebHandler(toRouter(builder, Layer.empty))
      try {
        const response = await app.handler(
          new Request("http://localhost/graphql", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: "{ hello box { idCopy idAgain } }" }),
          })
        )
        expect(await response.json()).toEqual({
          data: { hello: "world", box: { idCopy: "box", idAgain: "box" } },
        })
      } finally {
        await app.dispose()
      }
      const result = await subscribe({
        schema: builder.buildSchema(),
        document: parse("subscription { updates }"),
        contextValue: makeSubscriptionContext({ services: Context.empty() }),
      })
      if (!(Symbol.asyncIterator in result)) throw new Error("Subscription failed")
      const iterator = result[Symbol.asyncIterator]()
      expect(await iterator.next()).toEqual({
        done: false,
        value: { data: { updates: "updated" } },
      })
      await iterator.return?.()
    }
  )

  it.each(["methods", "pipe"] as const)(
    "retains explicitly annotated decoder requirements through %s",
    async (style) => {
      type Args = S.Schema.Type<typeof args>
      type DecoderServices = Context.Service.Identifier<typeof Offset>
      const amount: FieldRegistration<Args, number, never, never, DecoderServices> = {
        type: S.Number,
        args,
        resolve: ({ amount }) => Effect.succeed(amount),
      }
      const inline: ObjectFieldRegistration<
        S.Schema.Type<typeof Box>,
        Args,
        number,
        never,
        never,
        DecoderServices
      > = {
        type: S.Number,
        args,
        resolve: (parent, { amount }) => Effect.succeed(amount + parent.id.length),
      }
      const updates: SubscriptionFieldRegistration<Args, number, never, never, DecoderServices> = {
        type: S.Number,
        args,
        subscribe: ({ amount }) => Effect.succeed(Stream.make(amount)),
      }
      const base = GraphQLSchemaBuilder.empty.query("box", {
        type: Box,
        resolve: () => Effect.succeed({ id: "box" }),
      })
      const query =
        style === "methods" ? base.query("amount", amount) : base.pipe(api.query("amount", amount))
      const mutation =
        style === "methods"
          ? base.mutation("amount", amount)
          : base.pipe(api.mutation("amount", amount))
      const field =
        style === "methods"
          ? base.objectType({ name: "Box", schema: Box }).field("Box", "amount", inline)
          : base.pipe(
              api.objectType({ name: "Box", schema: Box }),
              api.field("Box", "amount", inline)
            )
      const object =
        style === "methods"
          ? base.objectType({ name: "Box", schema: Box, fields: { amount: inline } })
          : base.pipe(api.objectType({ name: "Box", schema: Box, fields: { amount: inline } }))
      const subscription =
        style === "methods"
          ? base.subscription("amount", updates)
          : base.pipe(api.subscription("amount", updates))
      expectTypeOf<BuilderRequirements<typeof query>>().toEqualTypeOf<DecoderServices>()
      expectTypeOf<BuilderRequirements<typeof mutation>>().toEqualTypeOf<DecoderServices>()
      expectTypeOf<BuilderRequirements<typeof field>>().toEqualTypeOf<DecoderServices>()
      expectTypeOf<BuilderRequirements<typeof object>>().toEqualTypeOf<DecoderServices>()
      expectTypeOf<BuilderRequirements<typeof subscription>>().toEqualTypeOf<DecoderServices>()
      const _missingServices = () => {
        // @ts-expect-error an annotated query still requires its argument decoder service
        toRouter(query, Layer.empty)
        // @ts-expect-error an annotated mutation still requires its argument decoder service
        toRouter(mutation, Layer.empty)
        // @ts-expect-error an annotated object field still requires its argument decoder service
        toRouter(field, Layer.empty)
        // @ts-expect-error an annotated inline field still requires its argument decoder service
        toRouter(object, Layer.empty)
        // @ts-expect-error an annotated subscription still requires its argument decoder service
        toRouter(subscription, Layer.empty)
      }
      expect(
        await graphql({
          schema: object.buildSchema(),
          source: '{ box { amount(amount: "2") } }',
          contextValue: { services },
        })
      ).toEqual({ data: { box: { amount: 15 } } })
    }
  )

  it("retains decoder services through nested composition and operation arrays", async () => {
    const amount = api.query("amount", {
      type: S.Number,
      args,
      resolve: ({ amount }) => Effect.succeed(amount * 2),
    })
    const operations = [
      api.compose(amount),
      api.query("ready", {
        type: S.String,
        resolve: () => Effect.map(Label, ({ label }) => label),
      }),
    ]
    const builder = GraphQLSchemaBuilder.empty.pipe(api.compose(...operations))
    expectTypeOf<BuilderRequirements<typeof builder>>().toEqualTypeOf<Requirements>()
    const base = GraphQLSchemaBuilder.empty.query("ready", {
      type: S.String,
      resolve: () => Effect.map(Label, ({ label }) => label),
    })
    const _withExisting = base.pipe(api.compose(amount))
    const _unchanged = base.pipe(api.compose())
    expectTypeOf<BuilderRequirements<typeof _withExisting>>().toEqualTypeOf<Requirements>()
    expectTypeOf<BuilderRequirements<typeof _unchanged>>().toEqualTypeOf<
      Context.Service.Identifier<typeof Label>
    >()
    const _requiresServices = () => {
      // @ts-expect-error composed decoder requirements cannot be discarded
      toRouter(GraphQLSchemaBuilder.empty.pipe(api.compose(amount)), Layer.empty)
      // @ts-expect-error nested/array composition also retains resolver requirements
      toRouter(builder, Layer.succeed(Offset, { offset: 10 }))
    }
    const layer = Layer.merge(
      Layer.succeed(Offset, { offset: 10 }),
      Layer.succeed(Label, { label: "ready" })
    )
    const app = HttpRouter.toWebHandler(toRouter(builder, layer))
    try {
      const response = await app.handler(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: '{ ready amount(amount: "2") }' }),
        })
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ data: { ready: "ready", amount: 24 } })
    } finally {
      await app.dispose()
    }
  })

  it("preserves custom operation requirements without type-only metadata", async () => {
    const withHello = <R>(builder: GraphQLSchemaBuilder<R>) =>
      builder.query("hello", { type: S.String, resolve: () => Effect.succeed("world") })
    const withAmount = <R>(builder: GraphQLSchemaBuilder<R>) =>
      builder.query("amount", {
        type: S.Number,
        args,
        resolve: ({ amount }) => Effect.succeed(amount * 2),
      })
    const withLabel = <R>(builder: GraphQLSchemaBuilder<R>) =>
      builder.query("ready", {
        type: S.String,
        resolve: () => Effect.map(Label, ({ label }) => label),
      })
    const pure = GraphQLSchemaBuilder.empty.pipe(api.compose(withHello))
    expectTypeOf<BuilderRequirements<typeof pure>>().toEqualTypeOf<never>()
    toRouter(pure, Layer.empty)
    const _inline = GraphQLSchemaBuilder.empty.pipe(
      api.compose((builder) =>
        builder.query("hello", { type: S.String, resolve: () => Effect.succeed("inline") })
      )
    )
    expectTypeOf<BuilderRequirements<typeof _inline>>().toEqualTypeOf<never>()
    const custom = api.compose(withHello, withAmount, withLabel)
    const builder = GraphQLSchemaBuilder.empty.pipe(custom)
    expectTypeOf<BuilderRequirements<typeof builder>>().toEqualTypeOf<Requirements>()
    const _withExisting = GraphQLSchemaBuilder.empty
      .query("ready", { type: S.String, resolve: () => Effect.map(Label, ({ label }) => label) })
      .pipe(api.compose(withAmount))
    expectTypeOf<BuilderRequirements<typeof _withExisting>>().toEqualTypeOf<Requirements>()
    const operations = [api.compose(withAmount), api.compose(withLabel)]
    const _nested = GraphQLSchemaBuilder.empty.pipe(api.compose(...operations))
    expectTypeOf<BuilderRequirements<typeof _nested>>().toEqualTypeOf<Requirements>()
    const _requiresServices = () => {
      // @ts-expect-error a custom operation's decoder requirements cannot be dropped
      toRouter(builder, Layer.succeed(Label, { label: "ready" }))
      // @ts-expect-error a custom operation's resolver requirements cannot be dropped
      toRouter(builder, Layer.succeed(Offset, { offset: 10 }))
    }
    const app = HttpRouter.toWebHandler(
      toRouter(
        builder,
        Layer.merge(Layer.succeed(Offset, { offset: 10 }), Layer.succeed(Label, { label: "ready" }))
      )
    )
    try {
      const response = await app.handler(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: '{ hello ready amount(amount: "2") }' }),
        })
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        data: { hello: "world", ready: "ready", amount: 24 },
      })
    } finally {
      await app.dispose()
    }
  })

  it.each(["methods", "pipe"] as const)(
    "preserves decoded inference and services through %s registration",
    async (style) => {
      const base = GraphQLSchemaBuilder.empty
        .objectType({ name: "Box", schema: Box })
        .query("ready", { type: S.String, resolve: () => Effect.map(Label, ({ label }) => label) })
        .query("box", { type: Box, resolve: () => Effect.succeed({ id: "box" }) })
      const query =
        style === "methods"
          ? base.query("amount", {
              type: S.Number,
              args,
              resolve: ({ amount }) => Effect.succeed(amount * 2),
            })
          : base.pipe(
              api.query("amount", {
                type: S.Number,
                args,
                resolve: ({ amount }) => Effect.succeed(amount * 2),
              })
            )
      const mutation =
        style === "methods"
          ? base.mutation("amount", {
              type: S.Number,
              args,
              resolve: ({ amount }) => Effect.succeed(amount * 3),
            })
          : base.pipe(
              api.mutation("amount", {
                type: S.Number,
                args,
                resolve: ({ amount }) => Effect.succeed(amount * 3),
              })
            )
      const field =
        style === "methods"
          ? base.field("Box", "amount", {
              type: S.Number,
              args,
              resolve: (_parent, { amount }) => Effect.succeed(amount * 4),
            })
          : base.pipe(
              api.field("Box", "amount", {
                type: S.Number,
                args,
                resolve: (_parent, { amount }) => Effect.succeed(amount * 4),
              })
            )
      const subscription =
        style === "methods"
          ? base.subscription("amount", {
              type: S.Number,
              args,
              subscribe: ({ amount }) => Effect.succeed(Stream.make(amount)),
              resolve: (value, { amount }) => Effect.succeed(value + amount),
            })
          : base.pipe(
              api.subscription("amount", {
                type: S.Number,
                args,
                subscribe: ({ amount }) => Effect.succeed(Stream.make(amount)),
                resolve: (value, { amount }) => Effect.succeed(value + amount),
              })
            )
      const inline =
        style === "methods"
          ? base.objectType({
              name: "Box",
              schema: Box,
              fields: {
                amount: {
                  type: S.Number,
                  args,
                  resolve: (_parent, decoded: S.Schema.Type<typeof args>) =>
                    Effect.succeed(decoded.amount * 5),
                },
              },
            })
          : base.pipe(
              api.objectType({
                name: "Box",
                schema: Box,
                fields: {
                  amount: {
                    type: S.Number,
                    args,
                    resolve: (_parent, decoded: S.Schema.Type<typeof args>) =>
                      Effect.succeed(decoded.amount * 5),
                  },
                },
              })
            )

      expectTypeOf<BuilderRequirements<typeof query>>().toEqualTypeOf<Requirements>()
      expectTypeOf<BuilderRequirements<typeof mutation>>().toEqualTypeOf<Requirements>()
      expectTypeOf<BuilderRequirements<typeof field>>().toEqualTypeOf<Requirements>()
      expectTypeOf<BuilderRequirements<typeof subscription>>().toEqualTypeOf<Requirements>()
      expectTypeOf<BuilderRequirements<typeof inline>>().toEqualTypeOf<Requirements>()
      // A codec's requirements cannot be discarded by treating the builder as service-free.
      // @ts-expect-error argument decoding and the existing resolver both need services
      const serviceFree: GraphQLSchemaBuilder<never> = query
      void serviceFree

      expect(
        await graphql({
          schema: query.buildSchema(),
          source: '{ ready amount(amount: "2") }',
          contextValue: { services },
        })
      ).toEqual({ data: { ready: "ready", amount: 24 } })
      expect(
        await graphql({
          schema: mutation.buildSchema(),
          source: 'mutation { amount(amount: "2") }',
          contextValue: { services },
        })
      ).toEqual({ data: { amount: 36 } })
      expect(
        await graphql({
          schema: field.buildSchema(),
          source: '{ box { amount(amount: "2") } }',
          contextValue: { services },
        })
      ).toEqual({ data: { box: { amount: 48 } } })
      expect(
        await graphql({
          schema: inline.buildSchema(),
          source: '{ box { amount(amount: "2") } }',
          contextValue: { services },
        })
      ).toEqual({ data: { box: { amount: 60 } } })
      const result = await subscribe({
        schema: subscription.buildSchema(),
        document: parse('subscription { amount(amount: "2") }'),
        contextValue: makeSubscriptionContext({ services }),
      })
      if (!(Symbol.asyncIterator in result)) throw new Error("Subscription failed")
      const iterator = result[Symbol.asyncIterator]()
      expect(await iterator.next()).toEqual({ done: false, value: { data: { amount: 24 } } })
      await iterator.return?.()
    }
  )

  it.each(["methods", "pipe"] as const)(
    "unions independent inline field requirements through %s registration",
    async (style) => {
      const Existing = Context.Service<{ existing: string }>("argument-services/Existing")
      const labelArgs = S.Struct({
        text: S.String.pipe(
          S.decodeTo(S.String, {
            decode: Getter.transformEffect((value) =>
              Effect.map(Label, ({ label }) => `${label}:${value}`)
            ),
            encode: Getter.transform((value) => value),
          })
        ),
      })
      const base = GraphQLSchemaBuilder.empty
        .query("existing", {
          type: S.String,
          resolve: () => Effect.map(Existing, ({ existing }) => existing),
        })
        .query("box", { type: Box, resolve: () => Effect.succeed({ id: "box" }) })
      const resolvers =
        style === "methods"
          ? base.objectType({
              name: "Box",
              schema: Box,
              fields: {
                amount: {
                  type: S.Number,
                  resolve: (parent) => {
                    expectTypeOf(parent).toEqualTypeOf<S.Schema.Type<typeof Box>>()
                    return Effect.map(Offset, ({ offset }) => offset + parent.id.length)
                  },
                },
                label: {
                  type: S.String,
                  resolve: (parent) => Effect.map(Label, ({ label }) => `${label}:${parent.id}`),
                },
              },
            })
          : base.pipe(
              api.objectType({
                name: "Box",
                schema: Box,
                fields: {
                  amount: {
                    type: S.Number,
                    resolve: (parent) => {
                      expectTypeOf(parent).toEqualTypeOf<S.Schema.Type<typeof Box>>()
                      return Effect.map(Offset, ({ offset }) => offset + parent.id.length)
                    },
                  },
                  label: {
                    type: S.String,
                    resolve: (parent) => Effect.map(Label, ({ label }) => `${label}:${parent.id}`),
                  },
                },
              })
            )
      const decoders =
        style === "methods"
          ? base.objectType({
              name: "Box",
              schema: Box,
              fields: {
                amount: {
                  type: S.Number,
                  args,
                  resolve: (parent, decoded: S.Schema.Type<typeof args>) =>
                    Effect.succeed(decoded.amount + parent.id.length),
                },
                label: {
                  type: S.String,
                  args: labelArgs,
                  resolve: (parent, decoded: S.Schema.Type<typeof labelArgs>) =>
                    Effect.succeed(`${decoded.text}:${parent.id}`),
                },
                pure: { type: S.String, resolve: (parent) => Effect.succeed(parent.id) },
              },
            })
          : base.pipe(
              api.objectType({
                name: "Box",
                schema: Box,
                fields: {
                  amount: {
                    type: S.Number,
                    args,
                    resolve: (parent, decoded: S.Schema.Type<typeof args>) =>
                      Effect.succeed(decoded.amount + parent.id.length),
                  },
                  label: {
                    type: S.String,
                    args: labelArgs,
                    resolve: (parent, decoded: S.Schema.Type<typeof labelArgs>) =>
                      Effect.succeed(`${decoded.text}:${parent.id}`),
                  },
                  pure: { type: S.String, resolve: (parent) => Effect.succeed(parent.id) },
                },
              })
            )
      const mixed =
        style === "methods"
          ? base.objectType({
              name: "Box",
              schema: Box,
              fields: {
                label: {
                  type: S.String,
                  args,
                  resolve: (parent, decoded: S.Schema.Type<typeof args>) =>
                    Effect.map(Label, ({ label }) => `${label}:${parent.id}:${decoded.amount}`),
                },
              },
            })
          : base.pipe(
              api.objectType({
                name: "Box",
                schema: Box,
                fields: {
                  label: {
                    type: S.String,
                    args,
                    resolve: (parent, decoded: S.Schema.Type<typeof args>) =>
                      Effect.map(Label, ({ label }) => `${label}:${parent.id}:${decoded.amount}`),
                  },
                },
              })
            )
      type AllRequirements = Requirements | Context.Service.Identifier<typeof Existing>
      expectTypeOf<BuilderRequirements<typeof resolvers>>().toEqualTypeOf<AllRequirements>()
      expectTypeOf<BuilderRequirements<typeof decoders>>().toEqualTypeOf<AllRequirements>()
      expectTypeOf<BuilderRequirements<typeof mixed>>().toEqualTypeOf<AllRequirements>()
      const _missingServices = () => {
        const existingLayer = Layer.succeed(Existing, { existing: "present" })
        const decoderLayer = Layer.merge(
          Layer.succeed(Offset, { offset: 10 }),
          Layer.succeed(Label, { label: "ready" })
        )
        // @ts-expect-error the second inline resolver's Label service is required
        toRouter(resolvers, Layer.merge(existingLayer, Layer.succeed(Offset, { offset: 10 })))
        // @ts-expect-error the second inline argument decoder's Label service is required
        toRouter(decoders, Layer.merge(existingLayer, Layer.succeed(Offset, { offset: 10 })))
        // @ts-expect-error the first inline argument decoder's Offset service is required
        toRouter(decoders, Layer.merge(existingLayer, Layer.succeed(Label, { label: "ready" })))
        // @ts-expect-error existing builder requirements cannot be discarded
        toRouter(mixed, decoderLayer)
      }
      const _pure = GraphQLSchemaBuilder.empty.objectType({
        name: "PureBox",
        schema: Box,
        fields: {
          idCopy: {
            type: S.String,
            args: undefined,
            resolve: (parent) => Effect.succeed(parent.id),
          },
        },
      })
      const _empty = GraphQLSchemaBuilder.empty.pipe(
        api.objectType({ name: "EmptyBox", schema: Box, fields: {} })
      )
      expectTypeOf<BuilderRequirements<typeof _pure>>().toEqualTypeOf<never>()
      expectTypeOf<BuilderRequirements<typeof _empty>>().toEqualTypeOf<never>()
      const allServices = services.pipe(Context.add(Existing, { existing: "present" }))
      expect(
        await graphql({
          schema: resolvers.buildSchema(),
          source: "{ existing box { amount label } }",
          contextValue: { services: allServices },
        })
      ).toEqual({ data: { existing: "present", box: { amount: 13, label: "ready:box" } } })
      expect(
        await graphql({
          schema: decoders.buildSchema(),
          source: '{ box { amount(amount: "2") label(text: "hello") pure } }',
          contextValue: { services: allServices },
        })
      ).toEqual({ data: { box: { amount: 15, label: "ready:hello:box", pure: "box" } } })
      expect(
        await graphql({
          schema: mixed.buildSchema(),
          source: '{ box { label(amount: "2") } }',
          contextValue: { services: allServices },
        })
      ).toEqual({ data: { box: { label: "ready:box:12" } } })
    }
  )
})
