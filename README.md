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

### Effect Schema Integration

Define your types once with Effect Schema and derive both TypeScript types and GraphQL types:

```typescript
import { Schema as S } from "effect"
import { toGraphQLObjectType, field } from "effect-graphql"

// Define schema with validation
const UserSchema = S.Struct({
  id: S.Number,
  name: S.String.pipe(S.minLength(1), S.maxLength(100)),
  email: S.String.pipe(S.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
})

// Derive TypeScript type
type User = S.Schema.Type<typeof UserSchema>

// Derive GraphQL type
const UserType = toGraphQLObjectType("User", UserSchema)

// Define validated arguments
const CreateUserArgsSchema = S.Struct({
  name: S.String.pipe(S.minLength(1)),
  email: S.String.pipe(S.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
})

// Use in resolver with automatic validation
const createUserField = field({
  type: UserType,
  argsSchema: CreateUserArgsSchema,
  resolve: ({ name, email }) => 
    Effect.gen(function* () {
      // Arguments are already validated!
      const service = yield* UserService
      return yield* service.createUser(name, email)
    })
})
```

This approach gives you:
- Single source of truth for your data models
- Automatic argument validation before resolver execution
- Type safety across your entire stack
- Rich validation rules (patterns, ranges, custom validators)
- No manual GraphQL type definitions

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

### Relational Fields

Use `objectType()` to create types with computed/relational fields that have their own resolvers:

```typescript
import { objectType } from "effect-graphql"

// Create User type with a relational orders field
const UserTypeBuilder = objectType<User, AppLayer>("User", UserSchema)
  .field("orders", {
    type: new GraphQLList(OrderType),
    argsSchema: S.Struct({
      startDate: S.optional(S.String),
      endDate: S.optional(S.String),
    }),
    resolve: (parent, args) =>
      Effect.gen(function* () {
        const orderService = yield* OrderService
        return yield* orderService.getOrdersForUser(
          parent.id,
          args.startDate,
          args.endDate
        )
      })
  })

// Register with schema builder to get runtime
builder.registerObjectType(UserTypeBuilder)
const UserType = UserTypeBuilder.build()
```

This enables:
- Field-level resolvers with access to parent object
- Arguments on nested fields (e.g., filtering, pagination)
- Full Effect integration with services and error handling
- Type-safe parent and argument types

## Examples

- `examples/basic-server.ts` - Basic queries and mutations with validation
- `examples/schema-validation.ts` - Advanced validation with Effect Schema
- `examples/relational-fields.ts` - Relational fields with arguments (User → Orders)

## License

MIT
