import { expect, it } from "vitest"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { connect, createServer, type Socket } from "node:net"
import WebSocket from "ws"

const startServer = async () => {
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
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { Effect, Layer } from "effect"
    import { setImmediate } from "node:timers/promises"
    import { HttpRouter, HttpServerResponse } from "effect/http"
    import { buildSchema } from "graphql"
    import { serve } from "./src/serve.ts"
    const activeRequest = Effect.acquireRelease(
      Effect.sync(() => process.stdout.write("REQUEST_STARTED\\n")),
      () => Effect.promise(() => setImmediate()).pipe(
        Effect.andThen(Effect.sync(() => process.stdout.write("REQUEST_CLEANED\\n")))
      )
    ).pipe(Effect.andThen(Effect.never), Effect.scoped)
    const router = Layer.mergeAll(
      HttpRouter.add("GET", "/", HttpServerResponse.text("ok")),
      HttpRouter.add("GET", "/active", activeRequest)
    )
    serve(router, Layer.empty, {
      host: "127.0.0.1", port: ${port},
      subscriptions: { schema: buildSchema("type Query { hello: String }") },
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
  const waitForOutput = async (message: string) => {
    const signal = AbortSignal.timeout(5_000)
    while (!stdout.includes(message)) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Server exited before ${message}: ${diagnostics}`)
      }
      await once(child.stdout, "data", { signal })
    }
  }
  return {
    child,
    port,
    waitForOutput,
    output: () => stdout,
    diagnostics: () => diagnostics,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL")
        await exited
      }
    },
  }
}

it("closes active WebSockets and finalizes active Effect requests on SIGTERM", async () => {
  const server = await startServer()
  let socket: WebSocket | undefined
  let request: Socket | undefined
  try {
    await server.waitForOutput("READY")
    expect(
      await (
        await fetch(`http://127.0.0.1:${server.port}/`, {
          signal: AbortSignal.timeout(5_000),
        })
      ).text()
    ).toBe("ok")
    socket = new WebSocket(`ws://127.0.0.1:${server.port}/graphql`, "graphql-transport-ws")
    await once(socket, "open", { signal: AbortSignal.timeout(5_000) })
    request = connect(server.port, "127.0.0.1")
    request.on("error", () => {})
    request.resume()
    await once(request, "connect", { signal: AbortSignal.timeout(5_000) })
    request.write("GET /active HTTP/1.1\r\nHost: localhost\r\n\r\n")
    await server.waitForOutput("REQUEST_STARTED")
    const closed = once(socket, "close", { signal: AbortSignal.timeout(5_000) })
    const exited = once(server.child, "exit", { signal: AbortSignal.timeout(5_000) })
    server.child.kill("SIGTERM")
    const [, [code]] = await Promise.all([closed, exited])
    expect(code, server.diagnostics()).toBe(130)
    expect(server.output()).toContain("REQUEST_CLEANED")
  } finally {
    socket?.terminate()
    request?.destroy()
    await server.stop()
  }
}, 15_000)

it("closes incomplete HTTP headers on SIGTERM without client intervention", async () => {
  const server = await startServer()
  let socket: Socket | undefined
  try {
    await server.waitForOutput("READY")
    socket = connect(server.port, "127.0.0.1")
    socket.on("error", () => {})
    socket.resume()
    await once(socket, "connect", { signal: AbortSignal.timeout(5_000) })
    socket.write("POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n")
    // A completed request confirms the child is serving while the partial peer stays open.
    expect(
      await (
        await fetch(`http://127.0.0.1:${server.port}/`, {
          signal: AbortSignal.timeout(5_000),
        })
      ).text()
    ).toBe("ok")
    const closed = once(socket, "close", { signal: AbortSignal.timeout(5_000) })
    const exited = once(server.child, "exit", { signal: AbortSignal.timeout(5_000) })
    server.child.kill("SIGTERM")
    const [, [code]] = await Promise.all([closed, exited])
    expect(code, server.diagnostics()).toBe(130)
  } finally {
    socket?.destroy()
    await server.stop()
  }
}, 15_000)
