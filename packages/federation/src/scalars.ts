import { GraphQLScalarType, Kind, type ValueNode } from "@effect-gql/core"

/**
 * Parse a literal value from the AST to a JavaScript value
 */
function parseLiteralToValue(ast: ValueNode): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value
    case Kind.INT:
      return parseInt(ast.value, 10)
    case Kind.FLOAT:
      return parseFloat(ast.value)
    case Kind.NULL:
      return null
    case Kind.LIST:
      return ast.values.map(parseLiteralToValue)
    case Kind.OBJECT: {
      const obj: Record<string, unknown> = {}
      for (const field of ast.fields) {
        obj[field.name.value] = parseLiteralToValue(field.value)
      }
      return obj
    }
    default:
      return undefined
  }
}

/**
 * The _Any scalar is used for entity representations in the _entities query.
 * It accepts any JSON value representing an entity with __typename and key fields.
 */
export const AnyScalar = new GraphQLScalarType({
  name: "_Any",
  description:
    "The _Any scalar is used to pass representations of entities from external services.",
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: parseLiteralToValue,
})

/**
 * The _FieldSet scalar represents a selection of fields.
 * It's used in directive arguments like @key(fields: "id") and @requires(fields: "weight").
 */
export const FieldSetScalar = new GraphQLScalarType({
  name: "_FieldSet",
  description: "A string representing a selection of fields.",
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: (ast) => {
    if (ast.kind === Kind.STRING) {
      return ast.value
    }
    return undefined
  },
})
