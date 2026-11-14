import { expect, it } from "vitest"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:net"
import WebSocket from "ws"

const bunVersion = spawnSync("bun", ["--version"], { encoding: "utf8" })
const [major = 0, minor = 0, patch = 0] = (bunVersion.stdout ?? "").trim().split(".").map(Number)
const supportedBun =
  bunVersion.status === 0 &&
  (major > 1 || (major === 1 && (minor > 4 || (minor === 4 && patch >= 2))))

it.skipIf(!supportedBun)(
  "exits after rejecting a native WebSocket connection",
  async () => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1")
    await once(probe, "listening")
    const address = probe.address()
    const probeClosed = once(probe, "close")
    probe.close()
    await probeClosed
    if (!address || typeof address === "string") throw new Error("Expected TCP address")
    const port = address.port
    const child = spawn(
      "bun",
      [
        "--eval",
        `
        import { Effect, Layer } from "effect"
        import { HttpRouter, HttpServerResponse } from "effect/http"
        import { buildSchema } from "graphql"
        import { serve } from "./src/serve.ts"
        import "graphql-ws"
        const router = HttpRouter.add("GET", "/", HttpServerResponse.text("ok"))
        serve(router, Layer.empty, {
          host: "127.0.0.1", port: ${port},
          subscriptions: {
            schema: buildSchema("type Query { hello: String }"),
            onConnect: () => Effect.succeed(false)
          },
          onStart: () => process.stdout.write("READY\\n")
        })
      `,
      ],
      { cwd: new URL("../../", import.meta.url), stdio: ["ignore", "pipe", "pipe"] }
    )
    let stdout = ""
    let diagnostics = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString()
    })
    const exited = once(child, "exit")
    let socket: WebSocket | undefined
    try {
      const signal = AbortSignal.timeout(5_000)
      while (!stdout.includes("READY")) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Bun server exited before listening: ${diagnostics}`)
        }
        await once(child.stdout, "data", { signal })
      }
      socket = new WebSocket(`ws://127.0.0.1:${port}/graphql`, "graphql-transport-ws")
      const closed = once(socket, "close", { signal: AbortSignal.timeout(5_000) })
      await once(socket, "open", { signal: AbortSignal.timeout(5_000) })
      socket.send(JSON.stringify({ type: "connection_init" }))
      const [closeCode] = await closed
      expect(closeCode).toBe(4403)
      expect(
        await (
          await fetch(`http://127.0.0.1:${port}/`, {
            signal: AbortSignal.timeout(5_000),
          })
        ).text()
      ).toBe("ok")
      const stopped = once(child, "exit", { signal: AbortSignal.timeout(5_000) })
      child.kill("SIGTERM")
      const [code] = await stopped
      expect(code, diagnostics).toBe(130)
    } finally {
      socket?.terminate()
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL")
      }
      await exited
    }
  },
  15_000
)
