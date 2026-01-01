/**
 * Full-Featured GraphQL Server Example
 *
 * This example demonstrates a production-ready GraphQL server with:
 * - Domain models with Effect Schema
 * - Service-based architecture with dependency injection
 * - DataLoaders for N+1 query prevention
 * - Authentication and authorization
 * - Error handling with typed errors
 * - Modular code organization
 */

import { Effect, Layer } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerResponse } from "@effect/platform"
import { makeGraphQLRouter } from "@effect-gql/core"
import { serve } from "@effect-gql/node"

import { schema } from "./schema"
import { ServicesLive } from "./services"
import { loaders } from "./loaders"

// =============================================================================
// Application Layer
// =============================================================================

/**
 * Combine all service layers.
 * The loader layer is request-scoped for proper batching/caching.
 * The loaders require services, so we provide ServicesLive to the loader layer.
 */
const LoaderLayer = Layer.provide(loaders.toLayer(), ServicesLive)
const AppLayer = Layer.mergeAll(ServicesLive, LoaderLayer)

// =============================================================================
// HTTP Router
// =============================================================================

const graphqlRouter = makeGraphQLRouter(schema, AppLayer, {
  path: "/graphql",
  graphiql: {
    path: "/graphiql",
    endpoint: "/graphql",
  },
})

/**
 * CORS middleware to allow cross-origin requests.
 * Required for GraphiQL to work properly in browsers.
 */
const cors = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const response = yield* app
    return response.pipe(
      HttpServerResponse.setHeader("Access-Control-Allow-Origin", "*"),
      HttpServerResponse.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
      HttpServerResponse.setHeader("Access-Control-Allow-Headers", "Content-Type")
    )
  })
)

const app = HttpRouter.empty.pipe(
  // Handle OPTIONS preflight requests
  HttpRouter.options(
    "/graphql",
    HttpServerResponse.empty().pipe(
      HttpServerResponse.setStatus(204),
      HttpServerResponse.setHeader("Access-Control-Allow-Origin", "*"),
      HttpServerResponse.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
      HttpServerResponse.setHeader("Access-Control-Allow-Headers", "Content-Type"),
      Effect.orDie
    )
  ),
  HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" })),
  HttpRouter.concat(graphqlRouter),
  cors
)

// =============================================================================
// Server Startup
// =============================================================================

serve(app, Layer.empty, {
  port: 4003,
  onStart: (url: string) => {
    console.log(`🚀 Full-Featured Example Server ready at ${url}`)
    console.log(`📊 GraphQL endpoint: ${url}/graphql`)
    console.log(`🎮 GraphiQL playground: ${url}/graphiql`)
    console.log("")
    console.log("Example queries to try:")
    console.log(`
  # Get current user with their posts
  query {
    me {
      id
      name
      role
      posts {
        title
        published
        commentCount
      }
    }
  }

  # Get all posts with authors and comments
  query {
    posts {
      title
      author {
        name
      }
      comments {
        content
        author {
          name
        }
      }
    }
  }

  # Create a new post (as authenticated user)
  mutation {
    createPost(title: "My New Post", content: "Hello world!") {
      id
      title
      author {
        name
      }
    }
  }
`)
  },
})
