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
  schemaToInterfaceName?: Map<S.Top, string>
  astToInterfaceName?: Map<AST.AST, string>
  schemaToInputName?: Map<S.Top, string>
  astToInputName?: Map<AST.AST, string>
  enumSortedValues?: Map<string, readonly string[]>
  unionSortedTypes?: Map<string, readonly string[]>
  literalToEnumName?: Map<string, string>
  convertedOutputTypes?: WeakMap<AST.AST, GraphQLOutputType>
}

/** Index only the requested representation; key optionality does not change type identity. */
function indexAST(
  original: AST.AST,
  name: string,
  index: Map<AST.AST, string>,
  direction: "output" | "input"
): void {
  const ast = getASTView(original, direction)
  index.set(getASTIdentity(ast), name)
  // Publicly projected schemas may be supplied as well; project once at registration.
  const projected = direction === "input" ? AST.toEncoded(original) : AST.toType(original)
  index.set(getASTIdentity(projected), name)
  if (ast._tag === "Declaration" && !isOptionDeclaration(ast) && ast.typeParameters[0]) {
    indexAST(ast.typeParameters[0], name, index, direction)
  }
}

export function buildReverseLookups(ctx: TypeConversionContext): void {
  if (!ctx.schemaToTypeName) {
    ctx.schemaToTypeName = new Map()
    ctx.astToTypeName = new Map()
    for (const [name, registration] of ctx.types) {
      ctx.schemaToTypeName.set(registration.schema, name)
      indexAST(registration.schema.ast, name, ctx.astToTypeName, "output")
    }
  }
  if (!ctx.schemaToInterfaceName) {
    ctx.schemaToInterfaceName = new Map()
    ctx.astToInterfaceName = new Map()
    for (const [name, registration] of ctx.interfaces) {
      ctx.schemaToInterfaceName.set(registration.schema, name)
      indexAST(registration.schema.ast, name, ctx.astToInterfaceName, "output")
    }
  }
  if (!ctx.schemaToInputName) {
    const cache = buildInputTypeLookupCache(ctx.inputs, ctx.enums)
    ctx.schemaToInputName = cache.schemaToInputName
    ctx.astToInputName = cache.astToInputName
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
  const converted = (ctx.convertedOutputTypes ??= new WeakMap())
  const convert = (original: AST.AST): GraphQLOutputType => {
    const ast = getASTView(original, "output")
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
          fields: () => schemaToFields(S.make<S.Top>(ast), ctx),
        })
        converted.set(identity, type)
        return type
      }
      case "Declaration":
        if (ast.typeParameters[0]) return convert(ast.typeParameters[0])
        break
      case "Suspend":
        return convert(ast.thunk())
      case "Arrays": {
        const element = ast.rest[0] ?? ast.elements[0]
        if (element) return new GraphQLList(convert(element))
        break
      }
      case "Union": {
        const members = nonNullMembers(ast)
        const names = members.map(
          (member) => ctx.astToTypeName?.get(getASTIdentity(member)) ?? getASTName(member)
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
        if (members[0]) return convert(members[0])
      }
    }
    return toGraphQLType(S.make<S.Top>(ast))
  }
  return convert(schema.ast)
}

export function schemaToFields(
  schema: S.Top,
  ctx: TypeConversionContext
): GraphQLFieldConfigMap<unknown, unknown> {
  const ast = getObjectAST(schema.ast, "output")
  const fields: GraphQLFieldConfigMap<unknown, unknown> = {}
  for (const field of ast?.propertySignatures ?? []) {
    if (field.name === "_tag") continue
    const type = toGraphQLTypeWithRegistry(S.make<S.Top>(field.type), ctx)
    fields[String(field.name)] = {
      type: isNullableAST(field.type) || isNonNullType(type) ? type : getNonNull(type),
    }
  }
  return fields
}

export interface InputTypeLookupCache {
  schemaToInputName?: Map<S.Top, string>
  astToInputName?: Map<AST.AST, string>
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
    literalToEnumName: new Map(),
    enumSortedValues: new Map(),
  }
  for (const [name, registration] of inputs) {
    cache.schemaToInputName!.set(registration.schema, name)
    indexAST(registration.schema.ast, name, cache.astToInputName!, "input")
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
  const converted = (cache.convertedInputTypes ??= new WeakMap())
  const convert = (original: AST.AST): GraphQLInputType => {
    if (
      isOptionDeclaration(original) &&
      original._tag === "Declaration" &&
      !original.encoding &&
      original.typeParameters[0]
    ) {
      return convert(original.typeParameters[0])
    }
    const ast = getASTView(original, "input")
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
          fields: () =>
            schemaToInputFields(
              S.make<S.Top>(ast),
              enumRegistry,
              inputRegistry,
              inputs,
              enums,
              cache
            ),
        })
        converted.set(identity, type)
        return type
      }
      case "Suspend":
        return convert(ast.thunk())
      case "Declaration":
        if (ast.typeParameters[0]) return convert(ast.typeParameters[0])
        break
      case "Union": {
        const member = nonNullMembers(ast)[0]
        if (member) return convert(member)
        break
      }
      case "Arrays": {
        const element = ast.rest[0] ?? ast.elements[0]
        if (element) return new GraphQLList(convert(element))
      }
    }
    return toGraphQLInputType(S.make<S.Top>(ast))
  }
  return convert(schema.ast)
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
  const fields: GraphQLInputFieldConfigMap = {}
  for (const field of ast?.propertySignatures ?? []) {
    if (field.name === "_tag") continue
    const type = toGraphQLInputTypeWithRegistry(
      S.make<S.Top>(field.type),
      enumRegistry,
      inputRegistry,
      inputs,
      enums,
      cache
    )
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
