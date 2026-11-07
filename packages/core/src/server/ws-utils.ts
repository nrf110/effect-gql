import { type Cause, Effect, Stream, Queue } from "effect"
import type { EffectWebSocket, CloseEvent } from "./ws-types"
import { WebSocketError } from "./ws-types"

/**
 * Interface for the 'ws' library WebSocket.
 * This allows type-safe usage without requiring core to depend on 'ws'.
 */
export interface WsWebSocket {
  readonly protocol: string
  readonly readyState: number
  send(data: string, callback?: (error?: Error) => void): void
  close(code?: number, reason?: string): void
  on(event: "message", listener: (data: Buffer | string) => void): void
  on(event: "error", listener: (error: Error) => void): void
  on(event: "close", listener: (code: number, reason: Buffer) => void): void
  removeListener(event: string, listener: (...args: any[]) => void): void
}

/** WebSocket.CLOSED constant from 'ws' library */
export const WS_CLOSED = 3

/**
 * Convert a WebSocket from the 'ws' library to an EffectWebSocket.
 *
 * This creates an Effect-based wrapper around the ws WebSocket instance,
 * providing a Stream for incoming messages and Effect-based send/close operations.
 *
 * This utility is used by platform packages (node, express) that integrate
 * with the 'ws' library for WebSocket support.
 *
 * @param ws - The WebSocket instance from the 'ws' library
 * @returns An EffectWebSocket that can be used with makeGraphQLWSHandler
 *
 * @example
 * ```typescript
 * import { toEffectWebSocketFromWs } from "@effect-gql/core"
 * import { WebSocket } from "ws"
 *
 * wss.on("connection", (ws: WebSocket) => {
 *   const effectSocket = toEffectWebSocketFromWs(ws)
 *   Effect.runPromise(handler(effectSocket))
 * })
 * ```
 */
export const toEffectWebSocketFromWs = (ws: WsWebSocket): EffectWebSocket => {
  // Create the message stream using a queue
  const messages: Stream.Stream<string, WebSocketError> = Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.make<string, WebSocketError | Cause.Done>()

      const onMessage = (data: Buffer | string) => {
        Effect.runPromise(Queue.offer(queue, data.toString())).catch(() => {
          // The stream may already have finalized.
        })
      }
      const onError = (error: Error) => {
        Effect.runPromise(Queue.fail(queue, new WebSocketError({ cause: error }))).catch(() => {
          // The stream may already have finalized.
        })
      }
      const onClose = () => {
        Effect.runPromise(Queue.end(queue)).catch(() => {
          // The stream may already have finalized.
        })
      }

      ws.on("message", onMessage)
      ws.on("error", onError)
      ws.on("close", onClose)

      return Stream.fromQueue(queue).pipe(
        Stream.ensuring(
          Effect.sync(() => {
            ws.removeListener("message", onMessage)
            ws.removeListener("error", onError)
            ws.removeListener("close", onClose)
          })
        )
      )
    })
  )

  return {
    protocol: ws.protocol || "graphql-transport-ws",

    send: (data: string) =>
      Effect.callback<void, WebSocketError>((resume) => {
        ws.send(data, (error) => {
          if (error) {
            resume(Effect.fail(new WebSocketError({ cause: error })))
          } else {
            resume(Effect.succeed(undefined))
          }
        })
      }),

    close: (code?: number, reason?: string) =>
      Effect.sync(() => {
        ws.close(code ?? 1000, reason ?? "")
      }),

    messages,

    closed: Effect.callback<CloseEvent, WebSocketError>((resume) => {
      if (ws.readyState === WS_CLOSED) {
        resume(Effect.succeed({ code: 1000, reason: "" }))
        return
      }

      const onClose = (code: number, reason: Buffer) => {
        cleanup()
        resume(Effect.succeed({ code, reason: reason.toString() }))
      }

      const onError = (error: Error) => {
        cleanup()
        resume(Effect.fail(new WebSocketError({ cause: error })))
      }

      const cleanup = () => {
        ws.removeListener("close", onClose)
        ws.removeListener("error", onError)
      }

      ws.on("close", onClose)
      ws.on("error", onError)

      return Effect.sync(cleanup)
    }),
  }
}
