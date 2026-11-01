import { Effect, Option, Stream } from "effect"
import * as S from "effect/Schema"
import * as AST from "effect/SchemaAST"
import { GraphQLFieldConfig, GraphQLResolveInfo } from "graphql"
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
import { isOptionDeclaration } from "../schema-mapping"

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

/**
 * GraphQL hides discriminator fields. Restore only encoded literal `_tag` values
 * before schema decoding, without inventing omitted inputs or decoding defaults.
 */
function restoreHiddenInputTags(ast: AST.AST, value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  switch (ast._tag) {
    case "Suspend":
      return restoreHiddenInputTags(ast.thunk(), value)
    case "Declaration":
      return ast.typeParameters[0] ? restoreHiddenInputTags(ast.typeParameters[0], value) : value
    case "Union": {
      // Input unions expose their first non-null member in GraphQL.
      const member = ast.types.find(
        (type) => type._tag !== "Null" && type._tag !== "Undefined" && type._tag !== "Void"
      )
      return member ? restoreHiddenInputTags(member, value) : value
    }
    case "Arrays": {
      if (!Array.isArray(value)) return value
      let restored = value
      for (let index = 0; index < value.length; index++) {
        const element = ast.elements[index] ?? ast.rest[0]
        if (!element) continue
        const item = restoreHiddenInputTags(element, value[index])
        if (item !== value[index]) {
          if (restored === value) restored = value.slice()
          restored[index] = item
        }
      }
      return restored
    }
    case "Objects": {
      if (Array.isArray(value)) return value
      const record = value as Record<PropertyKey, unknown>
      let restored = record
      for (const field of ast.propertySignatures) {
        const present = Object.hasOwn(record, field.name)
        if (!present && (field.name !== "_tag" || field.type._tag !== "Literal")) continue
        const item =
          !present && field.type._tag === "Literal"
            ? field.type.literal
            : restoreHiddenInputTags(field.type, record[field.name])
        if (!present || item !== record[field.name]) {
          if (restored === record) restored = { ...record }
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
  const encoded = AST.toEncoded(schema.ast)
  const decode = S.decodeUnknownEffect(schema)
  return (args: unknown) => decode(restoreHiddenInputTags(encoded, args))
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
  config: FieldRegistration,
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
      const decodedArgs = decodeArgs
        ? await Effect.runPromiseWith(context.services)(decodeArgs(args))
        : args

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
      const result = await Effect.runPromiseWith(context.services)(effect)

      // Encode the result (converts Option.none() to null, Option.some(x) to x)
      return await Effect.runPromiseWith(context.services)(
        encodeResolverOutput(config.type, result)
      )
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
  config: ObjectFieldRegistration,
  ctx: FieldBuilderContext
): GraphQLFieldConfig<any, any> {
  const decodeArgs = config.args ? makeArgsDecoder(config.args) : undefined
  const fieldConfig: GraphQLFieldConfig<any, any> = {
    type: toGraphQLTypeWithRegistry(config.type, ctx),
    resolve: async (parent, args, context: GraphQLEffectContext<any>, info: GraphQLResolveInfo) => {
      const decodedArgs = decodeArgs
        ? await Effect.runPromiseWith(context.services)(decodeArgs(args))
        : args

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
      const result = await Effect.runPromiseWith(context.services)(effect)

      // Encode the result (converts Option.none() to null, Option.some(x) to x)
      return await Effect.runPromiseWith(context.services)(
        encodeResolverOutput(config.type, result)
      )
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
  config: SubscriptionFieldRegistration,
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
      const decodedArgs = decodeArgs
        ? await Effect.runPromiseWith(context.services)(decodeArgs(args))
        : args

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

      const stream = await Effect.runPromiseWith(context.services)(subscribeEffect)

      return Stream.toAsyncIterableWith(stream, context.services)
    },

    // The resolve function transforms each yielded value
    // If no custom resolve is provided, encode and return the payload directly
    resolve: config.resolve
      ? async (value, args, context: GraphQLEffectContext<any>, info: GraphQLResolveInfo) => {
          const decodedArgs = decodeArgs
            ? await Effect.runPromiseWith(context.services)(decodeArgs(args))
            : args

          let effect = config.resolve!(value, decodedArgs)

          // Apply middleware to the resolve effect
          const middlewareContext: MiddlewareContext = { parent: value, args: decodedArgs, info }
          effect = applyMiddleware(effect, middlewareContext, ctx.middlewares)

          // Execute the resolver
          const result = await Effect.runPromiseWith(context.services)(effect)

          // Encode the result (converts Option.none() to null, Option.some(x) to x)
          return await Effect.runPromiseWith(context.services)(
            encodeResolverOutput(config.type, result)
          )
        }
      : async (value, _args, context: GraphQLEffectContext<any>) => {
          // Even without custom resolve, encode Option values
          return await Effect.runPromiseWith(context.services)(
            encodeResolverOutput(config.type, value)
          )
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
