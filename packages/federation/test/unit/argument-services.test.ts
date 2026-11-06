import { describe, expect, expectTypeOf, it } from "vitest"
import { Context, Effect, Stream } from "effect"
import * as S from "effect/Schema"
import * as Getter from "effect/SchemaGetter"
import { graphql, parse, subscribe } from "graphql"
import { makeSubscriptionContext } from "@effect-gql/core"
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
