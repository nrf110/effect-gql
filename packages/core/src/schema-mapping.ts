import { Effect } from "effect"
import * as S from "effect/Schema"
import * as AST from "effect/SchemaAST"
import {
  GraphQLObjectType,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLNonNull,
  GraphQLList,
  GraphQLOutputType,
  GraphQLInputObjectType,
  GraphQLInputType,
  GraphQLFieldConfigMap,
  GraphQLFieldConfigArgumentMap,
  GraphQLType,
  isNonNullType,
} from "graphql"

/** Option is a declaration in Effect 4, including schemas with an encoding link. */
export const isOptionDeclaration = (ast: AST.AST): boolean => {
  const representation = ast.annotations?.representation
  return (
    ast._tag === "Declaration" &&
    typeof representation === "object" &&
    representation !== null &&
    "id" in representation &&
    representation.id === "effect/schema/Option"
  )
}

/** Whether a field can be omitted or contain a nullish/Option value. */
export const isNullableAST = (ast: AST.AST): boolean => {
  if (AST.isOptional(ast) || isOptionDeclaration(ast)) return true
  if (ast._tag === "Null" || ast._tag === "Undefined" || ast._tag === "Void") return true
  if (ast._tag === "Union") return ast.types.some(isNullableAST)
  if (ast._tag === "Suspend") return isNullableAST(ast.thunk())
  return false
}

/** Select this node's representation without cloning its recursive child graph. */
export const getASTView = (ast: AST.AST, direction: "output" | "input"): AST.AST => {
  if (direction === "input") {
    while (ast.encoding) ast = ast.encoding[ast.encoding.length - 1].to
  }
  return ast
}

// Key-context copies retain their body references. Intern only those identities,
// never GraphQL types or helper configuration, so separate conversions stay isolated.
const astIdentities = new WeakMap<object, AST.AST[]>()

export function getASTIdentity(ast: AST.AST): AST.AST {
  const body =
    ast._tag === "Objects"
      ? ast.propertySignatures
      : ast._tag === "Declaration"
        ? ast.typeParameters
        : ast._tag === "Suspend"
          ? ast.thunk
          : undefined
  if (!body) return ast
  const identities = astIdentities.get(body)
  if (!identities) {
    astIdentities.set(body, [ast])
    return ast
  }
  const existing = identities.find((candidate) => {
    if (candidate === ast) return true
    if (candidate.annotations !== ast.annotations || candidate.checks !== ast.checks) return false
    switch (ast._tag) {
      case "Objects":
        return (
          candidate._tag === "Objects" &&
          candidate.indexSignatures === ast.indexSignatures &&
          candidate.encodingChecks === ast.encodingChecks
        )
      case "Declaration":
        return (
          candidate._tag === "Declaration" &&
          candidate.run === ast.run &&
          candidate.encodingRun === ast.encodingRun &&
          candidate.encodingChecks === ast.encodingChecks
        )
      case "Suspend":
        return candidate._tag === "Suspend"
      default:
        return false
    }
  })
  if (existing) return existing
  identities.push(ast)
  return ast
}

/** Resolve a class or suspended schema to its structural object representation. */
export function getObjectAST(ast: AST.AST, direction: "output" | "input"): AST.Objects | undefined {
  const seen = new Set<AST.AST>()
  while (!seen.has(ast)) {
    seen.add(ast)
    ast = getASTView(ast, direction)
    if (ast._tag === "Objects") return ast
    if (ast._tag === "Suspend") ast = ast.thunk()
    else if (ast._tag === "Declaration" && ast.typeParameters[0]) ast = ast.typeParameters[0]
    else return undefined
  }
  return undefined
}

/** Names are string-keyed annotations in Effect 4; tagged structs retain their discriminator. */
export function getASTName(ast: AST.AST): string | undefined {
  const identifier = ast.annotations?.identifier
  if (typeof identifier === "string") return identifier
  const object = getObjectAST(ast, "output")
  const tag = object?.propertySignatures.find((property) => property.name === "_tag")?.type
  return tag?._tag === "Literal" && typeof tag.literal === "string" ? tag.literal : undefined
}

function isIntegerCheck(check: AST.Check<unknown>): boolean {
  if (check.annotations?.representation?.id === "effect/schema/isInt") return true
  return check._tag === "FilterGroup" && check.checks.some(isIntegerCheck)
}

/** Per-conversion state shares recursive types without leaking configuration across helpers. */
type ConversionCache = WeakMap<AST.AST, GraphQLOutputType | GraphQLInputType>
function makeConverter(
  direction: "output",
  cache?: ConversionCache,
  namePrefix?: string
): (ast: AST.AST) => GraphQLOutputType
function makeConverter(
  direction: "input",
  cache?: ConversionCache,
  namePrefix?: string
): (ast: AST.AST) => GraphQLInputType
function makeConverter(
  direction: "output" | "input",
  cache: ConversionCache = new WeakMap(),
  namePrefix = ""
) {
  const convert = (original: AST.AST): GraphQLOutputType | GraphQLInputType => {
    const ast = getASTView(original, direction)
    const identity = getASTIdentity(ast)
    const cached = cache.get(identity)
    if (cached) return cached

    // Follow encoding links at each boundary, retaining original recursive graph identities.
    // Plain Option has an Option-shaped encoding, but GraphQL deliberately exposes its value.
    if (isOptionDeclaration(ast) && ast._tag === "Declaration") {
      const inner = ast.typeParameters[0]
      if (inner) return convert(inner)
    }
    switch (ast._tag) {
      case "String":
        return GraphQLString
      case "Number":
        return ast.checks?.some(isIntegerCheck) ? GraphQLInt : GraphQLFloat
      case "Boolean":
        return GraphQLBoolean
      case "Literal":
        if (typeof ast.literal === "number")
          return Number.isInteger(ast.literal) ? GraphQLInt : GraphQLFloat
        if (typeof ast.literal === "boolean") return GraphQLBoolean
        return GraphQLString
      case "Arrays": {
        const element = ast.rest[0] ?? ast.elements[0]
        return element ? new GraphQLList(convert(element) as GraphQLOutputType) : GraphQLString
      }
      case "Objects": {
        const schemaName = getASTName(ast)
        const name = schemaName
          ? `${namePrefix}${schemaName}${direction === "input" ? "Input" : ""}`
          : `${namePrefix}${direction === "input" ? "Input" : "Object"}_${Math.random().toString(36).slice(2, 11)}`
        const fields = () => buildFields(ast, convert, direction)
        const type =
          direction === "input"
            ? new GraphQLInputObjectType({
                name,
                fields: fields as () => Record<string, { type: GraphQLInputType }>,
              })
            : new GraphQLObjectType({
                name,
                fields: fields as () => GraphQLFieldConfigMap<any, any>,
              })
        cache.set(identity, type)
        return type
      }
      case "Declaration": {
        const inner = ast.typeParameters[0]
        if (inner) return convert(inner)
        break
      }
      case "Union": {
        const member = ast.types.find(
          (type) => type._tag !== "Null" && type._tag !== "Undefined" && type._tag !== "Void"
        )
        if (member) return convert(member)
        break
      }
      case "Suspend":
        return convert(ast.thunk())
    }
    return GraphQLString
  }
  return convert
}

function buildFields(
  ast: AST.Objects,
  convert: (ast: AST.AST) => GraphQLOutputType | GraphQLInputType,
  direction: "output" | "input" = "output"
): Record<string, { type: GraphQLType }> {
  const fields: Record<string, { type: GraphQLType }> = {}
  for (const field of ast.propertySignatures) {
    if (field.name === "_tag") continue
    const type = convert(field.type)
    fields[String(field.name)] = {
      type:
        isNullableAST(getASTView(field.type, direction)) || isNonNullType(type)
          ? type
          : new GraphQLNonNull(type),
    }
  }
  return fields
}

/** Convert the decoded schema representation to a GraphQL output type. */
export const toGraphQLType = (schema: S.Top): GraphQLOutputType =>
  makeConverter("output")(schema.ast)

/** Convert the encoded schema representation to a GraphQL input type. */
export const toGraphQLInputType = (schema: S.Top): GraphQLInputType =>
  makeConverter("input")(schema.ast)

/** Additional configuration for computed/relational fields. */
export interface AdditionalField<Parent, Args, R, E, A> {
  type: GraphQLOutputType
  args?: GraphQLFieldConfigArgumentMap
  description?: string
  resolve: (parent: Parent, args: Args) => Effect.Effect<A, E, R>
}

export const toGraphQLObjectType = <T>(
  name: string,
  schema: S.Top,
  additionalFields?: Record<string, AdditionalField<T, any, any, any, any>>
): GraphQLObjectType => {
  const ast = getObjectAST(schema.ast, "output")
  if (!ast) throw new Error("Schema must be an object type to convert to GraphQLObjectType")
  const cache: ConversionCache = new WeakMap()
  const convert = makeConverter("output", cache, `${name}_`)
  const type = new GraphQLObjectType({
    name,
    fields: () => {
      const fields = buildFields(ast, convert) as GraphQLFieldConfigMap<T, unknown>
      for (const [fieldName, config] of Object.entries(additionalFields ?? {})) {
        fields[fieldName] = {
          type: config.type,
          args: config.args,
          description: config.description,
          resolve: config.resolve,
        }
      }
      return fields
    },
  })
  cache.set(getASTIdentity(schema.ast), type)
  cache.set(getASTIdentity(ast), type)
  return type
}

export const toGraphQLArgs = (schema: S.Top): GraphQLFieldConfigArgumentMap => {
  const ast = getObjectAST(schema.ast, "input")
  if (!ast) throw new Error("Schema must be an object type to convert to GraphQL arguments")
  return buildFields(ast, makeConverter("input"), "input") as GraphQLFieldConfigArgumentMap
}
