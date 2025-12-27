# Effect GraphQL

A GraphQL framework for Effect-TS that brings full type safety, composability, and functional programming to your GraphQL servers.

> **Note:** This is an experimental prototype exploring the integration between Effect Schema, Effect's service system, and GraphQL.

## Features

- **Type-Safe End-to-End** - Define schemas once with Effect Schema, get TypeScript types and GraphQL types automatically
- **Effect-Powered Resolvers** - Resolvers are Effect programs with built-in error handling and service injection
- **Immutable Builder** - Fluent, pipe-able API for composing schemas from reusable parts
- **Service Integration** - Use Effect's Layer system for dependency injection

## Installation

```bash
npm install @effect-gql/core effect graphql
```

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

```bash
# Install dependencies
npm install

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
