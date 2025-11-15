import { Effect, Runtime, Schema as S } from "effect"
import {
  GraphQLObjectType,
  GraphQLFieldConfigMap,
  GraphQLNonNull,
  GraphQLOutputType,
  GraphQLFieldConfigArgumentMap,
} from "graphql"
import { toGraphQLType, toGraphQLArgs } from "./SchemaMapping"

/**
 * Field resolver for object types
 */
export interface ObjectFieldResolver<Parent, Args, R, E, A> {
  type: GraphQLOutputType
  args?: GraphQLFieldConfigArgumentMap
  argsSchema?: S.Schema<any, any, any>
  description?: string
  resolve: (parent: Parent, args: Args) => Effect.Effect<A, E, R>
}

/**
 * Object type builder that supports both schema fields and custom resolvers
 */
export class ObjectTypeBuilder<T, R> {
  private fields: GraphQLFieldConfigMap<any, any> = {}

  constructor(
    private readonly name: string,
    private readonly schema: S.Schema<any, any, any>,
    private runtime?: Runtime.Runtime<R>
  ) {
    // Add fields from schema
    const ast = schema.ast
    if (ast._tag === "TypeLiteral") {
      for (const field of ast.propertySignatures) {
        const fieldName = String(field.name)
        const fieldSchema = S.make(field.type)
        let fieldType = toGraphQLType(fieldSchema)

        if (!field.isOptional) {
          fieldType = new GraphQLNonNull(fieldType)
        }

        this.fields[fieldName] = { type: fieldType }
      }
    }
  }

  /**
   * Add a computed/relational field with a resolver
   */
  field<Args, E, A>(
    name: string,
    config: ObjectFieldResolver<T, Args, R, E, A>
  ): this {
    const args = config.argsSchema
      ? toGraphQLArgs(config.argsSchema)
      : config.args

    this.fields[name] = {
      type: config.type,
      args,
      description: config.description,
      resolve: (parent: T, rawArgs: Args) => {
        if (!this.runtime) {
          throw new Error("Runtime not set for object type builder")
        }

        let effect: Effect.Effect<A, E, R>

        // Validate args if schema provided
        if (config.argsSchema) {
          effect = Effect.gen(function* () {
            const validated = yield* S.decodeUnknown(config.argsSchema!)(rawArgs)
            return yield* config.resolve(parent, validated as Args)
          })
        } else {
          effect = config.resolve(parent, rawArgs)
        }

        return Runtime.runPromise(this.runtime)(effect)
      },
    }

    return this
  }

  /**
   * Set the runtime for resolvers
   */
  setRuntime(runtime: Runtime.Runtime<R>): this {
    this.runtime = runtime
    return this
  }

  /**
   * Build the GraphQL object type
   */
  build(): GraphQLObjectType {
    return new GraphQLObjectType({
      name: this.name,
      fields: this.fields,
    })
  }
}

/**
 * Create an object type builder
 */
export const objectType = <T, R = never>(
  name: string,
  schema: S.Schema<any, any, any>
): ObjectTypeBuilder<T, R> => {
  return new ObjectTypeBuilder<T, R>(name, schema)
}
