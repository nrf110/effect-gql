# Pipe-based API Example

This example demonstrates how to use the pipe-based API to compose GraphQL schemas across multiple files, similar to Effect's `HttpLayerRouter`.

## File Structure

```
pipe-api/
├── types.ts          # Domain models (User, Post schemas)
├── services.ts       # Effect services and implementations
├── user-schema.ts    # User type, queries, and mutations
├── post-schema.ts    # Post type and fields
└── index.ts          # Assemble and execute schema
```

## Key Benefits

✅ **Modular** - Split schema definitions across multiple files
✅ **Composable** - Use `pipe` to combine schema pieces
✅ **Familiar** - Same pattern as `HttpLayerRouter`
✅ **Type-safe** - Service requirements accumulate in type parameter

## Usage

### Define Types in Separate Files

**user-schema.ts**:
```typescript
export const userType = objectType("User", UserSchema, {
  posts: {
    type: S.Array(PostSchema),
    resolve: (parent) => /* ... */
  }
})

export const userQueries = [
  query("user", { /* ... */ }),
  query("users", { /* ... */ })
]
```

**post-schema.ts**:
```typescript
export const postType = objectType("Post", PostSchema, {
  author: {
    type: UserSchema,
    resolve: (parent) => /* ... */
  }
})
```

### Assemble Using Pipe

**index.ts**:
```typescript
const builder = GraphQLSchemaBuilder.empty.pipe(
  userType,
  postType,
  compose(...userQueries),    // Use compose for arrays
  compose(...userMutations)
)

const schema = builder.buildSchema()
```

**Note**: Use the `compose` helper to combine multiple operations from an array. This is needed because TypeScript can't properly type-check spread arguments in `pipe`.

## Usage

`GraphQLSchemaBuilder` implements the Effect `Pipeable` interface, so you can use the fluent `.pipe()` syntax:

```typescript
GraphQLSchemaBuilder.empty.pipe(
  objectType("User", UserSchema, { /* fields */ }),
  objectType("Post", PostSchema),
  query("user", { /* ... */ }),
  mutation("createUser", { /* ... */ })
)
```

You can also use method chaining directly:
```typescript
GraphQLSchemaBuilder.empty
  .objectType("User", UserSchema, { /* fields */ })
  .objectType("Post", PostSchema)
  .query("user", { /* ... */ })
  .mutation("createUser", { /* ... */ })
```

## Running the Example

```bash
npm run build
npx tsx examples/pipe-api/index.ts
```
