import { Effect } from "effect"
import { graphql, GraphQLSchema } from "graphql"
import type { IncomingMessage, ServerResponse } from "http"

/**
 * GraphQL request payload
 */
export interface GraphQLRequest {
  query: string
  variables?: Record<string, unknown>
  operationName?: string
}

/**
 * Execute a GraphQL query with Effect integration
 */
export const executeQuery = (
  schema: GraphQLSchema,
  request: GraphQLRequest,
  contextValue?: unknown
): Effect.Effect<unknown, Error> =>
  Effect.tryPromise({
    try: () =>
      graphql({
        schema,
        source: request.query,
        variableValues: request.variables,
        operationName: request.operationName,
        contextValue,
      }),
    catch: (error) => new Error(String(error)),
  })

/**
 * Create a simple HTTP handler for Node.js/Bun
 */
export const createHttpHandler = (
  schema: GraphQLSchema
) => {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Method not allowed" }))
      return
    }

    let body = ""
    req.on("data", (chunk) => {
      body += chunk.toString()
    })

    req.on("end", async () => {
      try {
        const request: GraphQLRequest = JSON.parse(body)
        
        const result = await Effect.runPromise(
          executeQuery(schema, request)
        )

        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(result))
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : "Bad request",
          })
        )
      }
    })
  }
}
