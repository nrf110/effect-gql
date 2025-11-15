# Effect GraphQL

A GraphQL framework for Effect-TS that brings full type safety, composability, and functional programming to your GraphQL servers.

## Features

- **Type-Safe Resolvers**: Leverage Effect's type system for end-to-end type safety
- **Error Handling**: Structured error handling with Effect's error channel
- **Service Integration**: Seamlessly integrate Effect services into your resolvers
- **Composability**: Build complex resolvers from simple, reusable Effect programs
- **Concurrency**: Utilize Effect's fiber-based concurrency for high-performance APIs
- **Resource Safety**: Automatic resource management with Effect's scope system

## Installation

```bash
npm install effect-graphql effect graphql
```

## Quick Start

```typescript
import { Effect, Layer, Context } from "effect"
import { GraphQLString, GraphQLObjectType } from "graphql"
import { createSchemaBuilder, resolver } from "effect-graphql"

// Define a service
class GreetingService extends Context.Tag("GreetingService")<
  GreetingService,
  { readonly greet: (name: string) => Effect.Effect<string> }
>() {}

const GreetingServiceLive = Layer.succeed(GreetingService, {
  greet: (name: string) => Effect.succeed(`Hello, ${name}!`)
})

// Build schema
const builder = createSchemaBuilder(GreetingServiceLive)

const schema = await builder.build({
  query: {
    greet: {
      type: GraphQLString,
      args: { name: { type: GraphQLString } },
      resolve: resolver(({ name }: { name?: string }) =>
        Effect.gen(function* () {
          const service = yield* GreetingService
          return yield* service.greet(name || "World")
        })
      )
    }
  }
})
```

## Core Concepts

### Effect Resolvers

Resolvers are Effect programs that can access services, handle errors, and compose with other Effects:

```typescript
import { resolver, fieldResolver } from "effect-graphql"

// Simple resolver
const simpleResolver = resolver((args: { id: string }) =>
  Effect.succeed({ id: args.id, name: "Example" })
)

// Resolver with parent value
const fieldResolver = fieldResolver((parent: User, args: {}) =>
  Effect.succeed(parent.email)
)
```

### Service Integration

Use Effect's Context system to inject dependencies:

```typescript
class DatabaseService extends Context.Tag("DatabaseService")<
  DatabaseService,
  { readonly query: (sql: string) => Effect.Effect<any[]> }
>() {}

const resolver = resolver((args) =>
  Effect.gen(function* () {
    const db = yield* DatabaseService
    const results = yield* db.query("SELECT * FROM users")
    return results
  })
)
```

### Error Handling

Use structured errors that integrate with GraphQL's error system:

```typescript
import { ValidationError, NotFoundError } from "effect-graphql"

const resolver = resolver((args: { id: number }) =>
  args.id > 0
    ? Effect.succeed({ id: args.id })
    : Effect.fail(new ValidationError({ message: "ID must be positive" }))
)
```

## Architecture

The framework consists of:

- **Schema Builder**: Converts Effect resolvers to GraphQL schema
- **Resolver System**: Type-safe resolver definitions with Effect integration
- **Error Types**: Structured error classes for common GraphQL errors
- **Server Adapters**: HTTP handlers for Node.js and Bun
- **Context Management**: Request-scoped context with Effect layers

## Example

See `examples/basic-server.ts` for a complete working example with:
- Service definitions
- Query and mutation resolvers
- Error handling
- HTTP server setup

## License

MIT
