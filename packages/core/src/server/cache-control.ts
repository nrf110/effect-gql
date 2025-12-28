import { Effect, Config } from "effect"
import {
  DocumentNode,
  OperationDefinitionNode,
  FieldNode,
  FragmentDefinitionNode,
  SelectionSetNode,
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLNonNull,
  GraphQLList,
  GraphQLScalarType,
  GraphQLEnumType,
  Kind,
  parse,
} from "graphql"
import type { CacheHint, CacheControlScope } from "../builder/types"

// ============================================================================
// Types
// ============================================================================

/**
 * Map of type.field -> cache hint, or type -> cache hint for type-level hints
 */
export type CacheHintMap = Map<string, CacheHint>

/**
 * Computed cache policy for a GraphQL response
 */
export interface CachePolicy {
  /**
   * Maximum age in seconds the response can be cached.
   * This is the minimum maxAge of all resolved fields.
   * If 0, the response should not be cached.
   */
  readonly maxAge: number

  /**
   * Cache scope - PUBLIC means CDN-cacheable, PRIVATE means browser-only.
   * If any field is PRIVATE, the entire response is PRIVATE.
   */
  readonly scope: CacheControlScope
}

/**
 * Configuration for cache control
 */
export interface CacheControlConfig {
  /**
   * Enable cache control header calculation.
   * @default true
   */
  readonly enabled?: boolean

  /**
   * Default maxAge for root fields (Query, Mutation).
   * @default 0 (no caching)
   */
  readonly defaultMaxAge?: number

  /**
   * Default scope for fields without explicit scope.
   * @default "PUBLIC"
   */
  readonly defaultScope?: CacheControlScope

  /**
   * Whether to set HTTP Cache-Control headers on responses.
   * @default true
   */
  readonly calculateHttpHeaders?: boolean
}

/**
 * Information provided to cache policy calculation
 */
export interface CachePolicyAnalysisInfo {
  /** Parsed GraphQL document */
  readonly document: DocumentNode
  /** The operation being executed */
  readonly operation: OperationDefinitionNode
  /** The GraphQL schema */
  readonly schema: GraphQLSchema
  /** Cache hints from the builder (type.field -> hint or type -> hint) */
  readonly cacheHints: CacheHintMap
  /** Configuration options */
  readonly config: CacheControlConfig
}

// ============================================================================
// Cache Policy Computation
// ============================================================================

/**
 * Compute the cache policy for a GraphQL response based on the fields resolved.
 *
 * The policy is computed by walking the selection set and aggregating hints:
 * - maxAge: Use the minimum maxAge of all resolved fields
 * - scope: If any field is PRIVATE, the entire response is PRIVATE
 *
 * Default behaviors (matching Apollo):
 * - Root fields default to maxAge: 0 (unless configured otherwise)
 * - Object-returning fields default to maxAge: 0
 * - Scalar fields inherit their parent's maxAge
 * - Fields with inheritMaxAge: true inherit from parent
 */
export const computeCachePolicy = (
  info: CachePolicyAnalysisInfo
): Effect.Effect<CachePolicy, never, never> =>
  Effect.sync(() => {
    const fragments = new Map<string, FragmentDefinitionNode>()

    // Collect fragment definitions
    for (const definition of info.document.definitions) {
      if (definition.kind === Kind.FRAGMENT_DEFINITION) {
        fragments.set(definition.name.value, definition)
      }
    }

    // Get the root type for the operation
    const rootType = getRootType(info.schema, info.operation.operation)
    if (!rootType) {
      // No root type - return no-cache
      return { maxAge: 0, scope: "PUBLIC" as const }
    }

    const defaultMaxAge = info.config.defaultMaxAge ?? 0
    const defaultScope = info.config.defaultScope ?? "PUBLIC"

    // Analyze the selection set
    const result = analyzeSelectionSet(
      info.operation.selectionSet,
      rootType,
      info.schema,
      fragments,
      info.cacheHints,
      defaultMaxAge,
      defaultScope,
      undefined, // No parent maxAge for root
      new Set()
    )

    return result
  })

/**
 * Compute cache policy from a query string
 */
export const computeCachePolicyFromQuery = (
  query: string,
  operationName: string | undefined,
  schema: GraphQLSchema,
  cacheHints: CacheHintMap,
  config: CacheControlConfig = {}
): Effect.Effect<CachePolicy, Error, never> =>
  Effect.gen(function* () {
    // Parse the query
    const document = yield* Effect.try({
      try: () => parse(query),
      catch: (error) => new Error(`Failed to parse query: ${error}`),
    })

    // Find the operation
    const operation = yield* Effect.try({
      try: () => {
        const operations = document.definitions.filter(
          (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION
        )

        if (operations.length === 0) {
          throw new Error("No operation found in query")
        }

        if (operationName) {
          const op = operations.find((o) => o.name?.value === operationName)
          if (!op) {
            throw new Error(`Operation "${operationName}" not found`)
          }
          return op
        }

        if (operations.length > 1) {
          throw new Error("Multiple operations found - operationName required")
        }

        return operations[0]
      },
      catch: (error) => error as Error,
    })

    return yield* computeCachePolicy({
      document,
      operation,
      schema,
      cacheHints,
      config,
    })
  })

/**
 * Convert a cache policy to an HTTP Cache-Control header value
 */
export const toCacheControlHeader = (policy: CachePolicy): string => {
  if (policy.maxAge === 0) {
    return "no-store"
  }

  const directives: string[] = []
  directives.push(policy.scope === "PRIVATE" ? "private" : "public")
  directives.push(`max-age=${policy.maxAge}`)

  return directives.join(", ")
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Get the root type for an operation
 */
function getRootType(
  schema: GraphQLSchema,
  operation: "query" | "mutation" | "subscription"
): GraphQLObjectType | null {
  switch (operation) {
    case "query":
      return schema.getQueryType() ?? null
    case "mutation":
      return schema.getMutationType() ?? null
    case "subscription":
      return schema.getSubscriptionType() ?? null
  }
}

/**
 * Get the named type from a potentially wrapped type
 */
function getNamedType(
  type: GraphQLOutputType
): GraphQLObjectType | GraphQLScalarType | GraphQLEnumType | null {
  if (type instanceof GraphQLNonNull || type instanceof GraphQLList) {
    return getNamedType(type.ofType as GraphQLOutputType)
  }
  if (
    type instanceof GraphQLObjectType ||
    type instanceof GraphQLScalarType ||
    type instanceof GraphQLEnumType
  ) {
    return type
  }
  return null
}

/**
 * Check if a type is a scalar or enum (leaf type)
 */
function isLeafType(type: GraphQLOutputType): boolean {
  const namedType = getNamedType(type)
  return namedType instanceof GraphQLScalarType || namedType instanceof GraphQLEnumType
}

/**
 * Context passed through the analysis functions
 */
interface AnalysisContext {
  schema: GraphQLSchema
  fragments: Map<string, FragmentDefinitionNode>
  cacheHints: CacheHintMap
  defaultMaxAge: number
  defaultScope: CacheControlScope
}

/**
 * Mutable state for aggregating cache policies
 */
interface PolicyAccumulator {
  minMaxAge: number | undefined
  hasPrivate: boolean
}

/**
 * Aggregate a field policy into the accumulator
 */
function aggregatePolicy(acc: PolicyAccumulator, policy: CachePolicy): void {
  if (acc.minMaxAge === undefined) {
    acc.minMaxAge = policy.maxAge
  } else {
    acc.minMaxAge = Math.min(acc.minMaxAge, policy.maxAge)
  }
  if (policy.scope === "PRIVATE") {
    acc.hasPrivate = true
  }
}

/**
 * Analyze a fragment spread and return its cache policy
 */
function analyzeFragmentSpread(
  fragmentName: string,
  ctx: AnalysisContext,
  parentMaxAge: number | undefined,
  visitedFragments: Set<string>
): CachePolicy | undefined {
  // Prevent infinite loops with fragment cycles
  if (visitedFragments.has(fragmentName)) {
    return undefined
  }

  const fragment = ctx.fragments.get(fragmentName)
  if (!fragment) {
    return undefined
  }

  const fragmentType = ctx.schema.getType(fragment.typeCondition.name.value)
  if (!(fragmentType instanceof GraphQLObjectType)) {
    return undefined
  }

  const newVisited = new Set(visitedFragments)
  newVisited.add(fragmentName)

  return analyzeSelectionSet(fragment.selectionSet, fragmentType, ctx, parentMaxAge, newVisited)
}

/**
 * Analyze an inline fragment and return its cache policy
 */
function analyzeInlineFragment(
  selection: { typeCondition?: { name: { value: string } }; selectionSet: SelectionSetNode },
  parentType: GraphQLObjectType,
  ctx: AnalysisContext,
  parentMaxAge: number | undefined,
  visitedFragments: Set<string>
): CachePolicy {
  let targetType = parentType

  if (selection.typeCondition) {
    const conditionType = ctx.schema.getType(selection.typeCondition.name.value)
    if (conditionType instanceof GraphQLObjectType) {
      targetType = conditionType
    }
  }

  return analyzeSelectionSet(
    selection.selectionSet,
    targetType,
    ctx,
    parentMaxAge,
    visitedFragments
  )
}

/**
 * Look up the effective cache hint for a field (field-level > type-level > undefined)
 */
function lookupEffectiveCacheHint(
  parentTypeName: string,
  fieldName: string,
  returnType: GraphQLOutputType,
  cacheHints: CacheHintMap
): CacheHint | undefined {
  // Priority: field-level hint > type-level hint
  const fieldKey = `${parentTypeName}.${fieldName}`
  const fieldHint = cacheHints.get(fieldKey)
  if (fieldHint) return fieldHint

  // Check type-level hint on return type
  const namedType = getNamedType(returnType)
  return namedType ? cacheHints.get(namedType.name) : undefined
}

/**
 * Compute the maxAge for a field based on hint, inheritance, and field type
 */
function computeFieldMaxAge(
  hint: CacheHint | undefined,
  fieldType: GraphQLOutputType,
  parentMaxAge: number | undefined,
  defaultMaxAge: number
): number {
  if (hint) {
    // Use explicit hint
    if (hint.inheritMaxAge && parentMaxAge !== undefined) {
      return parentMaxAge
    }
    if (hint.maxAge !== undefined) {
      return hint.maxAge
    }
    // Fall through to default logic
  }

  // Scalar/enum fields inherit parent maxAge by default
  if (isLeafType(fieldType) && parentMaxAge !== undefined) {
    return parentMaxAge
  }

  // Root and object fields default to defaultMaxAge (typically 0)
  return defaultMaxAge
}

/**
 * Analyze a selection set and return the aggregated cache policy.
 * Overload with AnalysisContext for internal use.
 */
function analyzeSelectionSet(
  selectionSet: SelectionSetNode,
  parentType: GraphQLObjectType,
  ctx: AnalysisContext,
  parentMaxAge: number | undefined,
  visitedFragments: Set<string>
): CachePolicy
function analyzeSelectionSet(
  selectionSet: SelectionSetNode,
  parentType: GraphQLObjectType,
  schema: GraphQLSchema,
  fragments: Map<string, FragmentDefinitionNode>,
  cacheHints: CacheHintMap,
  defaultMaxAge: number,
  defaultScope: CacheControlScope,
  parentMaxAge: number | undefined,
  visitedFragments: Set<string>
): CachePolicy
function analyzeSelectionSet(
  selectionSet: SelectionSetNode,
  parentType: GraphQLObjectType,
  schemaOrCtx: GraphQLSchema | AnalysisContext,
  fragmentsOrParentMaxAge: Map<string, FragmentDefinitionNode> | number | undefined,
  cacheHintsOrVisited?: CacheHintMap | Set<string>,
  defaultMaxAge?: number,
  defaultScope?: CacheControlScope,
  parentMaxAge?: number | undefined,
  visitedFragments?: Set<string>
): CachePolicy {
  // Normalize arguments - support both old and new signatures
  let ctx: AnalysisContext
  let actualParentMaxAge: number | undefined
  let actualVisitedFragments: Set<string>

  if (schemaOrCtx instanceof GraphQLSchema) {
    // Old signature
    ctx = {
      schema: schemaOrCtx,
      fragments: fragmentsOrParentMaxAge as Map<string, FragmentDefinitionNode>,
      cacheHints: cacheHintsOrVisited as CacheHintMap,
      defaultMaxAge: defaultMaxAge!,
      defaultScope: defaultScope!,
    }
    actualParentMaxAge = parentMaxAge
    actualVisitedFragments = visitedFragments!
  } else {
    // New signature with AnalysisContext
    ctx = schemaOrCtx
    actualParentMaxAge = fragmentsOrParentMaxAge as number | undefined
    actualVisitedFragments = cacheHintsOrVisited as Set<string>
  }

  const acc: PolicyAccumulator = { minMaxAge: undefined, hasPrivate: false }

  for (const selection of selectionSet.selections) {
    let fieldPolicy: CachePolicy | undefined

    switch (selection.kind) {
      case Kind.FIELD:
        fieldPolicy = analyzeField(
          selection,
          parentType,
          ctx,
          actualParentMaxAge,
          actualVisitedFragments
        )
        break

      case Kind.FRAGMENT_SPREAD:
        fieldPolicy = analyzeFragmentSpread(
          selection.name.value,
          ctx,
          actualParentMaxAge,
          actualVisitedFragments
        )
        break

      case Kind.INLINE_FRAGMENT:
        fieldPolicy = analyzeInlineFragment(
          selection,
          parentType,
          ctx,
          actualParentMaxAge,
          actualVisitedFragments
        )
        break
    }

    if (fieldPolicy) {
      aggregatePolicy(acc, fieldPolicy)
    }
  }

  return {
    maxAge: acc.minMaxAge ?? ctx.defaultMaxAge,
    scope: acc.hasPrivate ? "PRIVATE" : ctx.defaultScope,
  }
}

/**
 * Analyze a field node and return its cache policy
 */
function analyzeField(
  field: FieldNode,
  parentType: GraphQLObjectType,
  ctx: AnalysisContext,
  parentMaxAge: number | undefined,
  visitedFragments: Set<string>
): CachePolicy {
  const fieldName = field.name.value

  // Introspection fields - don't affect caching
  if (fieldName.startsWith("__")) {
    return { maxAge: Infinity, scope: "PUBLIC" }
  }

  // Get the field from the schema
  const schemaField = parentType.getFields()[fieldName]
  if (!schemaField) {
    return { maxAge: ctx.defaultMaxAge, scope: ctx.defaultScope }
  }

  // Look up effective cache hint
  const effectiveHint = lookupEffectiveCacheHint(
    parentType.name,
    fieldName,
    schemaField.type,
    ctx.cacheHints
  )

  // Compute field maxAge
  const fieldMaxAge = computeFieldMaxAge(
    effectiveHint,
    schemaField.type,
    parentMaxAge,
    ctx.defaultMaxAge
  )
  const fieldScope: CacheControlScope = effectiveHint?.scope ?? ctx.defaultScope

  // If the field has a selection set, analyze it
  const namedType = getNamedType(schemaField.type)
  if (field.selectionSet && namedType instanceof GraphQLObjectType) {
    const nestedPolicy = analyzeSelectionSet(
      field.selectionSet,
      namedType,
      ctx,
      fieldMaxAge,
      visitedFragments
    )

    return {
      maxAge: Math.min(fieldMaxAge, nestedPolicy.maxAge),
      scope: fieldScope === "PRIVATE" || nestedPolicy.scope === "PRIVATE" ? "PRIVATE" : "PUBLIC",
    }
  }

  return { maxAge: fieldMaxAge, scope: fieldScope }
}

// ============================================================================
// Environment Configuration
// ============================================================================

/**
 * Effect Config for loading cache control configuration from environment variables.
 *
 * Environment variables:
 * - GRAPHQL_CACHE_CONTROL_ENABLED: Enable cache control (default: true)
 * - GRAPHQL_CACHE_CONTROL_DEFAULT_MAX_AGE: Default maxAge for root fields (default: 0)
 * - GRAPHQL_CACHE_CONTROL_DEFAULT_SCOPE: Default scope (PUBLIC or PRIVATE, default: PUBLIC)
 * - GRAPHQL_CACHE_CONTROL_HTTP_HEADERS: Set HTTP headers (default: true)
 */
export const CacheControlConfigFromEnv: Config.Config<CacheControlConfig> = Config.all({
  enabled: Config.boolean("GRAPHQL_CACHE_CONTROL_ENABLED").pipe(Config.withDefault(true)),
  defaultMaxAge: Config.number("GRAPHQL_CACHE_CONTROL_DEFAULT_MAX_AGE").pipe(Config.withDefault(0)),
  defaultScope: Config.string("GRAPHQL_CACHE_CONTROL_DEFAULT_SCOPE").pipe(
    Config.withDefault("PUBLIC"),
    Config.map((s) => (s === "PRIVATE" ? "PRIVATE" : "PUBLIC") as CacheControlScope)
  ),
  calculateHttpHeaders: Config.boolean("GRAPHQL_CACHE_CONTROL_HTTP_HEADERS").pipe(
    Config.withDefault(true)
  ),
})
