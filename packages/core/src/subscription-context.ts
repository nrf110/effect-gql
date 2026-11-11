import { Context } from "effect"
import { GraphQLError } from "graphql"
import type { GraphQLEffectContext, SubscriptionContext } from "./builder/types"

interface SubscriptionOperation {
  claimed: boolean
  args: unknown
  runOptions?: { readonly signal: AbortSignal }
  pendingWork?: Set<Promise<unknown>>
}

// Separate entrypoint and ESM/CJS bundles must recognize the same identities.
// Version the registry protocol when its stored state changes incompatibly.
const registryKey = Symbol.for("@effect-gql/core/SubscriptionContext/v1")
const shared = globalThis as typeof globalThis & {
  [registryKey]?: WeakMap<object, SubscriptionOperation>
}

// Weak keys retain metadata for delayed resolvers without retaining contexts.
export const subscriptionOperations = (shared[registryKey] ??= new WeakMap<
  object,
  SubscriptionOperation
>())

/**
 * Create a registered, one-use context for native GraphQL subscriptions.
 * Call once per subscribe() invocation. Services and additional property values
 * are shared by reference; the returned wrapper is always new and may be frozen.
 */
export function makeSubscriptionContext<C extends GraphQLEffectContext<never>>(
  base: C
): SubscriptionContext<C> {
  if (typeof base !== "object" || base === null || !Context.isContext(base.services)) {
    throw new GraphQLError(
      "makeSubscriptionContext requires an object containing Effect services.",
      {
        extensions: { code: "SUBSCRIPTION_CONTEXT_REQUIRED" },
      }
    )
  }
  const context = { ...base, services: base.services }
  subscriptionOperations.set(context, { claimed: false, args: undefined })
  return context as SubscriptionContext<C>
}
