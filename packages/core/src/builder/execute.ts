import { Effect, Layer, Runtime } from "effect"
import {
  GraphQLSchema,
  GraphQLError,
  parse,
  validate,
  execute as graphqlExecute,
  type ExecutionResult,
  type DocumentNode,
} from "graphql"
import type { GraphQLEffectContext } from "./types"
import {
  type GraphQLExtension,
  ExtensionsService,
  makeExtensionsService,
  runParseHooks,
  runValidateHooks,
  runExecuteStartHooks,
  runExecuteEndHooks,
} from "../extensions"
import type { FieldComplexityMap } from "../server/complexity"

/**
 * Execute a GraphQL query with a service layer
 *
 * This is the layer-per-request execution model. Build the schema once,
 * then execute each request with its own layer (including request-scoped services).
 *
 * The execution follows these phases:
 * 1. Parse - Convert source string to DocumentNode
 * 2. Validate - Check document against schema
 * 3. Execute - Run resolvers and return result
 *
 * Extensions can hook into each phase via onParse, onValidate, onExecuteStart, onExecuteEnd.
 * Extension data is automatically merged into the response's extensions field.
 */
export const execute = <R>(
  schema: GraphQLSchema,
  layer: Layer.Layer<R>,
  extensions: readonly GraphQLExtension<any>[] = [],
  fieldComplexities: FieldComplexityMap = new Map()
) => (
  source: string,
  variableValues?: Record<string, unknown>,
  operationName?: string
): Effect.Effect<ExecutionResult, Error> =>
  Effect.gen(function* () {
    // Create the ExtensionsService for this request
    const extensionsService = yield* makeExtensionsService()

    // Create runtime from the provided layer
    const runtime = yield* Effect.runtime<R>()

    // Phase 1: Parse
    let document: DocumentNode
    try {
      document = parse(source)
    } catch (parseError) {
      // Parse errors are returned as GraphQL errors, not thrown
      const extensionData = yield* extensionsService.get()
      return {
        errors: [
          parseError instanceof GraphQLError
            ? parseError
            : new GraphQLError(String(parseError)),
        ],
        extensions: Object.keys(extensionData).length > 0 ? extensionData : undefined,
      } as ExecutionResult
    }

    // Run onParse hooks
    yield* runParseHooks(extensions, source, document).pipe(
      Effect.provideService(ExtensionsService, extensionsService)
    )

    // Phase 2: Validate
    const validationErrors = validate(schema, document)

    // Run onValidate hooks
    yield* runValidateHooks(extensions, document, validationErrors).pipe(
      Effect.provideService(ExtensionsService, extensionsService)
    )

    // If validation failed, return errors without executing
    if (validationErrors.length > 0) {
      const extensionData = yield* extensionsService.get()
      return {
        errors: validationErrors,
        extensions: Object.keys(extensionData).length > 0 ? extensionData : undefined,
      } as ExecutionResult
    }

    // Phase 3: Execute
    const executionArgs = {
      source,
      document,
      variableValues,
      operationName,
      schema,
      fieldComplexities,
    }

    // Run onExecuteStart hooks
    yield* runExecuteStartHooks(extensions, executionArgs).pipe(
      Effect.provideService(ExtensionsService, extensionsService)
    )

    // Execute the GraphQL query
    const executeResult = yield* Effect.try({
      try: () =>
        graphqlExecute({
          schema,
          document,
          variableValues,
          operationName,
          contextValue: { runtime } satisfies GraphQLEffectContext<R>,
        }),
      catch: (error) => new Error(String(error)),
    })

    // Await result if it's a promise (for subscriptions, it might be)
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
    if (Object.keys(extensionData).length > 0) {
      return {
        ...resolvedResult,
        extensions: {
          ...resolvedResult.extensions,
          ...extensionData,
        },
      }
    }

    return resolvedResult
  }).pipe(Effect.provide(layer)) as Effect.Effect<ExecutionResult, Error>

/**
 * Execute a GraphQL query with a service layer (simple version without extensions)
 *
 * @deprecated Use execute() instead, which now supports extensions as an optional parameter
 */
export const executeSimple = <R>(
  schema: GraphQLSchema,
  layer: Layer.Layer<R>
) => execute(schema, layer, [])
