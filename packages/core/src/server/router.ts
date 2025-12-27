import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Cause, Effect, Layer } from "effect"
import {
  GraphQLSchema,
  parse,
  validate,
  specifiedRules,
  NoSchemaIntrospectionCustomRule,
  execute as graphqlExecute,
  type DocumentNode,
} from "graphql"
import type { GraphQLEffectContext } from "../builder/types"
import { graphiqlHtml } from "./graphiql"
import { normalizeConfig, type GraphQLRouterConfigInput } from "./config"
import {
  validateComplexity,
  ComplexityLimitExceededError,
  type FieldComplexityMap,
} from "./complexity"
import {
  type GraphQLExtension,
  ExtensionsService,
  makeExtensionsService,
  runParseHooks,
  runValidateHooks,
  runExecuteStartHooks,
  runExecuteEndHooks,
} from "../extensions"

/**
 * Error handler function type for handling uncaught errors during GraphQL execution.
 * Receives the error cause and should return an HTTP response.
 */
export type ErrorHandler = (
  cause: Cause.Cause<unknown>
) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, never>

/**
 * Default error handler that returns a 500 Internal Server Error.
 * In non-production environments, it logs the full error for debugging.
 */
export const defaultErrorHandler: ErrorHandler = (cause) =>
  (process.env.NODE_ENV !== "production"
    ? Effect.logError("GraphQL error", cause)
    : Effect.void
  ).pipe(
    Effect.andThen(
      HttpServerResponse.json(
        {
          errors: [
            {
              message: "An error occurred processing your request",
            },
          ],
        },
        { status: 500 }
      ).pipe(Effect.orDie)
    )
  )

/**
 * Options for makeGraphQLRouter
 */
export interface MakeGraphQLRouterOptions extends GraphQLRouterConfigInput {
  /**
   * Field complexity definitions from the schema builder.
   * If using toRouter(), this is automatically extracted from the builder.
   * If using makeGraphQLRouter() directly, call builder.getFieldComplexities().
   */
  readonly fieldComplexities?: FieldComplexityMap

  /**
   * GraphQL extensions for lifecycle hooks.
   * If using toRouter(), this is automatically extracted from the builder.
   * If using makeGraphQLRouter() directly, call builder.getExtensions().
   */
  readonly extensions?: readonly GraphQLExtension<any>[]

  /**
   * Custom error handler for uncaught errors during GraphQL execution.
   * Receives the error cause and should return an HTTP response.
   * Defaults to returning a 500 Internal Server Error with a generic message.
   */
  readonly errorHandler?: ErrorHandler
}

/**
 * Create an HttpRouter configured for GraphQL
 *
 * The router handles:
 * - POST requests to the GraphQL endpoint
 * - GET requests to the GraphiQL UI (if enabled)
 * - Query complexity validation (if configured)
 * - Extension lifecycle hooks (onParse, onValidate, onExecuteStart, onExecuteEnd)
 *
 * @param schema - The GraphQL schema
 * @param layer - Effect layer providing services required by resolvers
 * @param options - Optional configuration for paths, GraphiQL, complexity, and extensions
 * @returns An HttpRouter that can be composed with other routes
 *
 * @example
 * ```typescript
 * const router = makeGraphQLRouter(schema, Layer.empty, {
 *   path: "/graphql",
 *   graphiql: { path: "/graphiql" },
 *   complexity: { maxDepth: 10, maxComplexity: 1000 },
 *   fieldComplexities: builder.getFieldComplexities(),
 *   extensions: builder.getExtensions()
 * })
 *
 * // Compose with other routes
 * const app = HttpRouter.empty.pipe(
 *   HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" })),
 *   HttpRouter.concat(router)
 * )
 * ```
 */
export const makeGraphQLRouter = <R>(
  schema: GraphQLSchema,
  layer: Layer.Layer<R>,
  options: MakeGraphQLRouterOptions = {}
): HttpRouter.HttpRouter<never, never> => {
  const resolvedConfig = normalizeConfig(options)
  const fieldComplexities = options.fieldComplexities ?? new Map()
  const extensions = options.extensions ?? []
  const errorHandler = options.errorHandler ?? defaultErrorHandler

  // GraphQL POST handler
  const graphqlHandler = Effect.gen(function* () {
    // Create the ExtensionsService for this request
    const extensionsService = yield* makeExtensionsService()

    // Get the runtime from the layer
    const runtime = yield* Effect.runtime<R>()

    // Parse request body
    const request = yield* HttpServerRequest.HttpServerRequest
    const body = yield* request.json as Effect.Effect<{
      query: string
      variables?: Record<string, unknown>
      operationName?: string
    }>

    // Phase 1: Parse
    let document: DocumentNode
    try {
      document = parse(body.query)
    } catch (parseError) {
      // Parse errors are returned as GraphQL errors
      const extensionData = yield* extensionsService.get()
      return yield* HttpServerResponse.json({
        errors: [{ message: String(parseError) }],
        extensions: Object.keys(extensionData).length > 0 ? extensionData : undefined,
      })
    }

    // Run onParse hooks
    yield* runParseHooks(extensions, body.query, document).pipe(
      Effect.provideService(ExtensionsService, extensionsService)
    )

    // Phase 2: Validate
    // Add NoSchemaIntrospectionCustomRule if introspection is disabled
    const validationRules = resolvedConfig.introspection
      ? undefined
      : [...specifiedRules, NoSchemaIntrospectionCustomRule]
    const validationErrors = validate(schema, document, validationRules)

    // Run onValidate hooks
    yield* runValidateHooks(extensions, document, validationErrors).pipe(
      Effect.provideService(ExtensionsService, extensionsService)
    )

    // If validation failed, return errors without executing
    if (validationErrors.length > 0) {
      const extensionData = yield* extensionsService.get()
      return yield* HttpServerResponse.json(
        {
          errors: validationErrors.map((e) => ({
            message: e.message,
            locations: e.locations,
            path: e.path,
          })),
          extensions: Object.keys(extensionData).length > 0 ? extensionData : undefined,
        },
        { status: 400 }
      )
    }

    // Validate query complexity if configured
    if (resolvedConfig.complexity) {
      yield* validateComplexity(
        body.query,
        body.operationName,
        body.variables,
        schema,
        fieldComplexities,
        resolvedConfig.complexity
      ).pipe(
        Effect.catchTag("ComplexityLimitExceededError", (error) =>
          Effect.fail(error)
        ),
        Effect.catchTag("ComplexityAnalysisError", (error) =>
          // Log analysis errors but don't block execution
          Effect.logWarning("Complexity analysis failed", error)
        )
      )
    }

    // Phase 3: Execute
    const executionArgs = {
      source: body.query,
      document,
      variableValues: body.variables,
      operationName: body.operationName,
    }

    // Run onExecuteStart hooks
    yield* runExecuteStartHooks(extensions, executionArgs).pipe(
      Effect.provideService(ExtensionsService, extensionsService)
    )

    // Execute GraphQL query
    const executeResult = yield* Effect.try({
      try: () =>
        graphqlExecute({
          schema,
          document,
          variableValues: body.variables,
          operationName: body.operationName,
          contextValue: { runtime } satisfies GraphQLEffectContext<R>,
        }),
      catch: (error) => new Error(String(error)),
    })

    // Await result if it's a promise (shouldn't be for queries/mutations, but handle it)
    const resolvedResult: Awaited<typeof executeResult> =
      executeResult && typeof executeResult === "object" && "then" in executeResult
        ? yield* Effect.promise(() => executeResult)
        : executeResult

    // Run onExecuteEnd hooks
    yield* runExecuteEndHooks(extensions, resolvedResult).pipe(
      Effect.provideService(ExtensionsService, extensionsService)
    )

    // Merge extension data into result
    const extensionData = yield* extensionsService.get()
    const finalResult =
      Object.keys(extensionData).length > 0
        ? {
            ...resolvedResult,
            extensions: {
              ...resolvedResult.extensions,
              ...extensionData,
            },
          }
        : resolvedResult

    return yield* HttpServerResponse.json(finalResult)
  }).pipe(
    Effect.provide(layer),
    Effect.catchAll((error) => {
      // Handle complexity limit exceeded error specifically
      if (error instanceof ComplexityLimitExceededError) {
        return HttpServerResponse.json(
          {
            errors: [
              {
                message: error.message,
                extensions: {
                  code: "COMPLEXITY_LIMIT_EXCEEDED",
                  limitType: error.limitType,
                  limit: error.limit,
                  actual: error.actual,
                },
              },
            ],
          },
          { status: 400 }
        ).pipe(Effect.orDie)
      }
      // Re-throw other errors to be caught by catchAllCause
      return Effect.fail(error)
    }),
    Effect.catchAllCause(errorHandler)
  )

  // Build router with GraphQL endpoint
  let router = HttpRouter.empty.pipe(
    HttpRouter.post(resolvedConfig.path as HttpRouter.PathInput, graphqlHandler)
  )

  // Add GraphiQL route if enabled
  if (resolvedConfig.graphiql) {
    const { path, endpoint } = resolvedConfig.graphiql
    router = router.pipe(
      HttpRouter.get(
        path as HttpRouter.PathInput,
        HttpServerResponse.html(graphiqlHtml(endpoint))
      )
    )
  }

  return router
}
