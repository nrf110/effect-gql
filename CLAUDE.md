# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A GraphQL framework for Effect-TS that brings full type safety, composability, and functional programming to GraphQL servers. This is an experimental prototype exploring integration between Effect Schema, Effect's service system, and GraphQL.

## Development Commands

```bash
# Build the project
npm run build

# Development mode with watch
npm run dev

# Run tests
npm test
```

## Core Architecture

### 1. Schema Mapping System

**File**: `src/schema-mapping.ts`

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

**File**: `src/builder/schema-builder.ts`

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

**File**: `src/builder/pipe-api.ts`

Provides standalone functions for use with `.pipe()`:
```typescript
GraphQLSchemaBuilder.empty.pipe(
  query("hello", { type: S.String, resolve: () => Effect.succeed("world") }),
  objectType({ name: "User", schema: UserSchema }),
  field("User", "posts", { type: S.Array(PostSchema), resolve: ... })
)
```

### 4. Type Registry System

**File**: `src/builder/type-registry.ts`

Handles type resolution during schema building:
- `toGraphQLTypeWithRegistry()` - Checks registered types before falling back to default conversion
- Supports circular type references via lazy field builders
- Matches Effect Schema unions to registered GraphQL enums/unions
- Extracts type names from TaggedStruct `_tag` literals or Schema identifier annotations

### 5. Field Builders

**File**: `src/builder/field-builders.ts`

Builds GraphQL field configs from registrations:
- `buildField()` - Query/mutation fields
- `buildObjectField()` - Object type fields (receives parent)
- `buildSubscriptionField()` - Subscription fields with Stream → AsyncIterator conversion
- `applyDirectives()` - Wraps resolver Effects with directive transformers

### 6. Execution

**File**: `src/builder/execute.ts`

Layer-per-request execution model:
```typescript
const result = await Effect.runPromise(
  execute(schema, serviceLayer)(source, variables, operationName)
)
```
Creates an Effect runtime from the provided layer and passes it to resolvers via GraphQL context.

### 7. DataLoader Integration

**File**: `src/loader.ts`

Type-safe DataLoader helpers using Effect services:
- `Loader.single()` - One key → one value (e.g., user by ID)
- `Loader.grouped()` - One key → many values (e.g., posts by author ID)
- `Loader.define()` - Creates a `LoaderRegistry` with:
  - `toLayer()` - Request-scoped Layer for fresh DataLoader instances
  - `load()` / `loadMany()` - Effect-based loading in resolvers

### 8. Error System

**File**: `src/error.ts`

Effect-based tagged errors using `Data.TaggedError`:
- `GraphQLError` - Base error with extensions
- `ValidationError` - Input validation failures
- `AuthorizationError` - Access control
- `NotFoundError` - Missing resources

### 9. Context System

**File**: `src/context.ts`

Request-scoped context using Effect's Context:
- `GraphQLRequestContext` - Contains headers, query, variables, operationName
- `makeRequestContextLayer()` - Creates Layer for dependency injection

## Key Design Patterns

1. **Effect Schema as Single Source of Truth**: Define data models once with Effect Schema, derive both TypeScript types and GraphQL types
2. **Immutable Builder**: Each builder method returns a new instance, enabling safe composition
3. **Type Parameter Accumulation**: Service requirements `R` accumulate as resolvers are added
4. **Effect-based Resolvers**: Resolvers return `Effect.Effect<A, E, R>` for composability
5. **Layer-per-Request**: Build schema once, execute each request with its own service Layer
6. **Lazy Type Resolution**: Object type fields use thunks to support circular references

## TypeScript Configuration

- Target: ES2022, Module: CommonJS
- Decorators enabled (`experimentalDecorators`, `emitDecoratorMetadata`)
- Strict mode enabled

## Dependencies

Core:
- `effect` - Effect ecosystem
- `@effect/platform` / `@effect/platform-node` - HTTP server
- `graphql` - GraphQL execution
- `dataloader` - Batching/caching for resolvers
- `reflect-metadata` - Decorator metadata
