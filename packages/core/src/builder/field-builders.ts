import { Context, Effect, Option, Stream } from "effect"
import * as S from "effect/Schema"
import * as AST from "effect/SchemaAST"
import { GraphQLError, GraphQLFieldConfig, GraphQLResolveInfo } from "graphql"
import type {
  FieldRegistration,
  SubscriptionFieldRegistration,
  ObjectFieldRegistration,
  DirectiveRegistration,
  MiddlewareRegistration,
  MiddlewareContext,
  GraphQLEffectContext,
} from "./types"
import {
  toGraphQLTypeWithRegistry,
  toGraphQLArgsWithRegistry,
  type TypeConversionContext,
  type InputTypeLookupCache,
} from "./type-registry"
import { getASTView, isOptionDeclaration } from "../schema-mapping"
import { subscriptionOperations } from "../subscription-context"

function runResolverEffect<A, E>(
  context: GraphQLEffectContext<any>,
  effect: Effect.Effect<A, E, any>
): Promise<A> {
  const operation = subscriptionOperations.get(context)
  const pending = Effect.runPromiseWith(context.services)(effect, operation?.runOptions)
  const pendingWork = operation?.pendingWork
  if (pendingWork) {
    pendingWork.add(pending)
    const settled = () => {
      pendingWork.delete(pending)
    }
    void pending.then(settled, settled)
  }
  return pending
}

/**
 * Encode a resolver's output value using the schema.
 * This is primarily needed for Option types where Option.none() needs to become null
 * and Option.some(x) needs to become x.
 *
 * For non-Option schemas, this is a no-op pass-through.
 */
function encodeResolverOutput(
  schema: S.Top,
  value: unknown
): Effect.Effect<unknown, never, unknown> {
  if (isOptionDeclaration(schema.ast)) {
    return S.encodeUnknownEffect(schema)(value).pipe(
      Effect.orDie,
      Effect.map((encoded) => (Option.isOption(encoded) ? Option.getOrNull(encoded) : encoded))
    )
  }
  return Effect.succeed(value)
}

/** Only explicit undefined encodings make an omitted required key restorable. */
function hasUndefinedEncoding(ast: AST.AST, seen?: Set<AST.AST>): boolean {
  switch (ast._tag) {
    case "Undefined":
    case "Void":
      return true
    case "Union":
      for (const member of ast.types) {
        if (hasUndefinedEncoding(member, seen)) return true
      }
      return false
    case "Suspend": {
      if (seen?.has(ast)) return false
      const visited = seen ?? new Set<AST.AST>()
      visited.add(ast)
      return hasUndefinedEncoding(ast.thunk(), visited)
    }
    default:
      return false
  }
}

/**
 * Restore the representations hidden by GraphQL before full-schema decoding.
 * Optional keys stay absent so schema defaults and key-level codecs still run.
 */
function restoreGraphQLInput(original: AST.AST, value: unknown): unknown {
  const ast = getASTView(original, "input")
  if (ast._tag === "Suspend") return restoreGraphQLInput(ast.thunk(), value)
  if (isOptionDeclaration(ast) && ast._tag === "Declaration") {
    const inner = ast.typeParameters[0]
    return value == null
      ? Option.none()
      : Option.some(inner ? restoreGraphQLInput(inner, value) : value)
  }
  if (value === undefined && isOptionDeclaration(original) && ast._tag === "Union") {
    if (ast.types.some((member) => member._tag === "Null")) return null
  }
  if (ast._tag === "Union") {
    // Preserve explicit nullish branches, but normalize an optional Option's null
    // through its declaration when the union only adds undefined.
    if (value === undefined || (value === null && ast.types.some((type) => type._tag === "Null"))) {
      return value
    }
    // Input unions expose their first non-null member in GraphQL.
    const member = ast.types.find(
      (type) => type._tag !== "Null" && type._tag !== "Undefined" && type._tag !== "Void"
    )
    return member ? restoreGraphQLInput(member, value) : value
  }
  if (value === null || value === undefined) return value
  switch (ast._tag) {
    case "Declaration":
      return ast.typeParameters[0] ? restoreGraphQLInput(ast.typeParameters[0], value) : value
    case "Arrays": {
      if (!Array.isArray(value)) return value
      let restored = value
      // The first rest schema repeats; any remaining schemas are anchored at the end.
      const tailStart = value.length - ast.rest.length + 1
      for (let index = 0; index < value.length; index++) {
        const element =
          ast.elements[index] ??
          (index >= tailStart ? ast.rest[index - tailStart + 1] : ast.rest[0])
        if (!element) continue
        const item = restoreGraphQLInput(element, value[index])
        if (item !== value[index]) {
          if (restored === value) restored = value.slice()
          restored[index] = item
        }
      }
      return restored
    }
    case "Objects": {
      if (typeof value !== "object" || Array.isArray(value)) return value
      const record = value as Record<PropertyKey, unknown>
      let restored = record
      for (const field of ast.propertySignatures) {
        const present = Object.hasOwn(record, field.name)
        if (!present && field.name in record && restored === record) {
          restored = Object.assign(Object.create(null), record)
        }
        const encoded = present ? undefined : AST.toEncoded(field.type)
        if (encoded && AST.isOptional(encoded)) continue
        const item =
          field.name === "_tag" && encoded?._tag === "Literal"
            ? encoded.literal
            : restoreGraphQLInput(field.type, present ? record[field.name] : undefined)
        if (!present && item === undefined && (!encoded || !hasUndefinedEncoding(encoded))) continue
        if (!present || item !== record[field.name]) {
          if (restored === record) restored = Object.assign(Object.create(null), record)
          restored[field.name] = item
        }
      }
      return restored
    }
    default:
      return value
  }
}

function makeArgsDecoder(schema: S.Top) {
  const decode = S.decodeUnknownEffect(schema)
  return (args: unknown) => decode(restoreGraphQLInput(schema.ast, args))
}

/**
 * Effect's adapter owns acquisition, failure and interruption. Only pulls are
 * queued: return/throw must reach it immediately to interrupt a blocked pull.
 */
function serializeStreamPulls<A>(source: AsyncIterable<A>): AsyncIterable<A> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]()
      let pending = Promise.resolve()
      return {
        next() {
          const result = pending.then(() => iterator.next())
          pending = result.then(
            () => undefined,
            () => undefined
          )
          return result
        },
        return(value?: unknown) {
          return (
            iterator.return?.(value) ??
            Promise.resolve<IteratorResult<A>>({ done: true, value: undefined })
          )
        },
        throw(error?: unknown) {
          return iterator.throw
            ? iterator.throw(error)
            : Promise.resolve(iterator.return?.()).then(() => Promise.reject(error))
        },
      }
    },
  }
}

function claimSubscriptionContext(context: GraphQLEffectContext<any>) {
  const operation = subscriptionOperations.get(context)
  if (!operation || !Context.isContext(context.services)) {
    throw new GraphQLError(
      "Pass a fresh context from makeSubscriptionContext({ services }) to each subscribe() call. Plain objects and copied contexts are not registered.",
      { extensions: { code: "SUBSCRIPTION_CONTEXT_REQUIRED" } }
    )
  }
  if (operation.claimed) {
    throw new GraphQLError(
      "This subscription context has already been used. Call makeSubscriptionContext({ services }) for each subscribe() invocation, not once per WebSocket connection. Reuse the services, not the context object.",
      { extensions: { code: "SUBSCRIPTION_CONTEXT_REUSED" } }
    )
  }
  operation.claimed = true
  return operation
}

/**
 * Context needed for building fields
 */
export interface FieldBuilderContext extends TypeConversionContext {
  directiveRegistrations: Map<string, DirectiveRegistration>
  middlewares: readonly MiddlewareRegistration[]
  inputTypeLookupCache?: InputTypeLookupCache
}

/**
 * Apply directives to an Effect by wrapping it with directive transformers
 */
function applyDirectives<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  directives: readonly { name: string; args?: Record<string, unknown> }[] | undefined,
  directiveRegistrations: Map<string, DirectiveRegistration>
): Effect.Effect<A, E, any> {
  if (!directives) return effect

  let wrapped = effect
  for (const directiveApp of directives) {
    const directiveReg = directiveRegistrations.get(directiveApp.name)
    if (directiveReg?.apply) {
      wrapped = directiveReg.apply(directiveApp.args ?? {})(wrapped)
    }
  }
  return wrapped
}

/**
 * Apply middleware to an Effect by wrapping it with middleware transformers.
 *
 * Middleware executes in "onion" order - first registered middleware is the
 * outermost layer, meaning it runs first before and last after the resolver.
 *
 * Each middleware can optionally specify a `match` predicate to filter which
 * fields it applies to.
 */
function applyMiddleware<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  context: MiddlewareContext,
  middlewares: readonly MiddlewareRegistration[]
): Effect.Effect<A, E, any> {
  if (middlewares.length === 0) return effect

  let wrapped = effect

  // Apply in reverse order so first registered is outermost
  // (executes first before, last after)
  for (let i = middlewares.length - 1; i >= 0; i--) {
    const middleware = middlewares[i]

    // Check if middleware should apply to this field
    if (middleware.match && !middleware.match(context.info)) {
      continue
    }

    wrapped = middleware.apply(wrapped, context)
  }

  return wrapped
}

/**
 * Build a GraphQL field config from a field registration (for queries/mutations)
 */
export function buildField(
  config: FieldRegistration<any, any, any, any, unknown>,
  ctx: FieldBuilderContext
): GraphQLFieldConfig<any, any> {
  const decodeArgs = config.args ? makeArgsDecoder(config.args) : undefined
  const fieldConfig: GraphQLFieldConfig<any, any> = {
    type: toGraphQLTypeWithRegistry(config.type, ctx),
    resolve: async (
      _parent,
      args,
      context: GraphQLEffectContext<any>,
      info: GraphQLResolveInfo
    ) => {
      const decodedArgs = decodeArgs ? await runResolverEffect(context, decodeArgs(args)) : args

      // Apply directives first (per-field, explicit)
      let effect = applyDirectives(
        config.resolve(decodedArgs),
        config.directives,
        ctx.directiveRegistrations
      )

      // Apply middleware (global/pattern-matched)
      const middlewareContext: MiddlewareContext = { parent: _parent, args: decodedArgs, info }
      effect = applyMiddleware(effect, middlewareContext, ctx.middlewares)

      // Execute the resolver
      const result = await runResolverEffect(context, effect)

      // Encode the result (converts Option.none() to null, Option.some(x) to x)
      return await runResolverEffect(context, encodeResolverOutput(config.type, result))
    },
  }

  if (config.args) {
    fieldConfig.args = toGraphQLArgsWithRegistry(
      config.args,
      ctx.enumRegistry,
      ctx.inputRegistry,
      ctx.inputs,
      ctx.enums,
      ctx.inputTypeLookupCache
    )
  }
  if (config.description) {
    fieldConfig.description = config.description
  }

  return fieldConfig
}

/**
 * Build a GraphQL field config for an object field (has parent param)
 */
export function buildObjectField(
  config: ObjectFieldRegistration<any, any, any, any, any, unknown>,
  ctx: FieldBuilderContext
): GraphQLFieldConfig<any, any> {
  const decodeArgs = config.args ? makeArgsDecoder(config.args) : undefined
  const fieldConfig: GraphQLFieldConfig<any, any> = {
    type: toGraphQLTypeWithRegistry(config.type, ctx),
    resolve: async (parent, args, context: GraphQLEffectContext<any>, info: GraphQLResolveInfo) => {
      const decodedArgs = decodeArgs ? await runResolverEffect(context, decodeArgs(args)) : args

      // Apply directives first (per-field, explicit)
      let effect = applyDirectives(
        config.resolve(parent, decodedArgs),
        config.directives,
        ctx.directiveRegistrations
      )

      // Apply middleware (global/pattern-matched)
      const middlewareContext: MiddlewareContext = { parent, args: decodedArgs, info }
      effect = applyMiddleware(effect, middlewareContext, ctx.middlewares)

      // Execute the resolver
      const result = await runResolverEffect(context, effect)

      // Encode the result (converts Option.none() to null, Option.some(x) to x)
      return await runResolverEffect(context, encodeResolverOutput(config.type, result))
    },
  }

  if (config.args) {
    fieldConfig.args = toGraphQLArgsWithRegistry(
      config.args,
      ctx.enumRegistry,
      ctx.inputRegistry,
      ctx.inputs,
      ctx.enums,
      ctx.inputTypeLookupCache
    )
  }
  if (config.description) {
    fieldConfig.description = config.description
  }

  return fieldConfig
}

/**
 * Build a GraphQL subscription field config.
 *
 * Subscriptions in GraphQL have a special structure:
 * - `subscribe` returns an AsyncIterator that yields the "root value" for each event
 * - `resolve` transforms each yielded value into the final result
 *
 * Effect's native AsyncIterable adapter preserves stream failure and cancellation.
 */
export function buildSubscriptionField(
  config: SubscriptionFieldRegistration<any, any, any, any, unknown>,
  ctx: FieldBuilderContext
): GraphQLFieldConfig<any, any> {
  const decodeArgs = config.args ? makeArgsDecoder(config.args) : undefined
  const fieldConfig: GraphQLFieldConfig<any, any> = {
    type: toGraphQLTypeWithRegistry(config.type, ctx),

    // The subscribe function returns an AsyncIterator
    subscribe: async (
      _parent,
      args,
      context: GraphQLEffectContext<any>,
      info: GraphQLResolveInfo
    ) => {
      // Claim before the first await: concurrent setup cannot reuse this identity.
      const operation = claimSubscriptionContext(context)
      const decodedArgs = decodeArgs ? await runResolverEffect(context, decodeArgs(args)) : args
      operation.args = decodedArgs

      // Get the Stream from the subscribe Effect
      let subscribeEffect = config.subscribe(decodedArgs)

      // Apply directives to the subscribe effect
      subscribeEffect = applyDirectives(
        subscribeEffect,
        config.directives,
        ctx.directiveRegistrations
      ) as any

      // Apply middleware to the subscribe effect
      const middlewareContext: MiddlewareContext = { parent: _parent, args: decodedArgs, info }
      subscribeEffect = applyMiddleware(subscribeEffect, middlewareContext, ctx.middlewares) as any

      const stream = await runResolverEffect(context, subscribeEffect)

      return serializeStreamPulls(Stream.toAsyncIterableWith(stream, context.services))
    },

    // The resolve function transforms each yielded value
    // If no custom resolve is provided, encode and return the payload directly
    resolve: config.resolve
      ? async (value, _args, context: GraphQLEffectContext<any>, info: GraphQLResolveInfo) => {
          const operation = subscriptionOperations.get(context)
          if (!operation?.claimed) {
            throw new GraphQLError(
              "Subscription event resolvers must preserve the registered context from makeSubscriptionContext passed to subscribe().",
              { extensions: { code: "SUBSCRIPTION_CONTEXT_REQUIRED" } }
            )
          }
          const decodedArgs = operation.args
          let effect = config.resolve!(value, decodedArgs)

          // Apply middleware to the resolve effect
          const middlewareContext: MiddlewareContext = { parent: value, args: decodedArgs, info }
          effect = applyMiddleware(effect, middlewareContext, ctx.middlewares)

          // Execute the resolver
          const result = await runResolverEffect(context, effect)

          // Encode the result (converts Option.none() to null, Option.some(x) to x)
          return await runResolverEffect(context, encodeResolverOutput(config.type, result))
        }
      : async (value, _args, context: GraphQLEffectContext<any>) => {
          // Even without custom resolve, encode Option values
          return await runResolverEffect(context, encodeResolverOutput(config.type, value))
        },
  }

  if (config.args) {
    fieldConfig.args = toGraphQLArgsWithRegistry(
      config.args,
      ctx.enumRegistry,
      ctx.inputRegistry,
      ctx.inputs,
      ctx.enums,
      ctx.inputTypeLookupCache
    )
  }
  if (config.description) {
    fieldConfig.description = config.description
  }

  return fieldConfig
}
