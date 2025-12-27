import { Effect, Option, Config } from "effect"
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
          (d): d is OperationDefinitionNode =>
            d.kind === Kind.OPERATION_DEFINITION
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
function isLeafType(
  type: GraphQLOutputType
): boolean {
  const namedType = getNamedType(type)
  return (
    namedType instanceof GraphQLScalarType ||
    namedType instanceof GraphQLEnumType
  )
}

/**
 * Analyze a selection set and return the aggregated cache policy
 */
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
): CachePolicy {
  let minMaxAge: number | undefined = undefined
  let hasPrivate = false

  for (const selection of selectionSet.selections) {
    let fieldPolicy: CachePolicy | undefined

    switch (selection.kind) {
      case Kind.FIELD: {
        fieldPolicy = analyzeField(
          selection,
          parentType,
          schema,
          fragments,
          cacheHints,
          defaultMaxAge,
          defaultScope,
          parentMaxAge,
          visitedFragments
        )
        break
      }

      case Kind.FRAGMENT_SPREAD: {
        const fragmentName = selection.name.value

        // Prevent infinite loops with fragment cycles
        if (visitedFragments.has(fragmentName)) {
          continue
        }

        const fragment = fragments.get(fragmentName)
        if (!fragment) {
          continue
        }

        const fragmentType = schema.getType(fragment.typeCondition.name.value)
        if (!(fragmentType instanceof GraphQLObjectType)) {
          continue
        }

        const newVisited = new Set(visitedFragments)
        newVisited.add(fragmentName)

        fieldPolicy = analyzeSelectionSet(
          fragment.selectionSet,
          fragmentType,
          schema,
          fragments,
          cacheHints,
          defaultMaxAge,
          defaultScope,
          parentMaxAge,
          newVisited
        )
        break
      }

      case Kind.INLINE_FRAGMENT: {
        let targetType = parentType

        if (selection.typeCondition) {
          const conditionType = schema.getType(
            selection.typeCondition.name.value
          )
          if (conditionType instanceof GraphQLObjectType) {
            targetType = conditionType
          }
        }

        fieldPolicy = analyzeSelectionSet(
          selection.selectionSet,
          targetType,
          schema,
          fragments,
          cacheHints,
          defaultMaxAge,
          defaultScope,
          parentMaxAge,
          visitedFragments
        )
        break
      }
    }

    if (fieldPolicy) {
      // Take minimum maxAge
      if (minMaxAge === undefined) {
        minMaxAge = fieldPolicy.maxAge
      } else {
        minMaxAge = Math.min(minMaxAge, fieldPolicy.maxAge)
      }

      // Any PRIVATE makes entire response PRIVATE
      if (fieldPolicy.scope === "PRIVATE") {
        hasPrivate = true
      }
    }
  }

  return {
    maxAge: minMaxAge ?? defaultMaxAge,
    scope: hasPrivate ? "PRIVATE" : defaultScope,
  }
}

/**
 * Analyze a field node and return its cache policy
 */
function analyzeField(
  field: FieldNode,
  parentType: GraphQLObjectType,
  schema: GraphQLSchema,
  fragments: Map<string, FragmentDefinitionNode>,
  cacheHints: CacheHintMap,
  defaultMaxAge: number,
  defaultScope: CacheControlScope,
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
    // Field not found - use defaults
    return { maxAge: defaultMaxAge, scope: defaultScope }
  }

  // Look up cache hints
  // Priority: field-level hint > type-level hint > defaults
  const fieldKey = `${parentType.name}.${fieldName}`
  const fieldHint = cacheHints.get(fieldKey)

  // Get the return type for type-level hints
  const namedType = getNamedType(schemaField.type)
  const typeHint = namedType ? cacheHints.get(namedType.name) : undefined

  // Determine the effective cache hint for this field
  const effectiveHint = fieldHint ?? typeHint

  let fieldMaxAge: number
  let fieldScope: CacheControlScope = defaultScope

  if (effectiveHint) {
    // Use explicit hint
    if (effectiveHint.inheritMaxAge && parentMaxAge !== undefined) {
      fieldMaxAge = parentMaxAge
    } else if (effectiveHint.maxAge !== undefined) {
      fieldMaxAge = effectiveHint.maxAge
    } else if (isLeafType(schemaField.type) && parentMaxAge !== undefined) {
      // Scalar/enum fields inherit parent maxAge by default
      fieldMaxAge = parentMaxAge
    } else {
      // Object fields default to 0
      fieldMaxAge = defaultMaxAge
    }

    if (effectiveHint.scope) {
      fieldScope = effectiveHint.scope
    }
  } else {
    // No explicit hint - use defaults
    if (isLeafType(schemaField.type) && parentMaxAge !== undefined) {
      // Scalar/enum fields inherit parent maxAge
      fieldMaxAge = parentMaxAge
    } else {
      // Root and object fields default to 0
      fieldMaxAge = defaultMaxAge
    }
  }

  // If the field has a selection set, analyze it
  if (field.selectionSet && namedType instanceof GraphQLObjectType) {
    const nestedPolicy = analyzeSelectionSet(
      field.selectionSet,
      namedType,
      schema,
      fragments,
      cacheHints,
      defaultMaxAge,
      defaultScope,
      fieldMaxAge, // Pass this field's maxAge as parent for inheritance
      visitedFragments
    )

    // Take minimum of this field and nested fields
    return {
      maxAge: Math.min(fieldMaxAge, nestedPolicy.maxAge),
      scope: fieldScope === "PRIVATE" || nestedPolicy.scope === "PRIVATE"
        ? "PRIVATE"
        : "PUBLIC",
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
export const CacheControlConfigFromEnv: Config.Config<CacheControlConfig> =
  Config.all({
    enabled: Config.boolean("GRAPHQL_CACHE_CONTROL_ENABLED").pipe(
      Config.withDefault(true)
    ),
    defaultMaxAge: Config.number("GRAPHQL_CACHE_CONTROL_DEFAULT_MAX_AGE").pipe(
      Config.withDefault(0)
    ),
    defaultScope: Config.string("GRAPHQL_CACHE_CONTROL_DEFAULT_SCOPE").pipe(
      Config.withDefault("PUBLIC"),
      Config.map((s) => (s === "PRIVATE" ? "PRIVATE" : "PUBLIC") as CacheControlScope)
    ),
    calculateHttpHeaders: Config.boolean("GRAPHQL_CACHE_CONTROL_HTTP_HEADERS").pipe(
      Config.withDefault(true)
    ),
  })
