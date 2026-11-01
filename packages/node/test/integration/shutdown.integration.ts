import { expect, it } from "vitest"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:net"
import WebSocket from "ws"

it("closes active WebSockets before awaiting HTTP shutdown on SIGTERM", async () => {
  const probe = createServer()
  probe.listen(0, "127.0.0.1")
  await once(probe, "listening")
  const address = probe.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP address")
  const port = address.port
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve()))
  )
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { Layer } from "effect"
    import { HttpRouter, HttpServerResponse } from "effect/http"
    import { buildSchema } from "graphql"
    import { serve } from "./src/serve.ts"
    serve(HttpRouter.add("GET", "/", HttpServerResponse.text("ok")), Layer.empty, {
      host: "127.0.0.1", port: ${port},
      subscriptions: { schema: buildSchema("type Query { hello: String }") },
      onStart: () => process.stdout.write("READY\\n")
    })
  `,
    ],
    { cwd: new URL("../../", import.meta.url), stdio: ["ignore", "pipe", "pipe"] }
  )
  let socket: WebSocket | undefined
  let diagnostics = ""
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString()
  })
  const exited = once(child, "exit")
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("READY")) resolve()
      })
      child.once("error", reject)
      child.once("exit", () => reject(new Error(`Server exited before ready: ${diagnostics}`)))
    })
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok")
    socket = new WebSocket(`ws://127.0.0.1:${port}/graphql`, "graphql-transport-ws")
    await once(socket, "open")
    const closed = once(socket, "close", { signal: AbortSignal.timeout(5_000) })
    child.kill("SIGTERM")
    await closed
    const [code] = await exited
    expect(code, diagnostics).toBe(130)
  } finally {
    socket?.terminate()
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL")
      await exited
    }
  }
}, 10_000)
