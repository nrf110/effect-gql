/**
 * Services
 *
 * Effect services encapsulate business logic and external dependencies.
 * They are injected into resolvers using Effect's Context system.
 */

import { Effect, Context, Layer, Ref } from "effect"
import type { User, Post, Comment, CreateUserInput, CreatePostInput } from "./domain"
import { NotFoundError, AuthorizationError } from "@effect-gql/core"

// =============================================================================
// Auth Service
// =============================================================================

export class AuthService extends Context.Tag("AuthService")<
  AuthService,
  {
    readonly getCurrentUser: () => Effect.Effect<User | null>
    readonly requireAuth: () => Effect.Effect<User, AuthorizationError>
    readonly requireRole: (role: string) => Effect.Effect<User, AuthorizationError>
  }
>() {}

// =============================================================================
// User Service
// =============================================================================

export class UserService extends Context.Tag("UserService")<
  UserService,
  {
    readonly findById: (id: string) => Effect.Effect<User, NotFoundError>
    readonly findByIds: (ids: readonly string[]) => Effect.Effect<readonly User[]>
    readonly findAll: () => Effect.Effect<readonly User[]>
    readonly create: (input: CreateUserInput) => Effect.Effect<User>
  }
>() {}

// =============================================================================
// Post Service
// =============================================================================

export class PostService extends Context.Tag("PostService")<
  PostService,
  {
    readonly findById: (id: string) => Effect.Effect<Post, NotFoundError>
    readonly findByAuthorIds: (authorIds: readonly string[]) => Effect.Effect<readonly Post[]>
    readonly findAll: () => Effect.Effect<readonly Post[]>
    readonly create: (authorId: string, input: CreatePostInput) => Effect.Effect<Post>
    readonly publish: (id: string) => Effect.Effect<Post, NotFoundError>
  }
>() {}

// =============================================================================
// Comment Service
// =============================================================================

export class CommentService extends Context.Tag("CommentService")<
  CommentService,
  {
    readonly findByPostIds: (postIds: readonly string[]) => Effect.Effect<readonly Comment[]>
    readonly create: (postId: string, authorId: string, content: string) => Effect.Effect<Comment>
  }
>() {}

// =============================================================================
// In-Memory Implementations
// =============================================================================

// Mock data
const initialUsers: User[] = [
  { id: "1", name: "Alice", email: "alice@example.com", role: "ADMIN" },
  { id: "2", name: "Bob", email: "bob@example.com", role: "USER" },
  { id: "3", name: "Charlie", email: "charlie@example.com", role: "USER" },
]

const initialPosts: Post[] = [
  { id: "p1", title: "Getting Started with Effect", content: "Effect is a powerful...", authorId: "1", published: true, createdAt: Date.now() - 86400000 },
  { id: "p2", title: "GraphQL Best Practices", content: "When building GraphQL APIs...", authorId: "1", published: true, createdAt: Date.now() - 43200000 },
  { id: "p3", title: "Draft Post", content: "This is a draft...", authorId: "2", published: false, createdAt: Date.now() },
]

const initialComments: Comment[] = [
  { id: "c1", content: "Great article!", postId: "p1", authorId: "2", createdAt: Date.now() - 3600000 },
  { id: "c2", content: "Very helpful, thanks!", postId: "p1", authorId: "3", createdAt: Date.now() - 1800000 },
  { id: "c3", content: "Looking forward to more!", postId: "p2", authorId: "3", createdAt: Date.now() - 900000 },
]

// Refs for mutable state
const usersRef = Ref.unsafeMake<User[]>([...initialUsers])
const postsRef = Ref.unsafeMake<Post[]>([...initialPosts])
const commentsRef = Ref.unsafeMake<Comment[]>([...initialComments])

// Counters for IDs
let userIdCounter = initialUsers.length
let postIdCounter = initialPosts.length
let commentIdCounter = initialComments.length

/**
 * In-memory Auth Service implementation
 * Simulates a logged-in admin user for this example
 */
export const AuthServiceLive = Layer.succeed(AuthService, {
  getCurrentUser: () =>
    Effect.gen(function* () {
      const users = yield* Ref.get(usersRef)
      return users[0] ?? null // Return first user as "current user"
    }),

  requireAuth: () =>
    Effect.gen(function* () {
      const users = yield* Ref.get(usersRef)
      const user = users[0]
      if (!user) {
        return yield* Effect.fail(new AuthorizationError({ message: "Authentication required" }))
      }
      return user
    }),

  requireRole: (role: string) =>
    Effect.gen(function* () {
      const users = yield* Ref.get(usersRef)
      const user = users[0]
      if (!user) {
        return yield* Effect.fail(new AuthorizationError({ message: "Authentication required" }))
      }
      if (user.role !== role) {
        return yield* Effect.fail(new AuthorizationError({ message: `Role '${role}' required` }))
      }
      return user
    }),
})

/**
 * In-memory User Service implementation
 */
export const UserServiceLive = Layer.succeed(UserService, {
  findById: (id: string) =>
    Effect.gen(function* () {
      const users = yield* Ref.get(usersRef)
      const user = users.find((u) => u.id === id)
      if (!user) {
        return yield* Effect.fail(new NotFoundError({ message: `User not found`, resource: `User:${id}` }))
      }
      return user
    }),

  findByIds: (ids: readonly string[]) =>
    Effect.gen(function* () {
      const users = yield* Ref.get(usersRef)
      return users.filter((u) => ids.includes(u.id))
    }),

  findAll: () => Ref.get(usersRef),

  create: (input: CreateUserInput) =>
    Effect.gen(function* () {
      const newUser: User = {
        id: String(++userIdCounter),
        name: input.name,
        email: input.email,
        role: input.role !== undefined ? input.role : "USER",
      }
      yield* Ref.update(usersRef, (users) => [...users, newUser])
      return newUser
    }),
})

/**
 * In-memory Post Service implementation
 */
export const PostServiceLive = Layer.succeed(PostService, {
  findById: (id: string) =>
    Effect.gen(function* () {
      const posts = yield* Ref.get(postsRef)
      const post = posts.find((p) => p.id === id)
      if (!post) {
        return yield* Effect.fail(new NotFoundError({ message: `Post not found`, resource: `Post:${id}` }))
      }
      return post
    }),

  findByAuthorIds: (authorIds: readonly string[]) =>
    Effect.gen(function* () {
      const posts = yield* Ref.get(postsRef)
      return posts.filter((p) => authorIds.includes(p.authorId))
    }),

  findAll: () =>
    Effect.gen(function* () {
      const posts = yield* Ref.get(postsRef)
      return posts.filter((p) => p.published)
    }),

  create: (authorId: string, input: CreatePostInput) =>
    Effect.gen(function* () {
      const newPost: Post = {
        id: `p${++postIdCounter}`,
        title: input.title,
        content: input.content,
        authorId,
        published: input.published !== undefined ? input.published : false,
        createdAt: Date.now(),
      }
      yield* Ref.update(postsRef, (posts) => [...posts, newPost])
      return newPost
    }),

  publish: (id: string) =>
    Effect.gen(function* () {
      const posts = yield* Ref.get(postsRef)
      const postIndex = posts.findIndex((p) => p.id === id)
      if (postIndex === -1) {
        return yield* Effect.fail(new NotFoundError({ message: `Post not found`, resource: `Post:${id}` }))
      }
      const updatedPost = { ...posts[postIndex], published: true }
      yield* Ref.update(postsRef, (ps) => {
        const newPosts = [...ps]
        newPosts[postIndex] = updatedPost
        return newPosts
      })
      return updatedPost
    }),
})

/**
 * In-memory Comment Service implementation
 */
export const CommentServiceLive = Layer.succeed(CommentService, {
  findByPostIds: (postIds: readonly string[]) =>
    Effect.gen(function* () {
      const comments = yield* Ref.get(commentsRef)
      return comments.filter((c) => postIds.includes(c.postId))
    }),

  create: (postId: string, authorId: string, content: string) =>
    Effect.gen(function* () {
      const newComment: Comment = {
        id: `c${++commentIdCounter}`,
        content,
        postId,
        authorId,
        createdAt: Date.now(),
      }
      yield* Ref.update(commentsRef, (comments) => [...comments, newComment])
      return newComment
    }),
})

/**
 * Combined service layer
 */
export const ServicesLive = Layer.mergeAll(
  AuthServiceLive,
  UserServiceLive,
  PostServiceLive,
  CommentServiceLive
)
