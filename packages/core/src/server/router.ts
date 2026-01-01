import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpIncomingMessage,
  HttpServerError,
  HttpBody,
} from "@effect/platform"
import { Cause, Context, Effect, Layer, ParseResult, Schema } from "effect"
import {
  GraphQLSchema,
  parse,
  validate,
  specifiedRules,
  NoSchemaIntrospectionCustomRule,
  execute as graphqlExecute,
  Kind,
  type DocumentNode,
  type OperationDefinitionNode,
} from "graphql"
import type { GraphQLEffectContext } from "../builder/types"
import { graphiqlHtml } from "./graphiql"
import { normalizeConfig, type GraphQLRouterConfigInput } from "./config"
import {
  validateComplexity,
  ComplexityLimitExceededError,
  type FieldComplexityMap,
} from "./complexity"
import { computeCachePolicy, toCacheControlHeader, type CacheHintMap } from "./cache-control"
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
 * Schema for GraphQL request body.
 */
const GraphQLRequestBodySchema = Schema.Struct({
  query: Schema.String,
  variables: Schema.optionalWith(Schema.Record({ key: Schema.String, value: Schema.Unknown }), {
    as: "Option",
  }),
  operationName: Schema.optionalWith(Schema.String, { as: "Option" }),
})

/**
 * Request body for GraphQL queries.
 */
interface GraphQLRequestBody {
  readonly query: string
  readonly variables?: Record<string, unknown>
  readonly operationName?: string
}

/**
 * Decode the request body from JSON using the schema.
 */
const decodeRequestBody = HttpIncomingMessage.schemaBodyJson(GraphQLRequestBodySchema)

/**
 * Union of all possible errors that can occur during GraphQL request handling.
 */
type GraphQLHandlerError =
  | HttpServerError.RequestError
  | HttpBody.HttpBodyError
  | ParseResult.ParseError
  | ComplexityLimitExceededError
  | Error

/**
 * Result type for parseGraphQLQuery
 */
type ParseGraphQLQueryResult =
  | { ok: true; document: DocumentNode }
  | { ok: false; response: HttpServerResponse.HttpServerResponse }

/**
 * Parse a GraphQL query string into a DocumentNode.
 * Returns the document or an error response if parsing fails.
 */
const parseGraphQLQuery = (
  query: string,
  extensionsService: Context.Tag.Service<typeof ExtensionsService>
): Effect.Effect<ParseGraphQLQueryResult, never, never> => {
  try {
    const document = parse(query)
    return Effect.succeed({ ok: true as const, document })
  } catch (parseError) {
    return extensionsService.get().pipe(
      Effect.flatMap(
        (extensionData): Effect.Effect<ParseGraphQLQueryResult, never, never> =>
          HttpServerResponse.json({
            errors: [{ message: String(parseError) }],
            extensions: Object.keys(extensionData).length > 0 ? extensionData : undefined,
          }).pipe(
            Effect.orDie,
            Effect.map((response) => ({ ok: false as const, response }))
          )
      )
    )
  }
}

/**
 * Run complexity validation if configured.
 * Logs warnings for analysis errors but doesn't block execution.
 */
const runComplexityValidation = (
  body: GraphQLRequestBody,
  schema: GraphQLSchema,
  fieldComplexities: FieldComplexityMap,
  complexityConfig: { maxDepth?: number; maxComplexity?: number } | undefined
): Effect.Effect<void, ComplexityLimitExceededError, never> => {
  if (!complexityConfig) {
    return Effect.void
  }

  return validateComplexity(
    body.query,
    body.operationName,
    body.variables,
    schema,
    fieldComplexities,
    complexityConfig
  ).pipe(
    Effect.catchTag("ComplexityLimitExceededError", (error) => Effect.fail(error)),
    Effect.catchTag("ComplexityAnalysisError", (error) =>
      Effect.logWarning("Complexity analysis failed", error)
    )
  )
}

/**
 * Type guard to check if a value is a Promise-like object.
 */
const isPromiseLike = <T>(value: unknown): value is PromiseLike<T> =>
  value !== null && typeof value === "object" && "then" in value && typeof value.then === "function"

/**
 * Execute a GraphQL query and handle async results.
 */
const executeGraphQLQuery = <R>(
  schema: GraphQLSchema,
  document: DocumentNode,
  variables: Record<string, unknown> | undefined,
  operationName: string | undefined,
  runtime: import("effect").Runtime.Runtime<R>
): Effect.Effect<import("graphql").ExecutionResult, Error, never> => {
  type ExecutionResult = import("graphql").ExecutionResult

  const tryExecute = Effect.try({
    try: () =>
      graphqlExecute({
        schema,
        document,
        variableValues: variables,
        operationName,
        contextValue: { runtime } satisfies GraphQLEffectContext<R>,
      }),
    catch: (error) => new Error(String(error)),
  })

  return tryExecute.pipe(
    Effect.flatMap((executeResult): Effect.Effect<ExecutionResult, never, never> => {
      if (isPromiseLike<ExecutionResult>(executeResult)) {
        return Effect.promise(() => executeResult)
      }
      return Effect.succeed(executeResult)
    })
  )
}

/**
 * Compute cache control header for the response if applicable.
 */
const computeCacheControlHeader = (
  document: DocumentNode,
  operationName: string | undefined,
  schema: GraphQLSchema,
  cacheHints: CacheHintMap,
  cacheControlConfig:
    | { enabled?: boolean; calculateHttpHeaders?: boolean; defaultMaxAge?: number }
    | undefined
): Effect.Effect<string | undefined, never, never> => {
  if (cacheControlConfig?.enabled === false || cacheControlConfig?.calculateHttpHeaders === false) {
    return Effect.succeed(undefined)
  }

  // Find the operation from the document
  const operations = document.definitions.filter(
    (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION
  )
  const operation = operationName
    ? operations.find((o) => o.name?.value === operationName)
    : operations[0]

  if (!operation || operation.operation === "mutation") {
    // Mutations should not be cached
    return Effect.succeed(undefined)
  }

  return computeCachePolicy({
    document,
    operation,
    schema,
    cacheHints,
    config: cacheControlConfig ?? {},
  }).pipe(Effect.map(toCacheControlHeader))
}

/**
 * Build the final GraphQL response with extensions merged in.
 */
const buildGraphQLResponse = (
  result: import("graphql").ExecutionResult,
  extensionData: Record<string, unknown>,
  cacheControlHeader: string | undefined
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, never> => {
  const finalResult =
    Object.keys(extensionData).length > 0
      ? {
          ...result,
          extensions: {
            ...result.extensions,
            ...extensionData,
          },
        }
      : result

  const responseHeaders = cacheControlHeader ? { "cache-control": cacheControlHeader } : undefined

  return HttpServerResponse.json(finalResult, { headers: responseHeaders }).pipe(Effect.orDie)
}

/**
 * Handle complexity limit exceeded error, returning appropriate response.
 */
const handleComplexityError = (
  error: ComplexityLimitExceededError
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, never> =>
  HttpServerResponse.json(
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
   * Cache hint definitions from the schema builder.
   * If using toRouter(), this is automatically extracted from the builder.
   * If using makeGraphQLRouter() directly, call builder.getCacheHints().
   */
  readonly cacheHints?: CacheHintMap

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
  const cacheHints = options.cacheHints ?? new Map()
  const extensions = options.extensions ?? []
  const errorHandler = options.errorHandler ?? defaultErrorHandler

  // GraphQL POST handler - typed as returning HttpServerResponse with all errors handled
  const graphqlHandler = Effect.gen(function* () {
    const extensionsService = yield* makeExtensionsService()
    const runtime = yield* Effect.runtime<R>()

    // Parse request body
    const request = yield* HttpServerRequest.HttpServerRequest
    const parsedBody = yield* decodeRequestBody(request)
    const body: GraphQLRequestBody = {
      query: parsedBody.query,
      variables: parsedBody.variables._tag === "Some" ? parsedBody.variables.value : undefined,
      operationName:
        parsedBody.operationName._tag === "Some" ? parsedBody.operationName.value : undefined,
    }

    // Phase 1: Parse
    const parseResult = yield* parseGraphQLQuery(body.query, extensionsService)
    if (!parseResult.ok) {
      return parseResult.response
    }
    const document = parseResult.document

    yield* runParseHooks(extensions, body.query, document).pipe(
      Effect.provideService(ExtensionsService, extensionsService)
    )

    // Phase 2: Validate
    const validationRules = resolvedConfig.introspection
      ? undefined
      : specifiedRules.concat(NoSchemaIntrospectionCustomRule)
    const validationErrors = validate(schema, document, validationRules)

    yield* runValidateHooks(extensions, document, validationErrors).pipe(
      Effect.provideService(ExtensionsService, extensionsService)
    )

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

    // Complexity validation
    yield* runComplexityValidation(body, schema, fieldComplexities, resolvedConfig.complexity)

    // Phase 3: Execute
    yield* runExecuteStartHooks(extensions, {
      source: body.query,
      document,
      variableValues: body.variables,
      operationName: body.operationName,
      schema,
      fieldComplexities,
    }).pipe(Effect.provideService(ExtensionsService, extensionsService))

    const result = yield* executeGraphQLQuery(
      schema,
      document,
      body.variables,
      body.operationName,
      runtime
    )

    yield* runExecuteEndHooks(extensions, result).pipe(
      Effect.provideService(ExtensionsService, extensionsService)
    )

    // Build response
    const extensionData = yield* extensionsService.get()
    const cacheControlHeader = yield* computeCacheControlHeader(
      document,
      body.operationName,
      schema,
      cacheHints,
      resolvedConfig.cacheControl
    )

    return yield* buildGraphQLResponse(result, extensionData, cacheControlHeader)
  }).pipe(
    Effect.provide(layer),
    Effect.catchAll((error: GraphQLHandlerError) => {
      if (error instanceof ComplexityLimitExceededError) {
        return handleComplexityError(error)
      }
      return Effect.fail(error)
    }),
    Effect.catchAllCause(errorHandler)
  )

  // Build router
  let router = HttpRouter.empty.pipe(
    HttpRouter.post(resolvedConfig.path as HttpRouter.PathInput, graphqlHandler)
  )

  if (resolvedConfig.graphiql) {
    const { path, endpoint, subscriptionEndpoint } = resolvedConfig.graphiql
    router = router.pipe(
      HttpRouter.get(
        path as HttpRouter.PathInput,
        HttpServerResponse.html(graphiqlHtml(endpoint, subscriptionEndpoint))
      )
    )
  }

  return router
}
