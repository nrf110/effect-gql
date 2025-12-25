import { Effect, Option, Config, Data } from "effect"
import {
  DocumentNode,
  OperationDefinitionNode,
  FieldNode,
  FragmentDefinitionNode,
  FragmentSpreadNode,
  InlineFragmentNode,
  SelectionSetNode,
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLField,
  GraphQLOutputType,
  GraphQLNonNull,
  GraphQLList,
  Kind,
  parse,
} from "graphql"

// ============================================================================
// Errors
// ============================================================================

/**
 * Error thrown when query complexity exceeds configured limits
 */
export class ComplexityLimitExceededError extends Data.TaggedError(
  "ComplexityLimitExceededError"
)<{
  readonly message: string
  readonly limit: number
  readonly actual: number
  readonly limitType: "depth" | "complexity" | "aliases" | "fields"
}> {}

/**
 * Error thrown when complexity analysis fails
 */
export class ComplexityAnalysisError extends Data.TaggedError(
  "ComplexityAnalysisError"
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

// ============================================================================
// Types
// ============================================================================

/**
 * Result of complexity analysis for a GraphQL operation
 */
export interface ComplexityResult {
  /** Maximum depth of the query */
  readonly depth: number
  /** Total complexity score */
  readonly complexity: number
  /** Number of field selections (including nested) */
  readonly fieldCount: number
  /** Number of aliased fields */
  readonly aliasCount: number
}

/**
 * Information provided to complexity calculators
 */
export interface ComplexityAnalysisInfo {
  /** Parsed GraphQL document */
  readonly document: DocumentNode
  /** The operation being executed */
  readonly operation: OperationDefinitionNode
  /** Variables provided with the query */
  readonly variables?: Record<string, unknown>
  /** The GraphQL schema */
  readonly schema: GraphQLSchema
  /** Field complexity definitions from the builder */
  readonly fieldComplexities: FieldComplexityMap
}

/**
 * Information provided when complexity limit is exceeded
 */
export interface ComplexityExceededInfo {
  /** The computed complexity result */
  readonly result: ComplexityResult
  /** Which limit was exceeded */
  readonly exceededLimit: "depth" | "complexity" | "aliases" | "fields"
  /** The limit value */
  readonly limit: number
  /** The actual value */
  readonly actual: number
  /** The query that exceeded limits */
  readonly query: string
  /** Operation name if provided */
  readonly operationName?: string
}

/**
 * Complexity value for a field - can be static or dynamic based on arguments
 */
export type FieldComplexity =
  | number
  | ((args: Record<string, unknown>) => number)

/**
 * Map of type.field -> complexity
 */
export type FieldComplexityMap = Map<string, FieldComplexity>

/**
 * Custom complexity calculator function.
 * Must be self-contained (no service requirements).
 */
export type ComplexityCalculator = (
  info: ComplexityAnalysisInfo
) => Effect.Effect<ComplexityResult, ComplexityAnalysisError, never>

/**
 * Configuration for query complexity limiting
 */
export interface ComplexityConfig {
  /**
   * Maximum allowed query depth.
   * Depth is the deepest nesting level in the query.
   * @example
   * // Depth 3:
   * // { user { posts { comments { text } } } }
   */
  readonly maxDepth?: number

  /**
   * Maximum allowed total complexity score.
   * Complexity is calculated by summing field costs.
   */
  readonly maxComplexity?: number

  /**
   * Maximum number of field aliases allowed.
   * Prevents response explosion attacks via aliases.
   */
  readonly maxAliases?: number

  /**
   * Maximum total number of fields in the query.
   * Includes all nested field selections.
   */
  readonly maxFields?: number

  /**
   * Default complexity cost for fields without explicit costs.
   * @default 1
   */
  readonly defaultFieldComplexity?: number

  /**
   * Custom complexity calculator.
   * If provided, this is used instead of the default calculator.
   * Can be used to implement custom cost algorithms.
   */
  readonly calculator?: ComplexityCalculator

  /**
   * Hook called when a limit is exceeded.
   * Useful for logging, metrics, or custom handling.
   * This is called BEFORE the error is thrown.
   * Must be self-contained (no service requirements).
   */
  readonly onExceeded?: (
    info: ComplexityExceededInfo
  ) => Effect.Effect<void, never, never>
}

// ============================================================================
// Default Calculator
// ============================================================================

/**
 * Default complexity calculator that walks the AST and computes:
 * - depth: Maximum nesting level
 * - complexity: Sum of field costs
 * - fieldCount: Total number of field selections
 * - aliasCount: Number of aliased fields
 */
export const defaultComplexityCalculator = (
  defaultCost: number = 1
): ComplexityCalculator => {
  return (info: ComplexityAnalysisInfo) =>
    Effect.try({
      try: () => {
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
          throw new Error(
            `No root type found for operation: ${info.operation.operation}`
          )
        }

        // Analyze the selection set
        const result = analyzeSelectionSet(
          info.operation.selectionSet,
          rootType,
          info.schema,
          fragments,
          info.fieldComplexities,
          info.variables ?? {},
          defaultCost,
          1, // Starting depth
          new Set() // Visited fragments to prevent infinite loops
        )

        return result
      },
      catch: (error) =>
        new ComplexityAnalysisError({
          message: `Failed to analyze query complexity: ${error}`,
          cause: error,
        }),
    })
}

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
function getNamedType(type: GraphQLOutputType): GraphQLObjectType | null {
  if (type instanceof GraphQLNonNull || type instanceof GraphQLList) {
    return getNamedType(type.ofType as GraphQLOutputType)
  }
  if (type instanceof GraphQLObjectType) {
    return type
  }
  return null
}

/**
 * Analyze a selection set and return complexity metrics
 */
function analyzeSelectionSet(
  selectionSet: SelectionSetNode,
  parentType: GraphQLObjectType,
  schema: GraphQLSchema,
  fragments: Map<string, FragmentDefinitionNode>,
  fieldComplexities: FieldComplexityMap,
  variables: Record<string, unknown>,
  defaultCost: number,
  currentDepth: number,
  visitedFragments: Set<string>
): ComplexityResult {
  let maxDepth = currentDepth
  let complexity = 0
  let fieldCount = 0
  let aliasCount = 0

  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD: {
        const fieldResult = analyzeField(
          selection,
          parentType,
          schema,
          fragments,
          fieldComplexities,
          variables,
          defaultCost,
          currentDepth,
          visitedFragments
        )
        maxDepth = Math.max(maxDepth, fieldResult.depth)
        complexity += fieldResult.complexity
        fieldCount += fieldResult.fieldCount
        aliasCount += fieldResult.aliasCount
        break
      }

      case Kind.FRAGMENT_SPREAD: {
        const fragmentResult = analyzeFragmentSpread(
          selection,
          parentType,
          schema,
          fragments,
          fieldComplexities,
          variables,
          defaultCost,
          currentDepth,
          visitedFragments
        )
        maxDepth = Math.max(maxDepth, fragmentResult.depth)
        complexity += fragmentResult.complexity
        fieldCount += fragmentResult.fieldCount
        aliasCount += fragmentResult.aliasCount
        break
      }

      case Kind.INLINE_FRAGMENT: {
        const inlineResult = analyzeInlineFragment(
          selection,
          parentType,
          schema,
          fragments,
          fieldComplexities,
          variables,
          defaultCost,
          currentDepth,
          visitedFragments
        )
        maxDepth = Math.max(maxDepth, inlineResult.depth)
        complexity += inlineResult.complexity
        fieldCount += inlineResult.fieldCount
        aliasCount += inlineResult.aliasCount
        break
      }
    }
  }

  return { depth: maxDepth, complexity, fieldCount, aliasCount }
}

/**
 * Analyze a field node
 */
function analyzeField(
  field: FieldNode,
  parentType: GraphQLObjectType,
  schema: GraphQLSchema,
  fragments: Map<string, FragmentDefinitionNode>,
  fieldComplexities: FieldComplexityMap,
  variables: Record<string, unknown>,
  defaultCost: number,
  currentDepth: number,
  visitedFragments: Set<string>
): ComplexityResult {
  const fieldName = field.name.value
  const aliasCount = field.alias ? 1 : 0

  // Introspection fields
  if (fieldName.startsWith("__")) {
    return { depth: currentDepth, complexity: 0, fieldCount: 1, aliasCount }
  }

  // Get the field from the schema
  const schemaField = parentType.getFields()[fieldName]
  if (!schemaField) {
    // Field not found - skip (will be caught by validation)
    return { depth: currentDepth, complexity: defaultCost, fieldCount: 1, aliasCount }
  }

  // Calculate field arguments
  const args = resolveFieldArguments(field, variables)

  // Get field complexity
  const complexityKey = `${parentType.name}.${fieldName}`
  const fieldComplexity = fieldComplexities.get(complexityKey)
  let cost: number
  if (fieldComplexity !== undefined) {
    cost = typeof fieldComplexity === "function"
      ? fieldComplexity(args)
      : fieldComplexity
  } else {
    cost = defaultCost
  }

  // If the field has a selection set, analyze it
  if (field.selectionSet) {
    const fieldType = getNamedType(schemaField.type)
    if (fieldType) {
      const nestedResult = analyzeSelectionSet(
        field.selectionSet,
        fieldType,
        schema,
        fragments,
        fieldComplexities,
        variables,
        defaultCost,
        currentDepth + 1,
        visitedFragments
      )
      return {
        depth: nestedResult.depth,
        complexity: cost + nestedResult.complexity,
        fieldCount: 1 + nestedResult.fieldCount,
        aliasCount: aliasCount + nestedResult.aliasCount,
      }
    }
  }

  return { depth: currentDepth, complexity: cost, fieldCount: 1, aliasCount }
}

/**
 * Analyze a fragment spread
 */
function analyzeFragmentSpread(
  spread: FragmentSpreadNode,
  _parentType: GraphQLObjectType,
  schema: GraphQLSchema,
  fragments: Map<string, FragmentDefinitionNode>,
  fieldComplexities: FieldComplexityMap,
  variables: Record<string, unknown>,
  defaultCost: number,
  currentDepth: number,
  visitedFragments: Set<string>
): ComplexityResult {
  const fragmentName = spread.name.value

  // Prevent infinite loops with fragment cycles
  if (visitedFragments.has(fragmentName)) {
    return { depth: currentDepth, complexity: 0, fieldCount: 0, aliasCount: 0 }
  }

  const fragment = fragments.get(fragmentName)
  if (!fragment) {
    return { depth: currentDepth, complexity: 0, fieldCount: 0, aliasCount: 0 }
  }

  const fragmentType = schema.getType(fragment.typeCondition.name.value)
  if (!(fragmentType instanceof GraphQLObjectType)) {
    return { depth: currentDepth, complexity: 0, fieldCount: 0, aliasCount: 0 }
  }

  const newVisited = new Set(visitedFragments)
  newVisited.add(fragmentName)

  return analyzeSelectionSet(
    fragment.selectionSet,
    fragmentType,
    schema,
    fragments,
    fieldComplexities,
    variables,
    defaultCost,
    currentDepth,
    newVisited
  )
}

/**
 * Analyze an inline fragment
 */
function analyzeInlineFragment(
  fragment: InlineFragmentNode,
  parentType: GraphQLObjectType,
  schema: GraphQLSchema,
  fragments: Map<string, FragmentDefinitionNode>,
  fieldComplexities: FieldComplexityMap,
  variables: Record<string, unknown>,
  defaultCost: number,
  currentDepth: number,
  visitedFragments: Set<string>
): ComplexityResult {
  let targetType = parentType

  if (fragment.typeCondition) {
    const conditionType = schema.getType(fragment.typeCondition.name.value)
    if (conditionType instanceof GraphQLObjectType) {
      targetType = conditionType
    }
  }

  return analyzeSelectionSet(
    fragment.selectionSet,
    targetType,
    schema,
    fragments,
    fieldComplexities,
    variables,
    defaultCost,
    currentDepth,
    visitedFragments
  )
}

/**
 * Resolve field arguments, substituting variables
 */
function resolveFieldArguments(
  field: FieldNode,
  variables: Record<string, unknown>
): Record<string, unknown> {
  const args: Record<string, unknown> = {}

  if (!field.arguments) {
    return args
  }

  for (const arg of field.arguments) {
    const value = arg.value
    switch (value.kind) {
      case Kind.VARIABLE:
        args[arg.name.value] = variables[value.name.value]
        break
      case Kind.INT:
        args[arg.name.value] = parseInt(value.value, 10)
        break
      case Kind.FLOAT:
        args[arg.name.value] = parseFloat(value.value)
        break
      case Kind.STRING:
        args[arg.name.value] = value.value
        break
      case Kind.BOOLEAN:
        args[arg.name.value] = value.value
        break
      case Kind.NULL:
        args[arg.name.value] = null
        break
      case Kind.ENUM:
        args[arg.name.value] = value.value
        break
      case Kind.LIST:
        // Simplified - just use empty array for complexity calculation
        args[arg.name.value] = []
        break
      case Kind.OBJECT:
        // Simplified - just use empty object for complexity calculation
        args[arg.name.value] = {}
        break
    }
  }

  return args
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate query complexity against configured limits.
 * Returns the complexity result if within limits, or fails with ComplexityLimitExceededError.
 */
export const validateComplexity = (
  query: string,
  operationName: string | undefined,
  variables: Record<string, unknown> | undefined,
  schema: GraphQLSchema,
  fieldComplexities: FieldComplexityMap,
  config: ComplexityConfig
): Effect.Effect<
  ComplexityResult,
  ComplexityLimitExceededError | ComplexityAnalysisError,
  never
> =>
  Effect.gen(function* () {
    // Parse the query
    const document = yield* Effect.try({
      try: () => parse(query),
      catch: (error) =>
        new ComplexityAnalysisError({
          message: `Failed to parse query: ${error}`,
          cause: error,
        }),
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
          const op = operations.find(
            (o) => o.name?.value === operationName
          )
          if (!op) {
            throw new Error(`Operation "${operationName}" not found`)
          }
          return op
        }

        if (operations.length > 1) {
          throw new Error(
            "Multiple operations found - operationName required"
          )
        }

        return operations[0]
      },
      catch: (error) =>
        new ComplexityAnalysisError({
          message: String(error),
          cause: error,
        }),
    })

    // Calculate complexity
    const calculator =
      config.calculator ??
      defaultComplexityCalculator(config.defaultFieldComplexity ?? 1)

    const result = yield* calculator({
      document,
      operation,
      variables,
      schema,
      fieldComplexities,
    })

    // Check limits
    const checkLimit = (
      limitType: "depth" | "complexity" | "aliases" | "fields",
      limit: number | undefined,
      actual: number
    ) =>
      Effect.gen(function* () {
        if (limit !== undefined && actual > limit) {
          const exceededInfo: ComplexityExceededInfo = {
            result,
            exceededLimit: limitType,
            limit,
            actual,
            query,
            operationName,
          }

          // Call onExceeded hook if provided
          if (config.onExceeded) {
            yield* config.onExceeded(exceededInfo)
          }

          yield* Effect.fail(
            new ComplexityLimitExceededError({
              message: `Query ${limitType} of ${actual} exceeds maximum allowed ${limitType} of ${limit}`,
              limit,
              actual,
              limitType,
            })
          )
        }
      })

    yield* checkLimit("depth", config.maxDepth, result.depth)
    yield* checkLimit("complexity", config.maxComplexity, result.complexity)
    yield* checkLimit("aliases", config.maxAliases, result.aliasCount)
    yield* checkLimit("fields", config.maxFields, result.fieldCount)

    return result
  })

// ============================================================================
// Environment Configuration
// ============================================================================

/**
 * Effect Config for loading complexity configuration from environment variables.
 *
 * Environment variables:
 * - GRAPHQL_MAX_DEPTH: Maximum query depth
 * - GRAPHQL_MAX_COMPLEXITY: Maximum complexity score
 * - GRAPHQL_MAX_ALIASES: Maximum number of aliases
 * - GRAPHQL_MAX_FIELDS: Maximum number of fields
 * - GRAPHQL_DEFAULT_FIELD_COMPLEXITY: Default field complexity (default: 1)
 */
export const ComplexityConfigFromEnv: Config.Config<ComplexityConfig> =
  Config.all({
    maxDepth: Config.number("GRAPHQL_MAX_DEPTH").pipe(Config.option),
    maxComplexity: Config.number("GRAPHQL_MAX_COMPLEXITY").pipe(Config.option),
    maxAliases: Config.number("GRAPHQL_MAX_ALIASES").pipe(Config.option),
    maxFields: Config.number("GRAPHQL_MAX_FIELDS").pipe(Config.option),
    defaultFieldComplexity: Config.number("GRAPHQL_DEFAULT_FIELD_COMPLEXITY").pipe(
      Config.withDefault(1)
    ),
  }).pipe(
    Config.map(({ maxDepth, maxComplexity, maxAliases, maxFields, defaultFieldComplexity }) => ({
      maxDepth: Option.getOrUndefined(maxDepth),
      maxComplexity: Option.getOrUndefined(maxComplexity),
      maxAliases: Option.getOrUndefined(maxAliases),
      maxFields: Option.getOrUndefined(maxFields),
      defaultFieldComplexity,
    }))
  )

// ============================================================================
// Utility Calculators
// ============================================================================

/**
 * A simple depth-only calculator that only tracks query depth.
 * Use this when you only care about depth limiting and want fast validation.
 */
export const depthOnlyCalculator: ComplexityCalculator = (info) =>
  Effect.try({
    try: () => {
      const fragments = new Map<string, FragmentDefinitionNode>()
      for (const definition of info.document.definitions) {
        if (definition.kind === Kind.FRAGMENT_DEFINITION) {
          fragments.set(definition.name.value, definition)
        }
      }

      const depth = calculateMaxDepth(
        info.operation.selectionSet,
        fragments,
        1,
        new Set()
      )

      return {
        depth,
        complexity: 0,
        fieldCount: 0,
        aliasCount: 0,
      }
    },
    catch: (error) =>
      new ComplexityAnalysisError({
        message: `Failed to analyze query depth: ${error}`,
        cause: error,
      }),
  })

function calculateMaxDepth(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  currentDepth: number,
  visitedFragments: Set<string>
): number {
  let maxDepth = currentDepth

  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD:
        if (selection.selectionSet) {
          const nestedDepth = calculateMaxDepth(
            selection.selectionSet,
            fragments,
            currentDepth + 1,
            visitedFragments
          )
          maxDepth = Math.max(maxDepth, nestedDepth)
        }
        break

      case Kind.FRAGMENT_SPREAD: {
        const fragmentName = selection.name.value
        if (!visitedFragments.has(fragmentName)) {
          const fragment = fragments.get(fragmentName)
          if (fragment) {
            const newVisited = new Set(visitedFragments)
            newVisited.add(fragmentName)
            const fragmentDepth = calculateMaxDepth(
              fragment.selectionSet,
              fragments,
              currentDepth,
              newVisited
            )
            maxDepth = Math.max(maxDepth, fragmentDepth)
          }
        }
        break
      }

      case Kind.INLINE_FRAGMENT:
        const inlineDepth = calculateMaxDepth(
          selection.selectionSet,
          fragments,
          currentDepth,
          visitedFragments
        )
        maxDepth = Math.max(maxDepth, inlineDepth)
        break
    }
  }

  return maxDepth
}

/**
 * Combine multiple calculators - returns the maximum values from all calculators.
 */
export const combineCalculators = (
  ...calculators: ComplexityCalculator[]
): ComplexityCalculator => {
  return (info) =>
    Effect.gen(function* () {
      let maxDepth = 0
      let maxComplexity = 0
      let maxFieldCount = 0
      let maxAliasCount = 0

      for (const calculator of calculators) {
        const result = yield* calculator(info)
        maxDepth = Math.max(maxDepth, result.depth)
        maxComplexity = Math.max(maxComplexity, result.complexity)
        maxFieldCount = Math.max(maxFieldCount, result.fieldCount)
        maxAliasCount = Math.max(maxAliasCount, result.aliasCount)
      }

      return {
        depth: maxDepth,
        complexity: maxComplexity,
        fieldCount: maxFieldCount,
        aliasCount: maxAliasCount,
      }
    })
}
