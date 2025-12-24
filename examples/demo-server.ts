import { Effect, Layer } from "effect"
import * as S from "effect/Schema"
import { HttpRouter, HttpServerResponse } from "@effect/platform"
import { GraphQLSchemaBuilder, query, makeGraphQLRouter } from "@effect-gql/core"
import { serve } from "@effect-gql/node"

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
const app = HttpRouter.empty.pipe(
  HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" })),
  HttpRouter.concat(graphqlRouter)
)

// Start the server using the new simplified API
serve(app, Layer.empty, {
  port: 11001,
  onStart: (url: string) => {
    console.log(`Starting demo server at ${url}`)
    console.log(`GraphQL endpoint: ${url}/graphql`)
    console.log(`GraphiQL UI: ${url}/graphiql`)
  },
})
