import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect, Layer, Option } from "effect"
import {
  GraphQLSchema,
  parse,
  validate,
  specifiedRules,
  NoSchemaIntrospectionCustomRule,
  execute as graphqlExecute,
  type DocumentNode,
} from "graphql"
import {
  normalizeConfig,
  graphiqlHtml,
  validateComplexity,
  ComplexityLimitExceededError,
  type FieldComplexityMap,
  type ErrorHandler,
  defaultErrorHandler,
} from "@effect-gql/core/server"
import type { GraphQLEffectContext } from "@effect-gql/core"
import {
  ExtensionsService,
  makeExtensionsService,
  runParseHooks,
  runValidateHooks,
  runExecuteStartHooks,
  runExecuteEndHooks,
  type GraphQLExtension,
} from "@effect-gql/core"
import { PersistedQueryStore } from "./store"
import { makeMemoryStore } from "./memory-store"
import type { PersistedQueriesRouterOptions, PersistedQueryMode, HashAlgorithm } from "./config"
import {
  PersistedQueryNotFoundError,
  PersistedQueryVersionError,
  PersistedQueryHashMismatchError,
  PersistedQueryNotAllowedError,
} from "./errors"
import {
  computeHash,
  parsePersistedQueryExtension,
  parseGetRequestBody,
  type GraphQLRequestBody,
} from "./utils"

/**
 * Create a GraphQL router with Apollo Persisted Queries support.
 *
 * This creates a complete GraphQL router that includes:
 * - Apollo Persisted Queries (APQ) support
 * - GET request support for CDN caching
 * - All standard GraphQL router features (validation, execution, extensions)
 *
 * ## Apollo APQ Protocol
 *
 * 1. Client sends request with `extensions.persistedQuery.sha256Hash`
 * 2. If hash found in store, execute the stored query
 * 3. If hash NOT found and query provided (APQ mode), store it and execute
 * 4. If hash NOT found and NO query, return `PERSISTED_QUERY_NOT_FOUND`
 * 5. Client retries with both hash and query
 *
 * ## Modes
 *
 * - **APQ mode** (`mode: "apq"`): Automatic runtime registration.
 *   Unknown queries trigger NOT_FOUND, prompting client retry with full query.
 *
 * - **Safelist mode** (`mode: "safelist"`): Pre-registered queries only.
 *   Unknown queries return NOT_ALLOWED error. Use with `makeSafelistStore()`.
 *
 * @example APQ Mode (default)
 * ```typescript
 * import { makePersistedQueriesRouter } from "@effect-gql/persisted-queries"
 *
 * const router = makePersistedQueriesRouter(schema, serviceLayer, {
 *   mode: "apq",
 *   enableGet: true,
 *   graphiql: { path: "/graphiql" },
 * })
 * ```
 *
 * @example Safelist Mode
 * ```typescript
 * import { makePersistedQueriesRouter, makeSafelistStore } from "@effect-gql/persisted-queries"
 *
 * const router = makePersistedQueriesRouter(schema, serviceLayer, {
 *   mode: "safelist",
 *   store: makeSafelistStore({
 *     "abc123...": "query GetUser($id: ID!) { user(id: $id) { name } }",
 *   }),
 * })
 * ```
 *
 * @param schema - The GraphQL schema
 * @param layer - Effect layer providing services required by resolvers
 * @param options - Router and persisted query configuration
 * @returns An HttpRouter with persisted query support
 */
export const makePersistedQueriesRouter = <R>(
  schema: GraphQLSchema,
  layer: Layer.Layer<R>,
  options: PersistedQueriesRouterOptions = {}
): HttpRouter.HttpRouter<never, never> => {
  const mode: PersistedQueryMode = options.mode ?? "apq"
  const enableGet = options.enableGet ?? true
  const validateHashOption = options.validateHash ?? true
  const hashAlgorithm: HashAlgorithm = options.hashAlgorithm ?? "sha256"

  // Core router config
  const resolvedConfig = normalizeConfig(options)
  const fieldComplexities: FieldComplexityMap = options.fieldComplexities ?? new Map()
  const extensions: readonly GraphQLExtension<R>[] = options.extensions ?? []
  const errorHandler: ErrorHandler = options.errorHandler ?? defaultErrorHandler

  // Create the store layer (default to in-memory)
  const baseStoreLayer = options.store ?? makeMemoryStore()

  /**
   * Resolve a persisted query from the store or register it.
   * Returns the resolved request body with the query filled in.
   */
  const resolvePersistedQuery = (
    body: GraphQLRequestBody
  ): Effect.Effect<
    GraphQLRequestBody,
    | PersistedQueryNotFoundError
    | PersistedQueryVersionError
    | PersistedQueryHashMismatchError
    | PersistedQueryNotAllowedError,
    PersistedQueryStore
  > =>
    Effect.gen(function* () {
      const persistedQuery = parsePersistedQueryExtension(body.extensions)

      if (!persistedQuery) {
        // No persisted query extension - pass through unchanged
        return body
      }

      // Validate version
      if (persistedQuery.version !== 1) {
        return yield* Effect.fail(
          new PersistedQueryVersionError({ version: persistedQuery.version })
        )
      }

      const hash = persistedQuery.sha256Hash
      const store = yield* PersistedQueryStore

      // Check if we have the query stored
      const storedQuery = yield* store.get(hash)

      if (Option.isSome(storedQuery)) {
        // Query found - use it
        return {
          ...body,
          query: storedQuery.value,
        }
      }

      // Query not found in store
      if (!body.query) {
        // No query provided - client needs to send it
        return yield* Effect.fail(new PersistedQueryNotFoundError({ hash }))
      }

      // Query provided - check mode
      if (mode === "safelist") {
        // Safelist mode: reject unknown queries
        return yield* Effect.fail(new PersistedQueryNotAllowedError({ hash }))
      }

      // APQ mode: validate hash and store
      if (validateHashOption) {
        const computed = yield* computeHash(body.query, hashAlgorithm)
        if (computed !== hash) {
          return yield* Effect.fail(
            new PersistedQueryHashMismatchError({
              providedHash: hash,
              computedHash: computed,
            })
          )
        }
      }

      // Store the query for future requests
      yield* store.set(hash, body.query)

      return body
    })

  /**
   * Main GraphQL handler with APQ support
   */
  const createHandler = <RE>(parseBody: Effect.Effect<GraphQLRequestBody, Error, RE>) =>
    Effect.gen(function* () {
      // Parse request body
      const rawBody = yield* parseBody.pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            _parseError: true,
            message: error.message,
          } as any)
        )
      )

      if ("_parseError" in rawBody) {
        return yield* HttpServerResponse.json(
          { errors: [{ message: rawBody.message }] },
          { status: 400 }
        )
      }

      // Resolve persisted query
      const bodyResult = yield* resolvePersistedQuery(rawBody).pipe(
        Effect.provide(baseStoreLayer),
        Effect.either
      )

      if (bodyResult._tag === "Left") {
        // APQ error - return appropriate GraphQL error response
        const error = bodyResult.left
        return yield* HttpServerResponse.json({
          errors: [error.toGraphQLError()],
        })
      }

      const body = bodyResult.right

      // Check if we have a query to execute
      if (!body.query) {
        return yield* HttpServerResponse.json(
          { errors: [{ message: "No query provided" }] },
          { status: 400 }
        )
      }

      // Create the ExtensionsService for this request
      const extensionsService = yield* makeExtensionsService()

      // Get the runtime from the layer
      const runtime = yield* Effect.runtime<R>()

      // Phase 1: Parse
      let document: DocumentNode
      try {
        document = parse(body.query)
      } catch (parseError) {
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
          Effect.catchTag("ComplexityLimitExceededError", (error) => Effect.fail(error)),
          Effect.catchTag("ComplexityAnalysisError", (error) =>
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
        schema,
        fieldComplexities,
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

      // Await result if it's a promise
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
        return Effect.fail(error)
      }),
      Effect.catchAllCause(errorHandler)
    )

  // POST handler
  const postHandler = createHandler(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      return yield* request.json as Effect.Effect<GraphQLRequestBody, Error>
    })
  )

  // GET handler for CDN-cacheable persisted queries
  const getHandler = createHandler(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, "http://localhost")
      return yield* parseGetRequestBody(url.searchParams)
    })
  )

  // Build router
  let router = HttpRouter.empty.pipe(
    HttpRouter.post(resolvedConfig.path as HttpRouter.PathInput, postHandler)
  )

  // Add GET handler if enabled
  if (enableGet) {
    router = router.pipe(HttpRouter.get(resolvedConfig.path as HttpRouter.PathInput, getHandler))
  }

  // Add GraphiQL route if enabled
  if (resolvedConfig.graphiql) {
    const { path, endpoint } = resolvedConfig.graphiql
    router = router.pipe(
      HttpRouter.get(path as HttpRouter.PathInput, HttpServerResponse.html(graphiqlHtml(endpoint)))
    )
  }

  return router
}
