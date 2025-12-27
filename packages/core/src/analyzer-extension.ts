import { Effect } from "effect"
import { Kind, type OperationDefinitionNode } from "graphql"
import type { GraphQLExtension, ExecutionArgs } from "./extensions"
import { ExtensionsService } from "./extensions"
import {
  defaultComplexityCalculator,
  type ComplexityResult,
  type FieldComplexityMap,
} from "./server/complexity"

/**
 * Configuration for the analyzer extension
 */
export interface AnalyzerExtensionConfig {
  /**
   * Include the total complexity score in the response.
   * @default true
   */
  readonly includeComplexity?: boolean

  /**
   * Include the maximum query depth in the response.
   * @default true
   */
  readonly includeDepth?: boolean

  /**
   * Include the total field count in the response.
   * @default false
   */
  readonly includeFieldCount?: boolean

  /**
   * Include the alias count in the response.
   * @default false
   */
  readonly includeAliasCount?: boolean

  /**
   * The key to use in the response extensions object.
   * @default "analyzer"
   */
  readonly key?: string

  /**
   * Thresholds for logging warnings when exceeded.
   * When a metric exceeds its threshold, a warning is logged.
   */
  readonly thresholds?: {
    readonly depth?: number
    readonly complexity?: number
    readonly fieldCount?: number
    readonly aliasCount?: number
  }

  /**
   * Default complexity cost for fields without explicit costs.
   * @default 1
   */
  readonly defaultFieldComplexity?: number

  /**
   * Optional field complexity overrides.
   * If not provided, uses the field complexities from the schema builder
   * (passed via ExecutionArgs).
   */
  readonly fieldComplexities?: FieldComplexityMap
}

/**
 * Output format for analyzer extension
 */
export interface AnalyzerOutput {
  complexity?: number
  depth?: number
  fieldCount?: number
  aliasCount?: number
}

/**
 * Create an analyzer extension that reports query complexity metrics
 * in the response extensions field.
 *
 * Similar to async-graphql's Analyzer extension, this allows you to
 * monitor the complexity of incoming queries without blocking execution.
 *
 * @example
 * ```typescript
 * // Basic usage - reports complexity and depth
 * const analyzer = createAnalyzerExtension()
 *
 * // With all metrics and warnings
 * const analyzer = createAnalyzerExtension({
 *   includeFieldCount: true,
 *   includeAliasCount: true,
 *   thresholds: {
 *     depth: 10,
 *     complexity: 100,
 *   },
 * })
 *
 * // Add to schema builder
 * const builder = GraphQLSchemaBuilder.empty.pipe(
 *   extension(analyzer),
 *   // ...queries, mutations, etc.
 * )
 *
 * // Response will include:
 * // {
 * //   "data": { ... },
 * //   "extensions": {
 * //     "analyzer": {
 * //       "complexity": 42,
 * //       "depth": 3
 * //     }
 * //   }
 * // }
 * ```
 */
export const createAnalyzerExtension = (
  config: AnalyzerExtensionConfig = {}
): GraphQLExtension<ExtensionsService> => {
  const {
    includeComplexity = true,
    includeDepth = true,
    includeFieldCount = false,
    includeAliasCount = false,
    key = "analyzer",
    thresholds,
    defaultFieldComplexity = 1,
    fieldComplexities: configFieldComplexities,
  } = config

  return {
    name: "analyzer",
    description: "Reports query complexity metrics in response extensions",

    onExecuteStart: (args: ExecutionArgs) =>
      Effect.gen(function* () {
        const ext = yield* ExtensionsService

        // Find the operation
        const operation = findOperation(args)
        if (!operation) {
          return
        }

        // Use config field complexities if provided, otherwise use from args
        const fieldComplexities = configFieldComplexities ?? args.fieldComplexities

        // Calculate complexity
        const calculator = defaultComplexityCalculator(defaultFieldComplexity)
        const result = yield* calculator({
          document: args.document,
          operation,
          variables: args.variableValues,
          schema: args.schema,
          fieldComplexities,
        }).pipe(
          Effect.catchAll((error) =>
            Effect.logWarning("Analyzer extension: complexity calculation failed", error).pipe(
              Effect.as(null)
            )
          )
        )

        if (!result) {
          return
        }

        // Check thresholds and log warnings
        yield* checkThresholds(result, thresholds)

        // Build output
        const output: AnalyzerOutput = {}
        if (includeComplexity) {
          output.complexity = result.complexity
        }
        if (includeDepth) {
          output.depth = result.depth
        }
        if (includeFieldCount) {
          output.fieldCount = result.fieldCount
        }
        if (includeAliasCount) {
          output.aliasCount = result.aliasCount
        }

        // Add to extensions
        yield* ext.set(key, output)
      }),
  }
}

/**
 * Find the operation to analyze from the document
 */
function findOperation(args: ExecutionArgs): OperationDefinitionNode | null {
  const operations = args.document.definitions.filter(
    (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION
  )

  if (operations.length === 0) {
    return null
  }

  if (args.operationName) {
    return operations.find((o) => o.name?.value === args.operationName) ?? null
  }

  return operations[0]
}

/**
 * Check thresholds and log warnings for exceeded values
 */
function checkThresholds(
  result: ComplexityResult,
  thresholds?: AnalyzerExtensionConfig["thresholds"]
): Effect.Effect<void> {
  if (!thresholds) {
    return Effect.void
  }

  const warnings: string[] = []

  if (thresholds.depth !== undefined && result.depth > thresholds.depth) {
    warnings.push(`Query depth ${result.depth} exceeds threshold ${thresholds.depth}`)
  }
  if (thresholds.complexity !== undefined && result.complexity > thresholds.complexity) {
    warnings.push(`Query complexity ${result.complexity} exceeds threshold ${thresholds.complexity}`)
  }
  if (thresholds.fieldCount !== undefined && result.fieldCount > thresholds.fieldCount) {
    warnings.push(`Query field count ${result.fieldCount} exceeds threshold ${thresholds.fieldCount}`)
  }
  if (thresholds.aliasCount !== undefined && result.aliasCount > thresholds.aliasCount) {
    warnings.push(`Query alias count ${result.aliasCount} exceeds threshold ${thresholds.aliasCount}`)
  }

  if (warnings.length > 0) {
    return Effect.logWarning("Analyzer extension: thresholds exceeded", {
      warnings,
      result,
    })
  }

  return Effect.void
}
