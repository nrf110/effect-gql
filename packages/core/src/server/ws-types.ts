import { Data, Effect, Runtime, Stream } from "effect"
import type { ComplexityConfig, FieldComplexityMap } from "./complexity"

/**
 * Error type for WebSocket operations
 */
export class WebSocketError extends Data.TaggedError("WebSocketError")<{
  readonly cause: unknown
}> {}

/**
 * WebSocket close event information
 */
export interface CloseEvent {
  readonly code: number
  readonly reason: string
}

/**
 * Platform-neutral WebSocket interface using Effect types.
 *
 * This interface abstracts WebSocket operations across different platforms
 * (Node.js ws, Bun built-in, browser WebSocket). Platform packages implement
 * this interface to bridge their specific WebSocket implementations.
 */
export interface EffectWebSocket {
  /**
   * Send a message to the client.
   * Returns an Effect that completes when the message is sent.
   */
  readonly send: (data: string) => Effect.Effect<void, WebSocketError>

  /**
   * Close the WebSocket connection.
   * @param code - Optional close code (default: 1000)
   * @param reason - Optional close reason
   */
  readonly close: (code?: number, reason?: string) => Effect.Effect<void, WebSocketError>

  /**
   * Stream of incoming messages from the client.
   * The stream completes when the connection closes.
   */
  readonly messages: Stream.Stream<string, WebSocketError>

  /**
   * Effect that completes with CloseEvent when the connection closes.
   * Use this to detect client disconnection.
   */
  readonly closed: Effect.Effect<CloseEvent, WebSocketError>

  /**
   * The WebSocket subprotocol negotiated during handshake.
   * For GraphQL subscriptions, this should be "graphql-transport-ws".
   */
  readonly protocol: string
}

/**
 * Context available during a WebSocket connection.
 * This is passed to lifecycle hooks.
 */
export interface ConnectionContext<R> {
  /**
   * The Effect runtime for this connection.
   * Use this to run Effects within the connection scope.
   */
  readonly runtime: Runtime.Runtime<R>

  /**
   * Connection parameters sent by the client during CONNECTION_INIT.
   * Often used for authentication tokens.
   */
  readonly connectionParams: Record<string, unknown>

  /**
   * The underlying WebSocket for this connection.
   */
  readonly socket: EffectWebSocket
}

/**
 * Options for configuring the GraphQL WebSocket handler.
 *
 * @template R - Service requirements for lifecycle hooks
 */
export interface GraphQLWSOptions<R> {
  /**
   * Query complexity limiting configuration.
   * When provided, subscriptions are validated against complexity limits
   * before execution begins.
   */
  readonly complexity?: ComplexityConfig

  /**
   * Field complexity definitions from the schema builder.
   * If using the platform serve() functions with subscriptions config,
   * this is typically passed automatically.
   */
  readonly fieldComplexities?: FieldComplexityMap

  /**
   * Called when a client initiates a connection (CONNECTION_INIT message).
   *
   * Use this for authentication. Return:
   * - `true` to accept the connection
   * - `false` to reject the connection
   * - An object to accept and provide additional context
   *
   * The returned object (or true) is merged into the GraphQL context.
   *
   * @example
   * ```typescript
   * onConnect: (params) => Effect.gen(function* () {
   *   const token = params.authToken as string
   *   const user = yield* AuthService.validateToken(token)
   *   return { user } // Available in GraphQL context
   * })
   * ```
   */
  readonly onConnect?: (
    params: Record<string, unknown>
  ) => Effect.Effect<boolean | Record<string, unknown>, unknown, R>

  /**
   * Called when a client disconnects.
   * Use this for cleanup (e.g., removing user from active connections).
   */
  readonly onDisconnect?: (
    ctx: ConnectionContext<R>
  ) => Effect.Effect<void, never, R>

  /**
   * Called when a client starts a subscription (SUBSCRIBE message).
   * Use this for per-subscription authorization or logging.
   *
   * Note: If complexity validation is enabled, it runs before this hook.
   * Throw an error to reject the subscription.
   */
  readonly onSubscribe?: (
    ctx: ConnectionContext<R>,
    message: SubscribeMessage
  ) => Effect.Effect<void, unknown, R>

  /**
   * Called when a subscription completes or is stopped.
   */
  readonly onComplete?: (
    ctx: ConnectionContext<R>,
    message: CompleteMessage
  ) => Effect.Effect<void, never, R>

  /**
   * Called when an error occurs during subscription execution.
   */
  readonly onError?: (
    ctx: ConnectionContext<R>,
    error: unknown
  ) => Effect.Effect<void, never, R>
}

/**
 * GraphQL WebSocket SUBSCRIBE message payload
 */
export interface SubscribeMessage {
  readonly id: string
  readonly payload: {
    readonly query: string
    readonly variables?: Record<string, unknown>
    readonly operationName?: string
    readonly extensions?: Record<string, unknown>
  }
}

/**
 * GraphQL WebSocket COMPLETE message payload
 */
export interface CompleteMessage {
  readonly id: string
}

/**
 * Configuration for the WebSocket endpoint
 */
export interface GraphQLWSConfig {
  /**
   * Path for WebSocket connections.
   * @default "/graphql"
   */
  readonly path?: string

  /**
   * How long to wait for CONNECTION_INIT message before closing.
   * @default 5000 (5 seconds)
   */
  readonly connectionInitWaitTimeout?: number
}
