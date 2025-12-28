import { Data, Effect, Runtime, Stream } from "effect"
import type { ExecutionResult } from "graphql"
import type { ComplexityConfig, FieldComplexityMap } from "./complexity"

/**
 * Standard SSE response headers following the graphql-sse protocol.
 * Use these headers when writing SSE responses in platform adapters.
 */
export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no", // Disable nginx buffering
} as const

/**
 * Error type for SSE operations
 */
export class SSEError extends Data.TaggedError("SSEError")<{
  readonly cause: unknown
}> {}

/**
 * SSE event types following the graphql-sse protocol (distinct connections mode).
 * @see https://github.com/enisdenjo/graphql-sse/blob/master/PROTOCOL.md
 */
export type SSEEventType = "next" | "error" | "complete"

/**
 * An SSE event to be sent to the client.
 */
export interface SSEEvent {
  readonly event: SSEEventType
  readonly data: string
}

/**
 * Platform-neutral SSE response interface using Effect types.
 *
 * This interface abstracts SSE operations across different platforms
 * (Node.js, Bun, Deno, Workers). Platform packages implement this
 * interface to bridge their specific HTTP response implementations.
 *
 * Unlike WebSocket which is bidirectional, SSE is unidirectional
 * (server to client only). The subscription query is provided
 * upfront when creating the SSE connection.
 */
export interface EffectSSE {
  /**
   * Send an SSE event to the client.
   * The platform adapter formats this as proper SSE format:
   * ```
   * event: next
   * data: {"data":{"field":"value"}}
   *
   * ```
   */
  readonly sendEvent: (event: SSEEvent) => Effect.Effect<void, SSEError>

  /**
   * Effect that completes when the client disconnects.
   * Use this to detect client disconnection and cleanup.
   */
  readonly closed: Effect.Effect<void, SSEError>
}

/**
 * The GraphQL request payload for SSE subscriptions.
 * Same as a regular GraphQL HTTP request.
 */
export interface SSESubscriptionRequest {
  readonly query: string
  readonly variables?: Record<string, unknown>
  readonly operationName?: string
  readonly extensions?: Record<string, unknown>
}

/**
 * Context available during an SSE subscription.
 * This is passed to lifecycle hooks.
 */
export interface SSEConnectionContext<R> {
  /**
   * The Effect runtime for this connection.
   * Use this to run Effects within the connection scope.
   */
  readonly runtime: Runtime.Runtime<R>

  /**
   * The original subscription request.
   */
  readonly request: SSESubscriptionRequest

  /**
   * Optional authentication/authorization context.
   * Populated by the onConnect hook.
   */
  readonly connectionContext: Record<string, unknown>
}

/**
 * Options for configuring the GraphQL SSE handler.
 *
 * @template R - Service requirements for lifecycle hooks
 */
export interface GraphQLSSEOptions<R> {
  /**
   * Query complexity limiting configuration.
   * When provided, subscriptions are validated against complexity limits
   * before execution begins.
   */
  readonly complexity?: ComplexityConfig

  /**
   * Field complexity definitions from the schema builder.
   * If using the platform serve() functions, this is typically
   * passed automatically.
   */
  readonly fieldComplexities?: FieldComplexityMap

  /**
   * Called before a subscription starts.
   *
   * Use this for authentication/authorization. Return:
   * - A context object to accept the subscription
   * - Throw/fail to reject the subscription
   *
   * The returned object is available in the GraphQL context.
   *
   * @example
   * ```typescript
   * onConnect: (request, headers) => Effect.gen(function* () {
   *   const token = headers.get("authorization")
   *   const user = yield* AuthService.validateToken(token)
   *   return { user } // Available in GraphQL context
   * })
   * ```
   */
  readonly onConnect?: (
    request: SSESubscriptionRequest,
    headers: Headers
  ) => Effect.Effect<Record<string, unknown>, unknown, R>

  /**
   * Called when the subscription starts streaming.
   */
  readonly onSubscribe?: (ctx: SSEConnectionContext<R>) => Effect.Effect<void, never, R>

  /**
   * Called when the subscription completes (normally or due to error).
   */
  readonly onComplete?: (ctx: SSEConnectionContext<R>) => Effect.Effect<void, never, R>

  /**
   * Called when the client disconnects.
   */
  readonly onDisconnect?: (ctx: SSEConnectionContext<R>) => Effect.Effect<void, never, R>

  /**
   * Called when an error occurs during subscription execution.
   */
  readonly onError?: (ctx: SSEConnectionContext<R>, error: unknown) => Effect.Effect<void, never, R>
}

/**
 * Configuration for the SSE endpoint
 */
export interface GraphQLSSEConfig {
  /**
   * Path for SSE connections.
   * @default "/graphql/stream"
   */
  readonly path?: string
}

/**
 * Result of SSE subscription handler creation.
 * This is used by platform packages to implement their SSE response.
 */
export interface SSESubscriptionResult {
  /**
   * Stream of SSE events to send to the client.
   * The platform adapter should consume this stream and send events.
   */
  readonly events: Stream.Stream<SSEEvent, SSEError>

  /**
   * Effect that should be run when client disconnects.
   * This allows cleanup of resources.
   */
  readonly cleanup: Effect.Effect<void, never, never>
}

/**
 * Format an ExecutionResult as an SSE "next" event.
 */
export const formatNextEvent = (result: ExecutionResult): SSEEvent => ({
  event: "next",
  data: JSON.stringify(result),
})

/**
 * Format errors as an SSE "error" event.
 */
export const formatErrorEvent = (errors: readonly unknown[]): SSEEvent => ({
  event: "error",
  data: JSON.stringify({ errors }),
})

/**
 * Format a "complete" event.
 */
export const formatCompleteEvent = (): SSEEvent => ({
  event: "complete",
  data: "",
})

/**
 * Format an SSE event to the wire format.
 * Each event is formatted as:
 * ```
 * event: <type>
 * data: <json>
 *
 * ```
 */
export const formatSSEMessage = (event: SSEEvent): string => {
  const lines = [`event: ${event.event}`]
  if (event.data) {
    lines.push(`data: ${event.data}`)
  }
  lines.push("", "") // Two newlines to end the event
  return lines.join("\n")
}
