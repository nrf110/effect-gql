# Effect GraphQL

A GraphQL framework for Effect-TS that brings full type safety, composability, and functional programming to your GraphQL servers.

> **Note:** This is an experimental prototype exploring the integration between Effect Schema, Effect's service system, and GraphQL.

## Features

- **Type-Safe End-to-End** - Define schemas once with Effect Schema, get TypeScript types and GraphQL types automatically
- **Effect-Powered Resolvers** - Resolvers are Effect programs with built-in error handling and service injection
- **Immutable Builder** - Fluent, pipe-able API for composing schemas from reusable parts
- **Service Integration** - Use Effect's Layer system for dependency injection

## Getting Started

The easiest way to get started is with the CLI:

```bash
# Create a new project
npx @effect-gql/cli create my-api --server-type node

# Start the dev server
cd my-api
npm run dev
```

Your GraphQL server will be running at http://localhost:4000/graphql with a GraphiQL playground at http://localhost:4000/graphiql.

### Server Types

The CLI supports multiple server runtimes:

| Type | Command | Best For |
|------|---------|----------|
| Node.js | `--server-type node` | General Node.js deployments |
| Bun | `--server-type bun` | Bun runtime with native WebSocket support |
| Express | `--server-type express` | Integrating into existing Express apps |
| Web | `--server-type web` | Cloudflare Workers, Deno, edge runtimes |

## Manual Installation

```bash
npm install @effect-gql/core effect@^4.1.1 graphql
```

Effect GraphQL targets stable Effect **4.1.1**. Platform integrations use the
matching `@effect/platform-node` or `@effect/platform-bun` **4.1.1** release.
HTTP APIs are included in `effect/http`; do not install `@effect/platform`.
Node.js deployments require **Node.js 22.19.0 or later**, matching the runtime
requirement of `@effect/platform-node` 4.1.1.


### Migrating from Effect 3

- Define service classes with `Context.Service<Self, Shape>()("Name")`.
- Use `Schema.Literals([...])` for multiple literals and
  `Schema.String.check(Schema.isMinLength(1))` for refinements.
- `makeGraphQLRouter` and `toRouter` return route-registration layers. Combine
  them with `Layer.mergeAll` and `HttpRouter.add`, then pass the layer to `serve`
  or `toHandler`.
- Resolver and subscription contexts carry `services: Context.Context<R>`,
  not a runtime. Acquire services with `Effect.context<R>()` and run Effects
  with `Effect.runPromiseWith(services)(effect)`. Keep request scopes open until
  execution or stream consumption finishes.

## Quick Start

```typescript
import { Effect, Layer } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder, execute } from "@effect-gql/core"

// Define your schema with Effect Schema
const UserSchema = S.Struct({
  id: S.String,
  name: S.String,
  email: S.String,
})

// Build your GraphQL schema
const schema = GraphQLSchemaBuilder.empty
  .objectType({ name: "User", schema: UserSchema })
  .query("users", {
    type: S.Array(UserSchema),
    resolve: () => Effect.succeed([
      { id: "1", name: "Alice", email: "alice@example.com" },
      { id: "2", name: "Bob", email: "bob@example.com" },
    ]),
  })
  .query("user", {
    type: UserSchema,
    args: S.Struct({ id: S.String }),
    resolve: (args) => Effect.succeed({
      id: args.id,
      name: "Alice",
      email: "alice@example.com",
    }),
  })
  .buildSchema()

// Execute a query
const result = await Effect.runPromise(
  execute(schema, Layer.empty)(`
    query {
      users { id name email }
    }
  `)
)
```

## Documentation

For full documentation, guides, and API reference, visit the [documentation site](https://nrf110.github.io/effect-gql/).

## Development

Install workspace dependencies with pnpm using the version in `packageManager`.
`pnpm-lock.yaml` is the workspace lockfile; npm remains supported for running scripts.

```bash
# Install dependencies
pnpm install

# Build the project
npm run build

# Run tests
npm test

# Development mode with watch
npm run dev
```

## Contributing

Contributions are welcome! Here's how you can help:

1. **Report bugs** - Open an issue describing the problem and steps to reproduce
2. **Suggest features** - Open an issue describing your idea
3. **Submit PRs** - Fork the repo, make your changes, and open a pull request

Please ensure your code:
- Passes all existing tests (`npm test`)
- Includes tests for new functionality
- Follows the existing code style

## License

MIT
