import { Effect, Layer, Runtime, Schema as S } from "effect"
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLFieldConfigMap,
  GraphQLFieldConfig,
} from "graphql"
import type { EffectResolver } from "./Resolver"
import { toGraphQLResolver, createValidatedResolver } from "./Resolver"
import { toGraphQLArgs } from "./SchemaMapping"
import { ValidationError } from "./Error"
import type { ObjectTypeBuilder } from "./ObjectType"

/**
 * Field definition with Effect resolver
 */
export interface EffectFieldConfig<Args, R, E, A> {
  type: any // GraphQL output type
  args?: Record<string, any>
  description?: string
  resolve: EffectResolver<Args, R, E, A>
}

/**
 * Field definition with validated arguments using Effect Schema
 */
export interface ValidatedFieldConfig<ArgsSchema extends S.Schema<any, any, any>, R, E, A> {
  type: any // GraphQL output type
  argsSchema: ArgsSchema
  description?: string
  resolve: (args: S.Schema.Type<ArgsSchema>) => Effect.Effect<A, E, R>
}

/**
 * Create a field config with validated arguments
 */
export const field = <ArgsSchema extends S.Schema<any, any, any>, R, E, A>(
  config: ValidatedFieldConfig<ArgsSchema, R, E, A>
): EffectFieldConfig<S.Schema.Type<ArgsSchema>, R, E | ValidationError, A> => {
  return {
    type: config.type,
    args: toGraphQLArgs(config.argsSchema),
    description: config.description,
    resolve: createValidatedResolver(config.argsSchema, config.resolve),
  }
}

/**
 * Schema builder that integrates Effect with GraphQL
 */
export class SchemaBuilder<R> {
  private runtime: Runtime.Runtime<R> | null = null
  private objectTypeBuilders: ObjectTypeBuilder<any, R>[] = []

  constructor(private readonly layer: Layer.Layer<R>) {}

  /**
   * Register an object type builder to receive the runtime
   */
  registerObjectType(builder: ObjectTypeBuilder<any, R>): void {
    this.objectTypeBuilders.push(builder)
  }

  /**
   * Initialize the runtime from the layer
   */
  private async initRuntime(): Promise<Runtime.Runtime<R>> {
    if (!this.runtime) {
      this.runtime = await Effect.runPromise(
        Effect.scoped(Layer.toRuntime(this.layer))
      )
      // Set runtime on all registered object type builders
      for (const builder of this.objectTypeBuilders) {
        builder.setRuntime(this.runtime)
      }
    }
    return this.runtime
  }

  /**
   * Build a GraphQL schema with Effect resolvers
   */
  async build(config: {
    query: Record<string, EffectFieldConfig<any, R, any, any>>
    mutation?: Record<string, EffectFieldConfig<any, R, any, any>>
    subscription?: Record<string, EffectFieldConfig<any, R, any, any>>
  }): Promise<GraphQLSchema> {
    const runtime = await this.initRuntime()

    const convertFields = (
      fields: Record<string, EffectFieldConfig<any, R, any, any>>
    ): GraphQLFieldConfigMap<any, any> => {
      const result: GraphQLFieldConfigMap<any, any> = {}
      
      for (const [name, field] of Object.entries(fields)) {
        result[name] = {
          type: field.type,
          args: field.args,
          description: field.description,
          resolve: toGraphQLResolver(field.resolve, runtime),
        } as GraphQLFieldConfig<any, any>
      }
      
      return result
    }

    return new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: convertFields(config.query),
      }),
      mutation: config.mutation
        ? new GraphQLObjectType({
            name: "Mutation",
            fields: convertFields(config.mutation),
          })
        : undefined,
      subscription: config.subscription
        ? new GraphQLObjectType({
            name: "Subscription",
            fields: convertFields(config.subscription),
          })
        : undefined,
    })
  }
}

/**
 * Create a schema builder with a given Effect layer
 */
export const createSchemaBuilder = <R>(
  layer: Layer.Layer<R>
): SchemaBuilder<R> => {
  return new SchemaBuilder(layer)
}
