import { Effect, Layer } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder, execute } from "@effect-gql/core"

/**
 * Example: GraphQL Interface Types
 *
 * This demonstrates how to define GraphQL interfaces using Effect Schema.
 * Interfaces allow multiple types to share common fields and be queried
 * polymorphically.
 *
 * Key concepts:
 * - Use `interfaceType()` to define an interface with its fields
 * - Use `objectType()` with `{ implements: ["InterfaceName"] }` to implement
 * - Type resolution uses `_tag` by default (Effect's standard discriminator)
 */

// ============================================================================
// Domain Models - Using Effect's TaggedStruct for _tag discriminator
// ============================================================================

/**
 * Base schema for the Node interface - all nodes have an ID
 */
const NodeSchema = S.Struct({
  id: S.String,
})

/**
 * User type - implements Node
 * Uses TaggedStruct so _tag is automatically "User"
 */
const UserSchema = S.TaggedStruct("User", {
  id: S.String,
  name: S.String,
  email: S.String,
})

type User = S.Schema.Type<typeof UserSchema>

/**
 * Post type - implements Node
 * Uses TaggedStruct so _tag is automatically "Post"
 */
const PostSchema = S.TaggedStruct("Post", {
  id: S.String,
  title: S.String,
  content: S.String,
  authorId: S.String,
})

type Post = S.Schema.Type<typeof PostSchema>

/**
 * Comment type - implements Node
 */
const CommentSchema = S.TaggedStruct("Comment", {
  id: S.String,
  text: S.String,
  postId: S.String,
})

type Comment = S.Schema.Type<typeof CommentSchema>

// Type for any node (union of all implementing types)
type Node = User | Post | Comment

// ============================================================================
// Mock Data
// ============================================================================

const users: User[] = [
  { _tag: "User", id: "user-1", name: "Alice", email: "alice@example.com" },
  { _tag: "User", id: "user-2", name: "Bob", email: "bob@example.com" },
]

const posts: Post[] = [
  { _tag: "Post", id: "post-1", title: "Hello World", content: "My first post", authorId: "user-1" },
  { _tag: "Post", id: "post-2", title: "GraphQL is Great", content: "Interfaces are cool", authorId: "user-1" },
  { _tag: "Post", id: "post-3", title: "Effect + GraphQL", content: "Type safety FTW", authorId: "user-2" },
]

const comments: Comment[] = [
  { _tag: "Comment", id: "comment-1", text: "Great post!", postId: "post-1" },
  { _tag: "Comment", id: "comment-2", text: "I agree!", postId: "post-1" },
]

// All nodes in one list for polymorphic queries
const allNodes: Node[] = [...users, ...posts, ...comments]

// ============================================================================
// GraphQL Schema
// ============================================================================

const builder = GraphQLSchemaBuilder.empty
  // Define the Node interface
  // resolveType defaults to (value) => value._tag
  .interfaceType({ name: "Node", schema: NodeSchema })

  // User implements Node
  .objectType({ name: "User", schema: UserSchema, implements: ["Node"] })

  // Post implements Node, with computed author field
  .objectType({
    name: "Post",
    schema: PostSchema,
    implements: ["Node"],
    fields: {
      author: {
        type: UserSchema,
        description: "The author of this post",
        resolve: (parent: Post) =>
          Effect.sync(() => users.find((u) => u.id === parent.authorId)!),
      },
    },
  })

  // Comment implements Node
  .objectType({ name: "Comment", schema: CommentSchema, implements: ["Node"] })

  // Query: Get a node by ID (returns interface type)
  .query("node", {
    type: NodeSchema,
    args: S.Struct({ id: S.String }),
    description: "Get any node by ID",
    resolve: (args: { id: string }) =>
      Effect.sync(() => allNodes.find((n) => n.id === args.id)!),
  })

  // Query: Get all nodes (returns array of interface type)
  .query("nodes", {
    type: S.Array(NodeSchema),
    description: "Get all nodes",
    resolve: () => Effect.sync(() => [...allNodes]),
  })

  // Query: Get all users
  .query("users", {
    type: S.Array(UserSchema),
    description: "Get all users",
    resolve: () => Effect.sync(() => [...users]),
  })

  // Query: Get all posts
  .query("posts", {
    type: S.Array(PostSchema),
    description: "Get all posts",
    resolve: () => Effect.sync(() => [...posts]),
  })

const schema = builder.buildSchema()

console.log("Schema built successfully with interface types")

// ============================================================================
// Execute Example Queries
// ============================================================================

const runExample = Effect.gen(function* () {
  const layer = Layer.empty

  // Example 1: Query a specific node by ID
  console.log("\n=== Example 1: Query Node by ID ===")
  console.log("Query a User node:")

  const result1 = yield* execute(schema, layer)(
    `
      query {
        node(id: "user-1") {
          id
          ... on User {
            name
            email
          }
        }
      }
    `
  )
  console.log(JSON.stringify(result1, null, 2))

  // Example 2: Query a Post node with inline fragment
  console.log("\n=== Example 2: Query Post Node ===")

  const result2 = yield* execute(schema, layer)(
    `
      query {
        node(id: "post-1") {
          id
          ... on Post {
            title
            content
            author {
              name
            }
          }
        }
      }
    `
  )
  console.log(JSON.stringify(result2, null, 2))

  // Example 3: Query all nodes with __typename
  console.log("\n=== Example 3: All Nodes with __typename ===")

  const result3 = yield* execute(schema, layer)(
    `
      query {
        nodes {
          __typename
          id
          ... on User {
            name
          }
          ... on Post {
            title
          }
          ... on Comment {
            text
          }
        }
      }
    `
  )
  console.log(JSON.stringify(result3, null, 2))

  // Example 4: Use named fragments
  console.log("\n=== Example 4: Named Fragments ===")

  const result4 = yield* execute(schema, layer)(
    `
      query {
        nodes {
          ...NodeFields
        }
      }

      fragment NodeFields on Node {
        id
        ... on User {
          name
          email
        }
        ... on Post {
          title
        }
        ... on Comment {
          text
        }
      }
    `
  )
  console.log(JSON.stringify(result4, null, 2))
})

Effect.runPromise(runExample).catch(console.error)
