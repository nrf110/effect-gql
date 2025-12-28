import { Effect, Runtime } from "effect"
import { GraphQLObjectType, GraphQLUnionType, GraphQLString } from "@effect-gql/core"
import type { EntityRegistration, EntityRepresentation } from "./types"

/**
 * Create the _Entity union type from registered entities
 */
export function createEntityUnion(
  entities: Map<string, EntityRegistration<any, any>>,
  typeRegistry: Map<string, GraphQLObjectType>
): GraphQLUnionType {
  const types = Array.from(entities.keys())
    .map((name) => typeRegistry.get(name)!)
    .filter(Boolean)

  if (types.length === 0) {
    throw new Error("At least one entity must be registered to create _Entity union")
  }

  return new GraphQLUnionType({
    name: "_Entity",
    description: "Union of all types that have @key directives",
    types: () => types,
    resolveType: (value: any) => value.__typename,
  })
}

/**
 * Create the _entities resolver
 *
 * This resolver receives an array of representations (objects with __typename and key fields)
 * and returns the corresponding entities by calling each entity's resolveReference function.
 *
 * Uses Effect.all with unbounded concurrency to resolve all entities in parallel.
 */
export function createEntitiesResolver<R>(entities: Map<string, EntityRegistration<any, R>>) {
  return async (
    _parent: any,
    args: { representations: readonly EntityRepresentation[] },
    context: { runtime: Runtime.Runtime<R> }
  ): Promise<(any | null)[]> => {
    const effects = args.representations.map((representation) => {
      const entityName = representation.__typename
      const entity = entities.get(entityName)

      if (!entity) {
        return Effect.fail(new Error(`Unknown entity type: ${entityName}`))
      }

      return entity.resolveReference(representation as any).pipe(
        Effect.map((result) => {
          // Add __typename to the result for union type resolution
          if (result !== null && typeof result === "object") {
            return { ...result, __typename: entityName }
          }
          return result
        }),
        // Catch individual entity resolution errors and return null
        Effect.catchAll((error) =>
          Effect.logError(`Failed to resolve entity ${entityName}`, error).pipe(Effect.as(null))
        )
      )
    })

    return Runtime.runPromise(context.runtime)(Effect.all(effects, { concurrency: "unbounded" }))
  }
}

/**
 * Create the _Service type for SDL introspection
 */
export function createServiceType(): GraphQLObjectType {
  return new GraphQLObjectType({
    name: "_Service",
    description: "Provides SDL for the subgraph schema",
    fields: {
      sdl: {
        type: GraphQLString,
        description: "The SDL representing the subgraph schema",
      },
    },
  })
}

/**
 * Create the _service resolver
 */
export function createServiceResolver(sdl: string) {
  return () => ({ sdl })
}
