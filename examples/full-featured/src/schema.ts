/**
 * GraphQL Schema
 *
 * Compose the GraphQL schema using Effect GQL's pipe API.
 * This file brings together domain models, services, and loaders.
 */

import { Effect } from "effect"
import * as S from "effect/Schema"
import {
  GraphQLSchemaBuilder,
  query,
  mutation,
  objectType,
  enumType,
  field,
} from "@effect-gql/core"

import { User, Post, Comment, CreateUserInput, CreatePostInput } from "./domain"
import { AuthService, UserService, PostService, CommentService } from "./services"
import { loaders } from "./loaders"

// =============================================================================
// Build the Schema
// =============================================================================

// Define types
const schemaWithTypes = GraphQLSchemaBuilder.empty
  .pipe(
    enumType({
      name: "UserRole",
      values: ["ADMIN", "USER", "GUEST"],
      description: "The role of a user in the system",
    }),

    objectType({
      name: "User",
      schema: User,
      description: "A user in the system",
    }),

    objectType({
      name: "Post",
      schema: Post,
      description: "A blog post",
    }),

    objectType({
      name: "Comment",
      schema: Comment,
      description: "A comment on a post",
    })
  )

// Add computed fields
const schemaWithFields = schemaWithTypes
  .pipe(
    field("User", "posts", {
      type: S.Array(Post),
      description: "All posts written by this user",
      resolve: (parent: S.Schema.Type<typeof User>) =>
        loaders.load("PostsByAuthorId", parent.id),
    }),

    field("User", "postCount", {
      type: S.Number,
      description: "Number of posts written by this user",
      resolve: (parent: S.Schema.Type<typeof User>) =>
        loaders.load("PostsByAuthorId", parent.id).pipe(
          Effect.map((posts) => posts.length)
        ),
    }),

    field("Post", "author", {
      type: User,
      description: "The author of this post",
      resolve: (parent: S.Schema.Type<typeof Post>) =>
        loaders.load("UserById", parent.authorId),
    }),

    field("Post", "comments", {
      type: S.Array(Comment),
      description: "Comments on this post",
      resolve: (parent: S.Schema.Type<typeof Post>) =>
        loaders.load("CommentsByPostId", parent.id),
    }),

    field("Post", "commentCount", {
      type: S.Number,
      description: "Number of comments on this post",
      resolve: (parent: S.Schema.Type<typeof Post>) =>
        loaders.load("CommentsByPostId", parent.id).pipe(
          Effect.map((comments) => comments.length)
        ),
    }),

    field("Comment", "author", {
      type: User,
      description: "The author of this comment",
      resolve: (parent: S.Schema.Type<typeof Comment>) =>
        loaders.load("UserById", parent.authorId),
    }),

    field("Comment", "post", {
      type: Post,
      description: "The post this comment belongs to",
      resolve: (parent: S.Schema.Type<typeof Comment>) =>
        Effect.gen(function* () {
          const postService = yield* PostService
          return yield* postService.findById(parent.postId)
        }),
    })
  )

// Add queries
const schemaWithQueries = schemaWithFields
  .pipe(
    query("me", {
      type: S.NullOr(User),
      description: "Get the currently authenticated user",
      resolve: () =>
        Effect.gen(function* () {
          const auth = yield* AuthService
          return yield* auth.getCurrentUser()
        }),
    }),

    query("users", {
      type: S.Array(User),
      description: "Get all users",
      resolve: () =>
        Effect.gen(function* () {
          const userService = yield* UserService
          const users = yield* userService.findAll()
          return [...users]
        }),
    }),

    query("user", {
      args: S.Struct({ id: S.String }),
      type: User,
      description: "Get a user by ID",
      resolve: (args) => loaders.load("UserById", args.id),
    }),

    query("posts", {
      type: S.Array(Post),
      description: "Get all published posts",
      resolve: () =>
        Effect.gen(function* () {
          const postService = yield* PostService
          const posts = yield* postService.findAll()
          return [...posts]
        }),
    }),

    query("post", {
      args: S.Struct({ id: S.String }),
      type: Post,
      description: "Get a post by ID",
      resolve: (args) =>
        Effect.gen(function* () {
          const postService = yield* PostService
          return yield* postService.findById(args.id)
        }),
    })
  )

// Add mutations and build schema
export const schema = schemaWithQueries
  .pipe(
    mutation("createUser", {
      args: CreateUserInput,
      type: User,
      description: "Create a new user (admin only)",
      resolve: (args) =>
        Effect.gen(function* () {
          const auth = yield* AuthService
          yield* auth.requireRole("ADMIN")

          const userService = yield* UserService
          const user = yield* userService.create(args)

          console.log(`Created user: ${user.name} (${user.email})`)
          return user
        }),
    }),

    mutation("createPost", {
      args: CreatePostInput,
      type: Post,
      description: "Create a new post",
      resolve: (args) =>
        Effect.gen(function* () {
          const auth = yield* AuthService
          const user = yield* auth.requireAuth()

          const postService = yield* PostService
          const post = yield* postService.create(user.id, args)

          console.log(`Created post: "${post.title}" by ${user.name}`)
          return post
        }),
    }),

    mutation("publishPost", {
      args: S.Struct({ id: S.String }),
      type: Post,
      description: "Publish a post",
      resolve: (args) =>
        Effect.gen(function* () {
          const auth = yield* AuthService
          yield* auth.requireAuth()

          const postService = yield* PostService
          const post = yield* postService.publish(args.id)

          console.log(`Published post: "${post.title}"`)
          return post
        }),
    }),

    mutation("addComment", {
      args: S.Struct({
        postId: S.String,
        content: S.String.pipe(S.minLength(1)),
      }),
      type: Comment,
      description: "Add a comment to a post",
      resolve: (args) =>
        Effect.gen(function* () {
          const auth = yield* AuthService
          const user = yield* auth.requireAuth()

          const commentService = yield* CommentService
          const comment = yield* commentService.create(args.postId, user.id, args.content)

          console.log(`Added comment to post ${args.postId} by ${user.name}`)
          return comment
        }),
    })
  )
  .buildSchema()
