import { Effect, Runtime, Stream, Queue, Fiber, Option } from "effect"
import {
  GraphQLFieldConfig,
} from "graphql"
import type {
  FieldRegistration,
  SubscriptionFieldRegistration,
  ObjectFieldRegistration,
  DirectiveRegistration,
  GraphQLEffectContext,
} from "./types"
import {
  toGraphQLTypeWithRegistry,
  toGraphQLArgsWithRegistry,
  type TypeConversionContext,
} from "./type-registry"

/**
 * Context needed for building fields
 */
export interface FieldBuilderContext extends TypeConversionContext {
  directiveRegistrations: Map<string, DirectiveRegistration>
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
 * Build a GraphQL field config from a field registration (for queries/mutations)
 */
export function buildField(
  config: FieldRegistration,
  ctx: FieldBuilderContext
): GraphQLFieldConfig<any, any> {
  const fieldConfig: GraphQLFieldConfig<any, any> = {
    type: toGraphQLTypeWithRegistry(config.type, ctx),
    resolve: async (_parent, args, context: GraphQLEffectContext<any>) => {
      const effect = applyDirectives(
        config.resolve(args),
        config.directives,
        ctx.directiveRegistrations
      )
      return await Runtime.runPromise(context.runtime)(effect)
    }
  }

  if (config.args) {
    fieldConfig.args = toGraphQLArgsWithRegistry(
      config.args,
      ctx.enumRegistry,
      ctx.inputRegistry,
      ctx.inputs,
      ctx.enums
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
  const fieldConfig: GraphQLFieldConfig<any, any> = {
    type: toGraphQLTypeWithRegistry(config.type, ctx),
    resolve: async (parent, args, context: GraphQLEffectContext<any>) => {
      const effect = applyDirectives(
        config.resolve(parent, args),
        config.directives,
        ctx.directiveRegistrations
      )
      return await Runtime.runPromise(context.runtime)(effect)
    }
  }

  if (config.args) {
    fieldConfig.args = toGraphQLArgsWithRegistry(
      config.args,
      ctx.enumRegistry,
      ctx.inputRegistry,
      ctx.inputs,
      ctx.enums
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
 * We convert Effect's Stream to an AsyncIterator using a Queue-based approach.
 */
export function buildSubscriptionField(
  config: SubscriptionFieldRegistration,
  ctx: FieldBuilderContext
): GraphQLFieldConfig<any, any> {
  const fieldConfig: GraphQLFieldConfig<any, any> = {
    type: toGraphQLTypeWithRegistry(config.type, ctx),

    // The subscribe function returns an AsyncIterator
    subscribe: async (_parent, args, context: GraphQLEffectContext<any>) => {
      // Get the Stream from the subscribe Effect
      let subscribeEffect = config.subscribe(args)

      // Apply directives to the subscribe effect
      subscribeEffect = applyDirectives(
        subscribeEffect,
        config.directives,
        ctx.directiveRegistrations
      ) as any

      const stream = await Runtime.runPromise(context.runtime)(subscribeEffect)

      // Convert Stream to AsyncIterator using queue-based approach
      return streamToAsyncIterator(stream, context.runtime)
    },

    // The resolve function transforms each yielded value
    // If no custom resolve is provided, return the payload directly
    resolve: config.resolve
      ? async (value, args, context: GraphQLEffectContext<any>) => {
          const effect = config.resolve!(value, args)
          return await Runtime.runPromise(context.runtime)(effect)
        }
      : (value) => value,
  }

  if (config.args) {
    fieldConfig.args = toGraphQLArgsWithRegistry(
      config.args,
      ctx.enumRegistry,
      ctx.inputRegistry,
      ctx.inputs,
      ctx.enums
    )
  }
  if (config.description) {
    fieldConfig.description = config.description
  }

  return fieldConfig
}

/**
 * Convert an Effect Stream to an AsyncIterator using a Queue-based approach.
 *
 * This is needed because Stream.toAsyncIterable() requires R = never,
 * but our streams may have service requirements that need to be provided
 * by the runtime context.
 */
function streamToAsyncIterator<A, E, R>(
  stream: Stream.Stream<A, E, R>,
  runtime: Runtime.Runtime<R>
): AsyncIterator<A> {
  // Create the queue synchronously via runSync since unbounded queue creation is synchronous
  let queue: Queue.Queue<Option.Option<A>>
  let fiber: Fiber.RuntimeFiber<void, E>
  let initialized = false
  let done = false

  const initialize = async () => {
    if (initialized) return
    initialized = true

    queue = await Runtime.runPromise(runtime)(
      Queue.unbounded<Option.Option<A>>()
    )

    // Fork a fiber to run the stream and push values to the queue
    fiber = Runtime.runFork(runtime)(
      Effect.ensuring(
        Stream.runForEach(stream, (value) => Queue.offer(queue, Option.some(value))),
        // Signal completion by pushing None
        Queue.offer(queue, Option.none())
      )
    )
  }

  return {
    [Symbol.asyncIterator]() { return this },

    async next(): Promise<IteratorResult<A>> {
      await initialize()

      if (done) {
        return { done: true, value: undefined }
      }

      try {
        const optionValue = await Runtime.runPromise(runtime)(
          Queue.take(queue)
        )

        if (Option.isNone(optionValue)) {
          done = true
          return { done: true, value: undefined }
        }

        return { done: false, value: optionValue.value }
      } catch (error) {
        done = true
        throw error
      }
    },

    async return(): Promise<IteratorResult<A>> {
      // Cleanup - interrupt the fiber and shutdown the queue
      done = true
      if (initialized) {
        try {
          await Runtime.runPromise(runtime)(
            Fiber.interrupt(fiber as unknown as Fiber.Fiber<any, any>)
          )
          await Runtime.runPromise(runtime)(
            Queue.shutdown(queue)
          )
        } catch {
          // Ignore cleanup errors
        }
      }
      return { done: true, value: undefined }
    },
  } as AsyncIterator<A>
}
