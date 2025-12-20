import { Effect, Layer } from "effect"
import * as S from "effect/Schema"
import { HttpPlatform, HttpRouter, HttpServer, HttpServerResponse } from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { createServer } from "node:http"
import { GraphQLSchemaBuilder, query, makeGraphQLRouter } from "../src"

// Example schema with a simple query
const schema = GraphQLSchemaBuilder.empty
  .pipe(
    query("hello", {
      type: S.String,
      resolve: () => Effect.succeed("Hello from effect-graphql!"),
    }),
    query("echo", {
      args: S.Struct({ message: S.String }),
      type: S.String,
      resolve: (args) => Effect.succeed(`Echo: ${args.message}`),
    })
  )
  .buildSchema()

// Create the GraphQL router with GraphiQL enabled
const graphqlRouter = makeGraphQLRouter(schema, Layer.empty, {
  path: "/graphql",
  graphiql: {
    path: "/graphiql",
    endpoint: "/graphql",
  },
})

// Build the app with health check and GraphQL routes
const app = HttpRouter.empty
  .pipe(
    HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" })),
    HttpRouter.concat(graphqlRouter),
    Effect.catchAllCause((cause) =>
      HttpServerResponse.json({ error: String(cause) }, { status: 500 })
    ),
    HttpServer.serve()
  )

const listen = (
  appLayer: Layer.Layer<
    never,
    never,
    HttpPlatform.HttpPlatform | HttpServer.HttpServer
  >,
  port: number
) =>
  NodeRuntime.runMain(
    Layer.launch(
      Layer.provide(
        appLayer,
        NodeHttpServer.layer(() => createServer(), { port })
      )
    )
  )

console.log("Starting demo server at http://localhost:11001")
console.log("GraphQL endpoint: http://localhost:11001/graphql")
console.log("GraphiQL UI: http://localhost:11001/graphiql")

listen(app, 11001)
