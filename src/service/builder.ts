import { Effect, Context, Schema } from "effect"
import * as HttpLayerRouter from "@effect/platform/HttpLayerRouter"
import { GraphQLSchema } from "graphql"

export const TypeId: unique symbol = Symbol.for("effect-graphql/GraphQLSchemaBuilder")

export type TypeId = typeof TypeId

export interface GraphQLSchemaBuilder {
    readonly [TypeId]: TypeId

    addInterface: <T extends Schema.Struct.Fields>(
        schema: T,
    )
}

export const GraphQLSchemaBuilder: Context.Tag<GraphQLSchemaBuilder, GraphQLSchemaBuilder> = Context.GenericTag<GraphQLSchemaBuilder>(
    "effect-graphql/GraphQLSchemaBuilder"
)

export const make = Effect.gen(function*() {

})