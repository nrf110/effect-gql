import * as S from "effect/Schema"
import * as AST from "effect/SchemaAST"
import {
  GraphQLObjectType,
  GraphQLInterfaceType,
  GraphQLEnumType,
  GraphQLUnionType,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLFieldConfigMap,
  GraphQLInputFieldConfigMap,
  GraphQLFieldConfigArgumentMap,
  GraphQLOutputType,
  GraphQLInputType,
  GraphQLNullableType,
  isNonNullType,
} from "graphql"
import {
  toGraphQLType,
  toGraphQLInputType,
  getASTName,
  getASTView,
  getASTIdentity,
  getObjectAST,
  isNullableAST,
  isOptionDeclaration,
} from "../schema-mapping"
import type {
  TypeRegistration,
  InterfaceRegistration,
  EnumRegistration,
  UnionRegistration,
  InputTypeRegistration,
} from "./types"

export function getSchemaName(schema: S.Top): string | undefined {
  return getASTName(schema.ast)
}

export interface TypeConversionContext {
  types: Map<string, TypeRegistration>
  interfaces: Map<string, InterfaceRegistration>
  enums: Map<string, EnumRegistration>
  unions: Map<string, UnionRegistration>
  inputs: Map<string, InputTypeRegistration>
  typeRegistry: Map<string, GraphQLObjectType>
  interfaceRegistry: Map<string, GraphQLInterfaceType>
  enumRegistry: Map<string, GraphQLEnumType>
  unionRegistry: Map<string, GraphQLUnionType>
  inputRegistry: Map<string, GraphQLInputObjectType>
  schemaToTypeName?: Map<S.Top, string>
  astToTypeName?: Map<AST.AST, string>
  originalASTToTypeName?: Map<AST.AST, string>
  schemaToInterfaceName?: Map<S.Top, string>
  astToInterfaceName?: Map<AST.AST, string>
  originalASTToInterfaceName?: Map<AST.AST, string>
  schemaToInputName?: Map<S.Top, string>
  astToInputName?: Map<AST.AST, string>
  originalASTToInputName?: Map<AST.AST, string>
  enumSortedValues?: Map<string, readonly string[]>
  unionSortedTypes?: Map<string, readonly string[]>
  literalToEnumName?: Map<string, string>
  convertedOutputTypes?: WeakMap<AST.AST, GraphQLOutputType>
}

/** Keep exact registrations separate from aliases of their directional projections. */
function indexAST(
  schema: S.Top,
  name: string,
  index: Map<AST.AST, string>,
  originals: Map<AST.AST, string>,
  direction: "output" | "input"
): void {
  originals.set(getASTIdentity(schema.ast), name)
  if (schema.ast.encoding) {
    // Effect memoizes these public operations by the original AST. Encoding
    // links are copied by key-context operations, while their transformations
    // may be shared by genuinely distinct decodeTo wrappers.
    const optional = S.optionalKey(schema)
    const mutable = S.mutableKey(schema)
    for (const variant of [optional, mutable, S.mutableKey(optional), S.optionalKey(mutable)])
      originals.set(getASTIdentity(variant.ast), name)
  }
  const projected = direction === "input" ? AST.toEncoded(schema.ast) : AST.toType(schema.ast)
  let ast = getASTView(projected, direction)
  if (!index.has(getASTIdentity(ast))) index.set(getASTIdentity(ast), name)
  while (ast._tag === "Declaration" && !isOptionDeclaration(ast) && ast.typeParameters[0]) {
    ast = ast.typeParameters[0]
    if (!index.has(getASTIdentity(ast))) index.set(getASTIdentity(ast), name)
  }
}

export function buildReverseLookups(ctx: TypeConversionContext): void {
  if (!ctx.schemaToTypeName) {
    ctx.schemaToTypeName = new Map()
    ctx.astToTypeName = new Map()
    ctx.originalASTToTypeName = new Map()
    for (const [name, registration] of ctx.types) {
      ctx.schemaToTypeName.set(registration.schema, name)
      indexAST(registration.schema, name, ctx.astToTypeName, ctx.originalASTToTypeName, "output")
    }
  }
  if (!ctx.schemaToInterfaceName) {
    ctx.schemaToInterfaceName = new Map()
    ctx.astToInterfaceName = new Map()
    ctx.originalASTToInterfaceName = new Map()
    for (const [name, registration] of ctx.interfaces) {
      ctx.schemaToInterfaceName.set(registration.schema, name)
      indexAST(
        registration.schema,
        name,
        ctx.astToInterfaceName,
        ctx.originalASTToInterfaceName,
        "output"
      )
    }
  }
  if (!ctx.schemaToInputName) {
    const cache = buildInputTypeLookupCache(ctx.inputs, ctx.enums)
    ctx.schemaToInputName = cache.schemaToInputName
    ctx.astToInputName = cache.astToInputName
    ctx.originalASTToInputName = cache.originalASTToInputName
  }
  if (!ctx.enumSortedValues) {
    ctx.enumSortedValues = new Map()
    ctx.literalToEnumName = new Map()
    for (const [name, registration] of ctx.enums) {
      ctx.enumSortedValues.set(name, [...registration.values].sort())
      for (const value of registration.values) ctx.literalToEnumName.set(value, name)
    }
  }
  if (!ctx.unionSortedTypes) {
    ctx.unionSortedTypes = new Map()
    for (const [name, registration] of ctx.unions)
      ctx.unionSortedTypes.set(name, [...registration.types].sort())
  }
}

const nonNullCache = new WeakMap<GraphQLNullableType, GraphQLNonNull<GraphQLNullableType>>()
export function getNonNull<T extends GraphQLNullableType>(type: T): GraphQLNonNull<T> {
  let cached = nonNullCache.get(type)
  if (!cached) {
    cached = new GraphQLNonNull(type)
    nonNullCache.set(type, cached)
  }
  return cached as GraphQLNonNull<T>
}

function nonNullMembers(ast: AST.Union): readonly AST.AST[] {
  return ast.types.filter(
    (member) => member._tag !== "Null" && member._tag !== "Undefined" && member._tag !== "Void"
  )
}

function findEnum(
  ast: AST.AST,
  registry: Map<string, GraphQLEnumType>,
  cache: InputTypeLookupCache
): GraphQLEnumType | undefined {
  if (ast._tag === "Literal") {
    const name = cache.literalToEnumName?.get(String(ast.literal))
    return name ? registry.get(name) : undefined
  }
  if (ast._tag === "Union") {
    const members = nonNullMembers(ast)
    if (members.length === 1) return findEnum(members[0], registry, cache)
    if (members.length > 0 && members.every((member) => member._tag === "Literal")) {
      const values = members.map((member) => String((member as AST.Literal).literal)).sort()
      for (const [name, expected] of cache.enumSortedValues ?? []) {
        if (values.length === expected.length && values.every((value, i) => value === expected[i]))
          return registry.get(name)
      }
    }
  }
  return undefined
}

export function toGraphQLTypeWithRegistry(
  schema: S.Top,
  ctx: TypeConversionContext
): GraphQLOutputType {
  buildReverseLookups(ctx)
  const name = ctx.schemaToTypeName?.get(schema)
  const registered = name ? ctx.typeRegistry.get(name) : undefined
  if (registered) return registered
  const interfaceName = ctx.schemaToInterfaceName?.get(schema)
  const registeredInterface = interfaceName ? ctx.interfaceRegistry.get(interfaceName) : undefined
  if (registeredInterface) return registeredInterface
  return makeOutputConverter(ctx)(schema.ast, AST.toType(schema.ast))
}

// Traverse originals alongside one root projection: originals retain exact nested
// registrations, while projected nodes provide canonical directional cache keys.
type OutputConverter = (original: AST.AST, projected: AST.AST) => GraphQLOutputType

function makeOutputConverter(ctx: TypeConversionContext): OutputConverter {
  const converted = (ctx.convertedOutputTypes ??= new WeakMap())
  const convert: OutputConverter = (original, projected) => {
    const originalIdentity = getASTIdentity(original)
    const exactName = ctx.originalASTToTypeName?.get(originalIdentity)
    const exactType = exactName ? ctx.typeRegistry.get(exactName) : undefined
    if (exactType) return exactType
    const exactInterfaceName = ctx.originalASTToInterfaceName?.get(originalIdentity)
    const exactInterface = exactInterfaceName
      ? ctx.interfaceRegistry.get(exactInterfaceName)
      : undefined
    if (exactInterface) return exactInterface
    const source = getASTView(original, "output")
    const ast = getASTView(projected, "output")
    const identity = getASTIdentity(ast)
    const name = ctx.astToTypeName?.get(identity)
    const registered = name ? ctx.typeRegistry.get(name) : undefined
    if (registered) return registered
    const interfaceName = ctx.astToInterfaceName?.get(identity)
    const registeredInterface = interfaceName ? ctx.interfaceRegistry.get(interfaceName) : undefined
    if (registeredInterface) return registeredInterface
    const enumType = findEnum(ast, ctx.enumRegistry, ctx)
    if (enumType) return enumType
    const cached = converted.get(identity)
    if (cached) return cached
    switch (ast._tag) {
      case "Objects": {
        const type = new GraphQLObjectType({
          name: getASTName(original) ?? `Object_${Math.random().toString(36).slice(2, 11)}`,
          fields: () => outputFields(source._tag === "Objects" ? source : ast, ast, convert),
        })
        converted.set(identity, type)
        return type
      }
      case "Declaration": {
        let originalInner = source._tag === "Declaration" ? source.typeParameters[0] : undefined
        if (isOptionDeclaration(source) && source.encoding) {
          // Encoded Option constructors project their value parameter with toType.
          // Their encoding still retains the original codec (possibly nullish).
          let encoded = source.encoding[source.encoding.length - 1].to
          while (encoded._tag === "Union") {
            const members = nonNullMembers(encoded)
            if (members.length !== 1) break
            encoded = members[0]
          }
          originalInner = encoded
        }
        if (ast.typeParameters[0])
          return convert(originalInner ?? ast.typeParameters[0], ast.typeParameters[0])
        break
      }
      case "Suspend":
        return convert(source._tag === "Suspend" ? source.thunk() : ast.thunk(), ast.thunk())
      case "Arrays": {
        const element = ast.elements[0] ?? ast.rest[0]
        const originalElement =
          source._tag === "Arrays" ? (source.elements[0] ?? source.rest[0]) : undefined
        if (element) return new GraphQLList(convert(originalElement ?? element, element))
        break
      }
      case "Union": {
        const members = nonNullMembers(ast)
        const originals = source._tag === "Union" ? nonNullMembers(source) : members
        const names = members.map(
          (member, index) =>
            ctx.originalASTToTypeName?.get(getASTIdentity(originals[index] ?? member)) ??
            ctx.astToTypeName?.get(getASTIdentity(member)) ??
            getASTName(member)
        )
        if (names.every((name): name is string => name !== undefined)) {
          const sorted = names.sort()
          for (const [name, expected] of ctx.unionSortedTypes ?? []) {
            if (
              sorted.length === expected.length &&
              sorted.every((value, i) => value === expected[i])
            ) {
              const union = ctx.unionRegistry.get(name)
              if (union) return union
            }
          }
        }
        if (members[0])
          return convert(
            source._tag === "Union" ? (nonNullMembers(source)[0] ?? members[0]) : members[0],
            members[0]
          )
      }
    }
    return toGraphQLType(S.make<S.Top>(ast))
  }
  return convert
}

export function schemaToFields(
  schema: S.Top,
  ctx: TypeConversionContext
): GraphQLFieldConfigMap<unknown, unknown> {
  buildReverseLookups(ctx)
  const ast = getObjectAST(schema.ast, "output")
  const projected = getObjectAST(AST.toType(schema.ast), "output")
  return ast && projected ? outputFields(ast, projected, makeOutputConverter(ctx)) : {}
}

function outputFields(
  ast: AST.Objects,
  projected: AST.Objects,
  convert: OutputConverter
): GraphQLFieldConfigMap<unknown, unknown> {
  const fields: GraphQLFieldConfigMap<unknown, unknown> = {}
  for (const [index, field] of ast.propertySignatures.entries()) {
    if (field.name === "_tag") continue
    const type = convert(field.type, projected.propertySignatures[index].type)
    fields[String(field.name)] = {
      type: isNullableAST(field.type) || isNonNullType(type) ? type : getNonNull(type),
    }
  }
  return fields
}

export interface InputTypeLookupCache {
  schemaToInputName?: Map<S.Top, string>
  astToInputName?: Map<AST.AST, string>
  originalASTToInputName?: Map<AST.AST, string>
  literalToEnumName?: Map<string, string>
  enumSortedValues?: Map<string, readonly string[]>
  convertedInputTypes?: WeakMap<AST.AST, GraphQLInputType>
}

export function buildInputTypeLookupCache(
  inputs: Map<string, InputTypeRegistration>,
  enums: Map<string, EnumRegistration>
): InputTypeLookupCache {
  const cache: InputTypeLookupCache = {
    schemaToInputName: new Map(),
    astToInputName: new Map(),
    originalASTToInputName: new Map(),
    literalToEnumName: new Map(),
    enumSortedValues: new Map(),
  }
  for (const [name, registration] of inputs) {
    cache.schemaToInputName!.set(registration.schema, name)
    indexAST(
      registration.schema,
      name,
      cache.astToInputName!,
      cache.originalASTToInputName!,
      "input"
    )
  }
  for (const [name, registration] of enums) {
    cache.enumSortedValues!.set(name, [...registration.values].sort())
    for (const value of registration.values) cache.literalToEnumName!.set(value, name)
  }
  return cache
}

export function toGraphQLInputTypeWithRegistry(
  schema: S.Top,
  enumRegistry: Map<string, GraphQLEnumType>,
  inputRegistry: Map<string, GraphQLInputObjectType>,
  inputs: Map<string, InputTypeRegistration>,
  enums: Map<string, EnumRegistration>,
  cache: InputTypeLookupCache = buildInputTypeLookupCache(inputs, enums)
): GraphQLInputType {
  const name = cache.schemaToInputName?.get(schema)
  const registered = name ? inputRegistry.get(name) : undefined
  if (registered) return registered
  return makeInputConverter(
    enumRegistry,
    inputRegistry,
    cache
  )(schema.ast, AST.toEncoded(schema.ast))
}

type InputConverter = (original: AST.AST, projected: AST.AST) => GraphQLInputType

function makeInputConverter(
  enumRegistry: Map<string, GraphQLEnumType>,
  inputRegistry: Map<string, GraphQLInputObjectType>,
  cache: InputTypeLookupCache
): InputConverter {
  const converted = (cache.convertedInputTypes ??= new WeakMap())
  const convert: InputConverter = (original, projected) => {
    // Key codecs can wrap an exact registration before its shared projection.
    let source = original
    while (true) {
      const exactName = cache.originalASTToInputName?.get(getASTIdentity(source))
      const exactType = exactName ? inputRegistry.get(exactName) : undefined
      if (exactType) return exactType
      if (!source.encoding) break
      source = source.encoding[source.encoding.length - 1].to
    }
    if (
      isOptionDeclaration(original) &&
      original._tag === "Declaration" &&
      !original.encoding &&
      original.typeParameters[0]
    ) {
      return convert(
        original.typeParameters[0],
        projected._tag === "Declaration"
          ? (projected.typeParameters[0] ?? original.typeParameters[0])
          : projected
      )
    }
    const ast = getASTView(projected, "input")
    const identity = getASTIdentity(ast)
    const encodedName = cache.astToInputName?.get(identity)
    const registeredEncoded = encodedName ? inputRegistry.get(encodedName) : undefined
    if (registeredEncoded) return registeredEncoded
    const enumType = findEnum(ast, enumRegistry, cache)
    if (enumType) return enumType
    const cached = converted.get(identity)
    if (cached) return cached
    switch (ast._tag) {
      case "Objects": {
        const schemaName = getASTName(original)
        const type = new GraphQLInputObjectType({
          name: schemaName
            ? `${schemaName}Input`
            : `Input_${Math.random().toString(36).slice(2, 11)}`,
          fields: () => inputFields(source._tag === "Objects" ? source : ast, ast, convert),
        })
        converted.set(identity, type)
        return type
      }
      case "Suspend":
        return convert(source._tag === "Suspend" ? source.thunk() : ast.thunk(), ast.thunk())
      case "Declaration":
        if (ast.typeParameters[0])
          return convert(
            source._tag === "Declaration"
              ? (source.typeParameters[0] ?? ast.typeParameters[0])
              : ast.typeParameters[0],
            ast.typeParameters[0]
          )
        break
      case "Union": {
        const members = nonNullMembers(ast)
        // A failed whole-union match must not narrow to an enum for one member.
        if (members.length > 1) break
        const member = members[0]
        if (member)
          return convert(
            source._tag === "Union" ? (nonNullMembers(source)[0] ?? member) : member,
            member
          )
        break
      }
      case "Arrays": {
        const element = ast.elements[0] ?? ast.rest[0]
        const originalElement =
          source._tag === "Arrays" ? (source.elements[0] ?? source.rest[0]) : undefined
        if (element) return new GraphQLList(convert(originalElement ?? element, element))
      }
    }
    return toGraphQLInputType(S.make<S.Top>(ast))
  }
  return convert
}

export function schemaToInputFields(
  schema: S.Top,
  enumRegistry: Map<string, GraphQLEnumType>,
  inputRegistry: Map<string, GraphQLInputObjectType>,
  inputs: Map<string, InputTypeRegistration>,
  enums: Map<string, EnumRegistration>,
  cache: InputTypeLookupCache = buildInputTypeLookupCache(inputs, enums)
): GraphQLInputFieldConfigMap {
  const ast = getObjectAST(schema.ast, "input")
  const projected = getObjectAST(AST.toEncoded(schema.ast), "input")
  return ast && projected
    ? inputFields(ast, projected, makeInputConverter(enumRegistry, inputRegistry, cache))
    : {}
}

function inputFields(
  ast: AST.Objects,
  projected: AST.Objects,
  convert: InputConverter
): GraphQLInputFieldConfigMap {
  const fields: GraphQLInputFieldConfigMap = {}
  for (const [index, field] of ast.propertySignatures.entries()) {
    if (field.name === "_tag") continue
    const type = convert(field.type, projected.propertySignatures[index].type)
    fields[String(field.name)] = {
      type:
        isNullableAST(getASTView(field.type, "input")) || isNonNullType(type)
          ? type
          : getNonNull(type),
    }
  }
  return fields
}

export function toGraphQLArgsWithRegistry(
  schema: S.Top,
  enumRegistry: Map<string, GraphQLEnumType>,
  inputRegistry: Map<string, GraphQLInputObjectType>,
  inputs: Map<string, InputTypeRegistration>,
  enums: Map<string, EnumRegistration>,
  cache?: InputTypeLookupCache
): GraphQLFieldConfigArgumentMap {
  if (!getObjectAST(schema.ast, "input"))
    throw new Error("Schema must be an object type to convert to GraphQL arguments")
  return schemaToInputFields(schema, enumRegistry, inputRegistry, inputs, enums, cache)
}
