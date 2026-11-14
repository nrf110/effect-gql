import { describe, expect, expectTypeOf, it } from "vitest"
import { Context, Effect, Stream } from "effect"
import * as S from "effect/Schema"
import * as Getter from "effect/SchemaGetter"
import { graphql, parse, subscribe } from "graphql"
import {
  makeSubscriptionContext,
  type FieldRegistration,
  type ObjectFieldRegistration,
  type SubscriptionFieldRegistration,
} from "@effect-gql/core"
import { FederatedSchemaBuilder } from "../../src/federated-builder"
import * as api from "../../src/pipe-api"
type BuilderRequirements<Builder> = Builder extends FederatedSchemaBuilder<infer R> ? R : never

describe("federated argument decoding services", () => {
  const Offset = Context.Service<{ offset: number }>("federation/ArgumentOffset")
  const Label = Context.Service<{ label: string }>("federation/ArgumentLabel")
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
    "keeps explicitly typed pure registrations service-free through %s",
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
      const base = FederatedSchemaBuilder.empty
        .objectType({ name: "Box", schema: Box })
        .query("box", { type: Box, resolve: () => Effect.succeed({ id: "box" }) })
      const builder =
        style === "methods"
          ? base
              .query("hello", hello)
              .mutation("hello", hello)
              .field("Box", "idCopy", idCopy)
              .subscription("updates", updates)
          : base.pipe(
              api.query("hello", hello),
              api.mutation("hello", hello),
              api.field("Box", "idCopy", idCopy),
              api.subscription("updates", updates)
            )
      expectTypeOf<BuilderRequirements<typeof builder>>().toEqualTypeOf<never>()
      expect(
        await graphql({
          schema: builder.buildSchema(),
          source: "{ hello box { idCopy } }",
          contextValue: { services: Context.empty() },
        })
      ).toEqual({ data: { hello: "world", box: { idCopy: "box" } } })
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
      const field: ObjectFieldRegistration<
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
      const base = FederatedSchemaBuilder.empty
        .objectType({ name: "Box", schema: Box })
        .query("box", { type: Box, resolve: () => Effect.succeed({ id: "box" }) })
      const builder =
        style === "methods"
          ? base
              .query("amount", amount)
              .mutation("amount", amount)
              .field("Box", "amount", field)
              .subscription("updates", updates)
          : base.pipe(
              api.query("amount", amount),
              api.mutation("amount", amount),
              api.field("Box", "amount", field),
              api.subscription("updates", updates)
            )
      expectTypeOf<BuilderRequirements<typeof builder>>().toEqualTypeOf<DecoderServices>()
      // @ts-expect-error typed registrations cannot discard the argument decoder service
      const serviceFree: FederatedSchemaBuilder<never> = builder
      void serviceFree
      expect(
        await graphql({
          schema: builder.buildSchema(),
          source: '{ amount(amount: "2") box { amount(amount: "3") } }',
          contextValue: { services },
        })
      ).toEqual({ data: { amount: 12, box: { amount: 16 } } })
    }
  )

  it.each(["methods", "pipe"] as const)(
    "retains decoding requirements and decoded values through %s",
    async (style) => {
      const base = FederatedSchemaBuilder.empty
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

      expectTypeOf<BuilderRequirements<typeof query>>().toEqualTypeOf<Requirements>()
      expectTypeOf<BuilderRequirements<typeof mutation>>().toEqualTypeOf<Requirements>()
      expectTypeOf<BuilderRequirements<typeof field>>().toEqualTypeOf<Requirements>()
      expectTypeOf<BuilderRequirements<typeof subscription>>().toEqualTypeOf<Requirements>()
      // @ts-expect-error a federated builder must retain codec requirements
      const serviceFree: FederatedSchemaBuilder<never> = query
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
})
