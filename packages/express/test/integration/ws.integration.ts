import { expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { buildSchema } from "graphql"
import { once } from "node:events"
import { createServer } from "node:http"
import { setImmediate } from "node:timers/promises"
import WebSocket from "ws"
import { attachWebSocket } from "../../src/ws"

const signal = () => {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

it.each([
  { disconnect: false, defect: false },
  { disconnect: true, defect: false },
  { disconnect: true, defect: true },
])(
  "joins connection finalizers on close (natural disconnect: $disconnect, finalizer defect: $defect)",
  async ({ disconnect, defect }) => {
    const finalizing = signal()
    const acquired = signal()
    const release = signal()
    let finalized = false
    const layer = Layer.effectDiscard(
      Effect.acquireRelease(Effect.sync(acquired.resolve), () =>
        Effect.promise(async () => {
          finalizing.resolve()
          await release.promise
          finalized = true
        }).pipe(Effect.andThen(defect ? Effect.die(new Error("finalizer failed")) : Effect.void))
      )
    )
    const server = createServer()
    const adapter = attachWebSocket(server, buildSchema("type Query { hello: String }"), layer)
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected TCP server address")
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/graphql`, "graphql-transport-ws")
    let closing: Promise<void> | undefined
    try {
      await once(socket, "open", { signal: AbortSignal.timeout(5_000) })
      const acknowledged = once(socket, "message", { signal: AbortSignal.timeout(5_000) })
      await acquired.promise
      await setImmediate()
      socket.send(JSON.stringify({ type: "connection_init" }))
      const [message] = await acknowledged
      expect(JSON.parse(message.toString())).toEqual({ type: "connection_ack" })

      const socketClosed = once(socket, "close", { signal: AbortSignal.timeout(5_000) })
      if (disconnect) {
        socket.close(1000, "Client finished")
        await finalizing.promise
      }
      let closed = false
      closing = adapter.close().then(() => {
        closed = true
      })
      await Promise.all([socketClosed, finalizing.promise])
      await setImmediate()
      await setImmediate()
      expect(closed).toBe(false)
      expect(finalized).toBe(false)

      release.resolve()
      await closing
      expect(finalized).toBe(true)
      // Repeated shutdown must join the same completed lifetime, not close wss again.
      await adapter.close()
    } finally {
      release.resolve()
      socket.terminate()
      await (closing ?? adapter.close())
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  }
)
