# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A GraphQL framework for Effect-TS that brings full type safety, composability, and functional programming to GraphQL servers. This is an experimental prototype exploring integration between Effect Schema, Effect's service system, and GraphQL.

## Monorepo Structure

This is a multi-package monorepo using npm workspaces:

```
effect-graphql/
├── packages/
│   ├── core/           # @effect-gql/core - Core library
│   │   ├── src/
│   │   │   ├── builder/        # Schema builder system
│   │   │   ├── server/         # HTTP router and server utilities
│   │   │   ├── schema-mapping.ts
│   │   │   ├── context.ts
│   │   │   ├── error.ts
│   │   │   ├── loader.ts
│   │   │   └── resolver-context.ts
│   │   └── test/
│   ├── node/           # @effect-gql/node - Node.js server integration
│   │   ├── src/
│   │   │   ├── serve.ts        # serve() entry point
│   │   │   └── ws.ts           # WebSocket subscriptions
│   │   └── test/
│   ├── bun/            # @effect-gql/bun - Bun server integration
│   │   └── src/
│   │       ├── serve.ts        # serve() entry point
│   │       └── ws.ts           # Bun-native WebSocket subscriptions
│   ├── express/        # @effect-gql/express - Express middleware
│   │   └── src/
│   │       ├── middleware.ts   # toMiddleware()
│   │       └── ws.ts           # WebSocket subscriptions
│   └── web/            # @effect-gql/web - Web standard handler
│       └── src/
│           └── handler.ts      # toHandler() for Workers/Deno
├── examples/           # Example code
├── docs/               # Documentation site
└── package.json        # Workspace root
```

## Development Commands

```bash
# Build all packages
npm run build

# Run all tests
npm test

# Build a specific package
npm run build -w @effect-gql/core
npm run build -w @effect-gql/node
```

## Core Architecture

### 1. Schema Mapping System

**File**: `packages/core/src/schema-mapping.ts`

Converts Effect Schema AST to GraphQL types. Key functions:
- `toGraphQLType()` - Effect Schema → GraphQL output types
- `toGraphQLInputType()` - Effect Schema → GraphQL input types
- `toGraphQLObjectType()` - Create GraphQL Object Type with optional computed/relational fields
- `toGraphQLArgs()` - Effect Schema → GraphQL arguments

The mapping traverses Effect's SchemaAST and handles:
- Primitives (String, Number, Boolean)
- Structs (TypeLiteral) → GraphQL Object Types
- Arrays (TupleType) → GraphQL Lists
- Optional fields (maintained vs NonNull wrapping)
- Transformations (uses "to" for output, "from" for input)
- Unions (currently uses first type as fallback)

### 2. Schema Builder

**File**: `packages/core/src/builder/schema-builder.ts`

The `GraphQLSchemaBuilder` is an immutable, pipeable builder for constructing GraphQL schemas:
- Implements `Pipeable.Pipeable` for fluent `.pipe()` syntax
- Accumulates service requirements via type parameter `R`
- Static `GraphQLSchemaBuilder.empty` creates a fresh builder
- Each method returns a new builder instance (immutability)

Key registration methods:
- `query()` / `mutation()` / `subscription()` - Root operation fields
- `objectType()` / `interfaceType()` / `enumType()` / `unionType()` / `inputType()` - Type definitions
- `directive()` - Custom directives with optional Effect transformers
- `field()` - Add computed/relational fields to object types

Type name inference: Automatically extracts names from `S.TaggedStruct`, `S.TaggedClass`, or `S.Class`. Plain structs require explicit `name` parameter.

### 3. Pipe-able API

**File**: `packages/core/src/builder/pipe-api.ts`

Provides standalone functions for use with `.pipe()`:
```typescript
GraphQLSchemaBuilder.empty.pipe(
  query("hello", { type: S.String, resolve: () => Effect.succeed("world") }),
  objectType({ name: "User", schema: UserSchema }),
  field("User", "posts", { type: S.Array(PostSchema), resolve: ... })
)
```

### 4. Type Registry System

**File**: `packages/core/src/builder/type-registry.ts`

Handles type resolution during schema building:
- `toGraphQLTypeWithRegistry()` - Checks registered types before falling back to default conversion
- Supports circular type references via lazy field builders
- Matches Effect Schema unions to registered GraphQL enums/unions
- Extracts type names from TaggedStruct `_tag` literals or Schema identifier annotations

### 5. Field Builders

**File**: `packages/core/src/builder/field-builders.ts`

Builds GraphQL field configs from registrations:
- `buildField()` - Query/mutation fields
- `buildObjectField()` - Object type fields (receives parent)
- `buildSubscriptionField()` - Subscription fields with Stream → AsyncIterator conversion
- `applyDirectives()` - Wraps resolver Effects with directive transformers

### 6. Execution

**File**: `packages/core/src/builder/execute.ts`

Layer-per-request execution model:
```typescript
const result = await Effect.runPromise(
  execute(schema, serviceLayer)(source, variables, operationName)
)
```
Creates an Effect runtime from the provided layer and passes it to resolvers via GraphQL context.

### 7. DataLoader Integration

**File**: `packages/core/src/loader.ts`

Type-safe DataLoader helpers using Effect services:
- `Loader.single()` - One key → one value (e.g., user by ID)
- `Loader.grouped()` - One key → many values (e.g., posts by author ID)
- `Loader.define()` - Creates a `LoaderRegistry` with:
  - `toLayer()` - Request-scoped Layer for fresh DataLoader instances
  - `load()` / `loadMany()` - Effect-based loading in resolvers

### 8. Error System

**File**: `packages/core/src/error.ts`

Effect-based tagged errors using `Data.TaggedError`:
- `GraphQLError` - Base error with extensions
- `ValidationError` - Input validation failures
- `AuthorizationError` - Access control
- `NotFoundError` - Missing resources

### 9. Context System

**File**: `packages/core/src/context.ts`

Request-scoped context using Effect's Context:
- `GraphQLRequestContext` - Contains headers, query, variables, operationName
- `makeRequestContextLayer()` - Creates Layer for dependency injection

### 10. Server Integration

The core package provides platform-agnostic HTTP utilities, while platform-specific packages provide runtime integration.

**Core Server Module** (`@effect-gql/core/server`):
- `makeGraphQLRouter()` - Creates an HttpRouter configured for GraphQL
- `toRouter()` - Converts a GraphQLSchemaBuilder to an HttpRouter
- `GraphQLRouterConfigFromEnv` - Effect Config for environment-based configuration
- `graphiqlHtml()` - CDN-based GraphiQL UI generator

**@effect-gql/node** - Node.js server:
- `serve()` - Start a Node.js HTTP server with optional WebSocket subscriptions
- Uses `@effect/platform-node` and `ws` for WebSocket support

**@effect-gql/bun** - Bun server:
- `serve()` - Start a Bun server with native WebSocket support
- Uses `@effect/platform-bun` and Bun's built-in WebSocket API

**@effect-gql/express** - Express middleware:
- `toMiddleware()` - Convert an HttpRouter to Express-compatible middleware
- Integrates with existing Express applications

**@effect-gql/web** - Web standard handler:
- `toHandler()` - Create a web standard Request/Response handler
- For Cloudflare Workers, Deno, and other WASM-based runtimes

## Key Design Patterns

1. **Effect Schema as Single Source of Truth**: Define data models once with Effect Schema, derive both TypeScript types and GraphQL types
2. **Immutable Builder**: Each builder method returns a new instance, enabling safe composition
3. **Type Parameter Accumulation**: Service requirements `R` accumulate as resolvers are added
4. **Effect-based Resolvers**: Resolvers return `Effect.Effect<A, E, R>` for composability
5. **Layer-per-Request**: Build schema once, execute each request with its own service Layer
6. **Lazy Type Resolution**: Object type fields use thunks to support circular references

## Coding Conventions

### Logging

Use Effect's logger instead of `console.log`/`console.error`. This ensures logs integrate with Effect's structured logging infrastructure.

**Within Effect context:**
```typescript
Effect.logError("Something went wrong", error)
Effect.logWarning("Deprecation notice")
Effect.logInfo("Processing request")
Effect.logDebug("Debug details", { key: value })
```

**When handling errors in Effect pipelines:**
```typescript
// Preferred: Handle errors inside the Effect before running
Effect.runPromise(
  myEffect.pipe(
    Effect.catchAll((error) => Effect.logError("Operation failed", error))
  )
)

// Avoid: Breaking out of Effect context
Effect.runPromise(myEffect).catch((error) => {
  console.error("Operation failed:", error)  // ❌
})
```

**For dynamic imports or async operations:**
```typescript
const importModule = Effect.tryPromise({
  try: () => import("./module"),
  catch: (error) => error as Error
})

Effect.runPromise(
  importModule.pipe(
    Effect.catchAll((error) =>
      Effect.logError("Failed to load module", error).pipe(
        Effect.andThen(Effect.sync(() => process.exit(1)))
      )
    )
  )
)
```

## TypeScript Configuration

- Target: ES2022, Module: CommonJS
- Decorators enabled (`experimentalDecorators`, `emitDecoratorMetadata`)
- Strict mode enabled

## Dependencies

### @effect-gql/core
- `effect` (peer) - Effect ecosystem
- `graphql` (peer) - GraphQL execution
- `dataloader` - Batching/caching for resolvers
- `reflect-metadata` - Decorator metadata

### @effect-gql/node
- `@effect-gql/core` (peer) - Core library
- `@effect/platform` (peer) - HTTP abstractions
- `@effect/platform-node` (peer) - Node.js HTTP server
- `effect` (peer) - Effect ecosystem
- `graphql` (peer) - GraphQL execution
- `ws` (optional) - WebSocket support for subscriptions

### @effect-gql/bun
- `@effect-gql/core` (peer) - Core library
- `@effect/platform` (peer) - HTTP abstractions
- `@effect/platform-bun` (peer) - Bun HTTP server
- `effect` (peer) - Effect ecosystem
- `graphql` (peer) - GraphQL execution

### @effect-gql/express
- `@effect-gql/core` (peer) - Core library
- `@effect/platform` (peer) - HTTP abstractions
- `effect` (peer) - Effect ecosystem
- `express` (peer) - Express framework

### @effect-gql/web
- `@effect-gql/core` (peer) - Core library
- `@effect/platform` (peer) - HTTP abstractions
- `effect` (peer) - Effect ecosystem
