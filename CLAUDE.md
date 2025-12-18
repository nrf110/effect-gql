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

### 2. Decorator System (Experimental)

**Files**: `src/decorators/`

The project experiments with two approaches:

**A. TypeScript Decorators** (`@ObjectType`, `@Resolver`, `@Resolve`, `@Arg`, `@Root`)
- Located in `src/decorators/object-type.ts`, `resolver.ts`, `arg.ts`
- Uses `reflect-metadata` for runtime metadata
- `@ObjectType()` - Converts Effect Schema.Class to GraphQL types
- `@Arg()` - Parameter decorator for validated arguments
- Relies on `experimentalDecorators: true` and `emitDecoratorMetadata: true` in tsconfig.json

**B. Builder Pattern** (in progress)
- `src/builder/object-builder.ts` - Fluent API for building GraphQL Object Types
- `src/builder/schema-mapper.ts` - Maps schemas programmatically
- `src/service/builder.ts` - Service integration (work in progress)

Both approaches aim to achieve automatic Effect Schema → GraphQL type derivation with validation.

### 3. Schema Builder

**File**: `src/builder/index.ts`

Singleton `GraphQLSchemaBuilder` that:
- Registers GraphQL types, directives, query/mutation/subscription fields
- Exports global `schemaBuilder` instance used by decorators
- Provides centralized type registry for cross-references (e.g., unions, interfaces)

### 4. Server Integration

**File**: `src/server.ts`

Effect HTTP server using `@effect/platform` and `@effect/platform-node`:
- GraphQL endpoint at `/graphql` (POST)
- GraphiQL IDE at `/_graphiql` (GET)
- `executeQuery()` wraps graphql-js execution in Effect
- Request parsing via `HttpServerRequest.schemaBodyJson()`
- Currently runs on port 11001

### 5. Error System

**File**: `src/error.ts`

Effect-based tagged errors using `Data.TaggedError`:
- `GraphQLError` - Base error with extensions
- `ValidationError` - Input validation failures
- `AuthorizationError` - Access control
- `NotFoundError` - Missing resources

These integrate with Effect's error channel and can be mapped to GraphQL errors.

### 6. Context System

**File**: `src/context.ts`

Request-scoped context using Effect's Context system:
- `GraphQLRequestContext` - Contains headers, query, variables, operationName
- `makeRequestContextLayer()` - Creates Effect Layer for dependency injection

## Key Design Patterns

1. **Effect Schema as Single Source of Truth**: Define data models once with Effect Schema, derive both TypeScript types and GraphQL types
2. **Effect-based Resolvers**: Resolvers return `Effect.Effect<A, E, R>` for composability, error handling, and service access
3. **Service Integration**: Use Effect's Context/Tag system to inject dependencies into resolvers
4. **Validation at the Boundary**: Arguments are validated via Effect Schema before resolver execution
5. **Relational/Computed Fields**: Object types can have additional fields with their own resolvers (parent, args) for relationships

## Current State

This is a **prototype/experimental** codebase. Based on git history:
- Initial commit established basic Effect Schema → GraphQL mapping
- Added support for relational/computed fields with validation
- Currently exploring decorator vs builder pattern approaches
- Server implementation exists but integration with schema builder is incomplete (see TODO in server.ts:53)

The codebase appears to be in active development - some features referenced in README.md may not be fully implemented.

## TypeScript Configuration

- Target: ES2022
- Module: CommonJS
- Decorators enabled (`experimentalDecorators`, `emitDecoratorMetadata`)
- Strict mode enabled
- Output: `./dist`
- Excludes: examples directory (not in repo yet)

## Dependencies

Core:
- `effect` ^3.19.11 - Effect ecosystem
- `@effect/platform` - HTTP abstractions
- `@effect/platform-node` - Node.js runtime
- `graphql` ^16.0.0 - GraphQL execution
- `reflect-metadata` - Decorator metadata

## Notes for Implementation

- When adding GraphQL types, register them with the global `schemaBuilder` to enable cross-references
- Resolver functions should return Effect, not Promises
- Use Effect Schema for all validation - it automatically generates GraphQL types
- The decorator approach requires classes to extend Effect's `Schema.Class`
- Optional fields in Effect Schema remain optional in GraphQL (no automatic NonNull wrapping)
