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
  keyASTToTypeName?: Map<AST.AST, string>
  schemaToInterfaceName?: Map<S.Top, string>
  astToInterfaceName?: Map<AST.AST, string>
  originalASTToInterfaceName?: Map<AST.AST, string>
  keyASTToInterfaceName?: Map<AST.AST, string>
  schemaToInputName?: Map<S.Top, string>
  astToInputName?: Map<AST.AST, string>
  originalASTToInputName?: Map<AST.AST, string>
  keyASTToInputName?: Map<AST.AST, string>
  enumSortedValues?: Map<string, readonly string[]>
  unionSortedTypes?: Map<string, readonly string[]>
  literalToEnumName?: Map<string, string>
  convertedOutputObjects?: WeakMap<AST.AST, WeakMap<AST.AST, GraphQLObjectType>>
}

/** Index exact ASTs and generated key aliases separately from directional identities. */
function indexAST(
  schema: S.Top,
  name: string,
  index: Map<AST.AST, string>,
  originals: Map<AST.AST, string>,
  aliases: Map<AST.AST, string>,
  direction: "output" | "input"
): void {
  originals.set(schema.ast, name)
  // Effect memoizes these public key-context operations by the original AST,
  // including for schemas without an encoding. Index their exact identities
  // rather than shared encoding links or transformations.
  const optional = S.optionalKey(schema)
  const mutable = S.mutableKey(schema)
  for (const variant of [optional, mutable, S.mutableKey(optional), S.optionalKey(mutable)]) {
    if (!aliases.has(variant.ast)) aliases.set(variant.ast, name)
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
    ctx.keyASTToTypeName = new Map()
    for (const [name, registration] of ctx.types) {
      ctx.schemaToTypeName.set(registration.schema, name)
      indexAST(
        registration.schema,
        name,
        ctx.astToTypeName,
        ctx.originalASTToTypeName,
        ctx.keyASTToTypeName,
        "output"
      )
    }
  }
  if (!ctx.schemaToInterfaceName) {
    ctx.schemaToInterfaceName = new Map()
    ctx.astToInterfaceName = new Map()
    ctx.originalASTToInterfaceName = new Map()
    ctx.keyASTToInterfaceName = new Map()
    for (const [name, registration] of ctx.interfaces) {
      ctx.schemaToInterfaceName.set(registration.schema, name)
      indexAST(
        registration.schema,
        name,
        ctx.astToInterfaceName,
        ctx.originalASTToInterfaceName,
        ctx.keyASTToInterfaceName,
        "output"
      )
    }
  }
  if (!ctx.schemaToInputName) {
    const cache = buildInputTypeLookupCache(ctx.inputs, ctx.enums)
    ctx.schemaToInputName = cache.schemaToInputName
    ctx.astToInputName = cache.astToInputName
    ctx.originalASTToInputName = cache.originalASTToInputName
    ctx.keyASTToInputName = cache.keyASTToInputName
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
// registrations, so generated objects must preserve both directional identities.
type OutputConverter = (original: AST.AST, projected: AST.AST) => GraphQLOutputType

function findOutputRegistration(
  original: AST.AST,
  projected: AST.AST,
  ctx: TypeConversionContext
): GraphQLOutputType | undefined {
  const exactName = ctx.originalASTToTypeName?.get(original)
  const exactType = exactName ? ctx.typeRegistry.get(exactName) : undefined
  if (exactType) return exactType
  const exactInterfaceName = ctx.originalASTToInterfaceName?.get(original)
  const exactInterface = exactInterfaceName
    ? ctx.interfaceRegistry.get(exactInterfaceName)
    : undefined
  if (exactInterface) return exactInterface
  const aliasName = ctx.keyASTToTypeName?.get(original)
  const aliasType = aliasName ? ctx.typeRegistry.get(aliasName) : undefined
  if (aliasType) return aliasType
  const aliasInterfaceName = ctx.keyASTToInterfaceName?.get(original)
  const aliasInterface = aliasInterfaceName
    ? ctx.interfaceRegistry.get(aliasInterfaceName)
    : undefined
  if (aliasInterface) return aliasInterface
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
  if (ast._tag === "Union" && ctx.unionRegistry.size > 0) {
    const source = getASTView(original, "output")
    const members = nonNullMembers(ast)
    const originals = source._tag === "Union" ? nonNullMembers(source) : members
    const names = members.map(
      (member, index) =>
        ctx.originalASTToTypeName?.get(originals[index] ?? member) ??
        ctx.keyASTToTypeName?.get(originals[index] ?? member) ??
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
  }
}

function outputDeclarationSource(source: AST.AST): AST.AST | undefined {
  if (source._tag !== "Declaration") return undefined
  if (!isOptionDeclaration(source) || !source.encoding) return source.typeParameters[0]
  // Encoded Option constructors retain the original value codec in their encoding.
  let encoded = source.encoding[source.encoding.length - 1].to
  while (encoded._tag === "Union") {
    const members = nonNullMembers(encoded)
    if (members.length !== 1) break
    encoded = members[0]
  }
  return encoded
}

// Projection-only reuse is safe only if every reachable output resolves identically.
// Visit pairs rather than resolving fields eagerly, so recursive objects stay lazy.
function hasOutputDifferences(
  original: AST.AST,
  projected: AST.AST,
  ctx: TypeConversionContext,
  seen: WeakMap<AST.AST, WeakSet<AST.AST>>
): boolean {
  if (original === projected) return false
  const registered = findOutputRegistration(original, projected, ctx)
  const projectedRegistration = findOutputRegistration(projected, projected, ctx)
  if (registered || projectedRegistration) return registered !== projectedRegistration
  const source = getASTView(original, "output")
  const ast = getASTView(projected, "output")
  if (getASTIdentity(source) === getASTIdentity(ast)) return false
  let projections = seen.get(source)
  if (projections?.has(ast)) return false
  if (!projections) {
    projections = new WeakSet()
    seen.set(source, projections)
  }
  projections.add(ast)
  switch (ast._tag) {
    case "Objects": {
      const fields = source._tag === "Objects" ? source.propertySignatures : ast.propertySignatures
      return fields.some(
        (field, index) =>
          field.name !== "_tag" &&
          (isNullableAST(field.type) !== isNullableAST(ast.propertySignatures[index].type) ||
            hasOutputDifferences(field.type, ast.propertySignatures[index].type, ctx, seen))
      )
    }
    case "Declaration": {
      const inner = ast.typeParameters[0]
      return inner
        ? hasOutputDifferences(outputDeclarationSource(source) ?? inner, inner, ctx, seen)
        : false
    }
    case "Suspend":
      return hasOutputDifferences(
        source._tag === "Suspend" ? source.thunk() : ast.thunk(),
        ast.thunk(),
        ctx,
        seen
      )
    case "Arrays": {
      const element = ast.elements[0] ?? ast.rest[0]
      const originalElement =
        source._tag === "Arrays" ? (source.elements[0] ?? source.rest[0]) : undefined
      return element ? hasOutputDifferences(originalElement ?? element, element, ctx, seen) : false
    }
    case "Union": {
      const member = nonNullMembers(ast)[0]
      const originalMember = source._tag === "Union" ? nonNullMembers(source)[0] : undefined
      return member ? hasOutputDifferences(originalMember ?? member, member, ctx, seen) : false
    }
    default:
      return false
  }
}

function makeOutputConverter(ctx: TypeConversionContext): OutputConverter {
  const converted = (ctx.convertedOutputObjects ??= new WeakMap())
  const convert: OutputConverter = (original, projected) => {
    const registered = findOutputRegistration(original, projected, ctx)
    if (registered) return registered
    const source = getASTView(original, "output")
    const ast = getASTView(projected, "output")
    const identity = getASTIdentity(ast)
    switch (ast._tag) {
      case "Objects": {
        // Key-context copies share their source body, but a projected wrapper can
        // have different nested exact registrations despite the same projection.
        const sourceIdentity = getASTIdentity(source)
        let projectedTypes = converted.get(sourceIdentity)
        const cached = projectedTypes?.get(identity)
        if (cached) return cached
        const sharesProjection =
          sourceIdentity === identity || !hasOutputDifferences(source, ast, ctx, new WeakMap())
        const type =
          (sharesProjection ? converted.get(identity)?.get(identity) : undefined) ??
          new GraphQLObjectType({
            name: getASTName(original) ?? `Object_${Math.random().toString(36).slice(2, 11)}`,
            fields: () => outputFields(source._tag === "Objects" ? source : ast, ast, convert),
          })
        if (!projectedTypes) {
          projectedTypes = new WeakMap()
          converted.set(sourceIdentity, projectedTypes)
        }
        projectedTypes.set(identity, type)
        if (sharesProjection && sourceIdentity !== identity) {
          let projectionTypes = converted.get(identity)
          if (!projectionTypes) {
            projectionTypes = new WeakMap()
            converted.set(identity, projectionTypes)
          }
          projectionTypes.set(identity, type)
        }
        return type
      }
      case "Declaration": {
        if (ast.typeParameters[0])
          return convert(
            outputDeclarationSource(source) ?? ast.typeParameters[0],
            ast.typeParameters[0]
          )
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
  keyASTToInputName?: Map<AST.AST, string>
  literalToEnumName?: Map<string, string>
  enumSortedValues?: Map<string, readonly string[]>
  convertedInputObjects?: WeakMap<AST.AST, WeakMap<AST.AST, GraphQLInputObjectType>>
}

export function buildInputTypeLookupCache(
  inputs: Map<string, InputTypeRegistration>,
  enums: Map<string, EnumRegistration>
): InputTypeLookupCache {
  const cache: InputTypeLookupCache = {
    schemaToInputName: new Map(),
    astToInputName: new Map(),
    originalASTToInputName: new Map(),
    keyASTToInputName: new Map(),
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
      cache.keyASTToInputName!,
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

type InputConverter = (
  original: AST.AST,
  projected: AST.AST,
  allowEnum?: boolean
) => GraphQLInputType

function inputOptionValue(original: AST.AST): AST.AST | undefined {
  return isOptionDeclaration(original) && original._tag === "Declaration" && !original.encoding
    ? original.typeParameters[0]
    : undefined
}

function findInputRegistration(
  original: AST.AST,
  projected: AST.AST,
  enumRegistry: Map<string, GraphQLEnumType>,
  inputRegistry: Map<string, GraphQLInputObjectType>,
  cache: InputTypeLookupCache,
  allowEnum: boolean
): GraphQLInputType | undefined {
  // Key codecs can wrap an exact registration before its shared projection.
  let source = original
  while (true) {
    const exactName = cache.originalASTToInputName?.get(source)
    const exactType = exactName ? inputRegistry.get(exactName) : undefined
    if (exactType) return exactType
    const aliasName = cache.keyASTToInputName?.get(source)
    const aliasType = aliasName ? inputRegistry.get(aliasName) : undefined
    if (aliasType) return aliasType
    if (!source.encoding) break
    source = source.encoding[source.encoding.length - 1].to
  }
  const optionValue = inputOptionValue(original)
  if (optionValue) {
    return findInputRegistration(
      optionValue,
      projected._tag === "Declaration" ? (projected.typeParameters[0] ?? optionValue) : projected,
      enumRegistry,
      inputRegistry,
      cache,
      allowEnum
    )
  }
  const ast = getASTView(projected, "input")
  const encodedName = cache.astToInputName?.get(getASTIdentity(ast))
  const registered = encodedName ? inputRegistry.get(encodedName) : undefined
  return registered ?? (allowEnum ? findEnum(ast, enumRegistry, cache) : undefined)
}

// Match input conversion's precedence and enum fallback without resolving lazy
// fields. A pair may be revisited with enum narrowing disabled by a parent union.
function hasInputDifferences(
  original: AST.AST,
  projected: AST.AST,
  enumRegistry: Map<string, GraphQLEnumType>,
  inputRegistry: Map<string, GraphQLInputObjectType>,
  cache: InputTypeLookupCache,
  seen: WeakMap<AST.AST, WeakMap<AST.AST, number>>,
  allowEnum = true
): boolean {
  if (original === projected) return false
  const registered = findInputRegistration(
    original,
    projected,
    enumRegistry,
    inputRegistry,
    cache,
    allowEnum
  )
  const projectedRegistration = findInputRegistration(
    projected,
    projected,
    enumRegistry,
    inputRegistry,
    cache,
    allowEnum
  )
  if (registered || projectedRegistration) return registered !== projectedRegistration
  const optionValue = inputOptionValue(original)
  if (optionValue) {
    return hasInputDifferences(
      optionValue,
      projected._tag === "Declaration" ? (projected.typeParameters[0] ?? optionValue) : projected,
      enumRegistry,
      inputRegistry,
      cache,
      seen,
      allowEnum
    )
  }
  const source = getASTView(original, "input")
  const ast = getASTView(projected, "input")
  if (getASTIdentity(source) === getASTIdentity(ast)) return false
  let projections = seen.get(source)
  const mode = allowEnum ? 1 : 2
  const visited = projections?.get(ast) ?? 0
  if (visited & mode) return false
  if (!projections) {
    projections = new WeakMap()
    seen.set(source, projections)
  }
  projections.set(ast, visited | mode)
  switch (ast._tag) {
    case "Objects": {
      const fields = source._tag === "Objects" ? source.propertySignatures : ast.propertySignatures
      return fields.some(
        (field, index) =>
          field.name !== "_tag" &&
          (isNullableAST(getASTView(field.type, "input")) !==
            isNullableAST(getASTView(ast.propertySignatures[index].type, "input")) ||
            hasInputDifferences(
              field.type,
              ast.propertySignatures[index].type,
              enumRegistry,
              inputRegistry,
              cache,
              seen
            ))
      )
    }
    case "Suspend":
      return hasInputDifferences(
        source._tag === "Suspend" ? source.thunk() : ast.thunk(),
        ast.thunk(),
        enumRegistry,
        inputRegistry,
        cache,
        seen,
        allowEnum
      )
    case "Declaration": {
      const inner = ast.typeParameters[0]
      return inner
        ? hasInputDifferences(
            source._tag === "Declaration" ? (source.typeParameters[0] ?? inner) : inner,
            inner,
            enumRegistry,
            inputRegistry,
            cache,
            seen,
            allowEnum
          )
        : false
    }
    case "Union": {
      const members = nonNullMembers(ast)
      const member = members[0]
      const originalMember = source._tag === "Union" ? nonNullMembers(source)[0] : undefined
      return member
        ? hasInputDifferences(
            originalMember ?? member,
            member,
            enumRegistry,
            inputRegistry,
            cache,
            seen,
            allowEnum && members.length === 1
          )
        : false
    }
    case "Arrays": {
      const element = ast.elements[0] ?? ast.rest[0]
      const originalElement =
        source._tag === "Arrays" ? (source.elements[0] ?? source.rest[0]) : undefined
      return element
        ? hasInputDifferences(
            originalElement ?? element,
            element,
            enumRegistry,
            inputRegistry,
            cache,
            seen,
            allowEnum
          )
        : false
    }
    default:
      return false
  }
}

function makeInputConverter(
  enumRegistry: Map<string, GraphQLEnumType>,
  inputRegistry: Map<string, GraphQLInputObjectType>,
  cache: InputTypeLookupCache
): InputConverter {
  const converted = (cache.convertedInputObjects ??= new WeakMap())
  const convert: InputConverter = (original, projected, allowEnum = true) => {
    const registered = findInputRegistration(
      original,
      projected,
      enumRegistry,
      inputRegistry,
      cache,
      allowEnum
    )
    if (registered) return registered
    const optionValue = inputOptionValue(original)
    if (optionValue) {
      return convert(
        optionValue,
        projected._tag === "Declaration" ? (projected.typeParameters[0] ?? optionValue) : projected,
        allowEnum
      )
    }
    const source = getASTView(original, "input")
    const ast = getASTView(projected, "input")
    const identity = getASTIdentity(ast)
    switch (ast._tag) {
      case "Objects": {
        const sourceIdentity = getASTIdentity(source)
        let projectedTypes = converted.get(sourceIdentity)
        const cached = projectedTypes?.get(identity)
        if (cached) return cached
        const sharesProjection =
          sourceIdentity === identity ||
          !hasInputDifferences(source, ast, enumRegistry, inputRegistry, cache, new WeakMap())
        let type = sharesProjection ? converted.get(identity)?.get(identity) : undefined
        if (!type) {
          const schemaName = getASTName(original)
          type = new GraphQLInputObjectType({
            name: schemaName
              ? `${schemaName}Input`
              : `Input_${Math.random().toString(36).slice(2, 11)}`,
            fields: () => inputFields(source._tag === "Objects" ? source : ast, ast, convert),
          })
        }
        if (!projectedTypes) {
          projectedTypes = new WeakMap()
          converted.set(sourceIdentity, projectedTypes)
        }
        projectedTypes.set(identity, type)
        if (sharesProjection && sourceIdentity !== identity) {
          let projectionTypes = converted.get(identity)
          if (!projectionTypes) {
            projectionTypes = new WeakMap()
            converted.set(identity, projectionTypes)
          }
          projectionTypes.set(identity, type)
        }
        return type
      }
      case "Suspend":
        return convert(
          source._tag === "Suspend" ? source.thunk() : ast.thunk(),
          ast.thunk(),
          allowEnum
        )
      case "Declaration":
        if (ast.typeParameters[0])
          return convert(
            source._tag === "Declaration"
              ? (source.typeParameters[0] ?? ast.typeParameters[0])
              : ast.typeParameters[0],
            ast.typeParameters[0],
            allowEnum
          )
        break
      case "Union": {
        const members = nonNullMembers(ast)
        const member = members[0]
        if (member)
          return convert(
            source._tag === "Union" ? (nonNullMembers(source)[0] ?? member) : member,
            member,
            // A failed whole-union match must not narrow to an enum for one member.
            allowEnum && members.length === 1
          )
        break
      }
      case "Arrays": {
        const element = ast.elements[0] ?? ast.rest[0]
        const originalElement =
          source._tag === "Arrays" ? (source.elements[0] ?? source.rest[0]) : undefined
        if (element) return new GraphQLList(convert(originalElement ?? element, element, allowEnum))
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
