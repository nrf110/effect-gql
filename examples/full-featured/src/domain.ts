/**
 * Domain Models
 *
 * Define your domain models using Effect Schema.
 * These schemas serve as the single source of truth for:
 * - TypeScript types
 * - GraphQL types
 * - Validation rules
 */

import * as S from "effect/Schema"

// =============================================================================
// User Domain
// =============================================================================

export const UserRole = S.Literal("ADMIN", "USER", "GUEST")
export type UserRole = S.Schema.Type<typeof UserRole>

export const User = S.Struct({
  id: S.String,
  name: S.String,
  email: S.String,
  role: UserRole,
})
export type User = S.Schema.Type<typeof User>

export const CreateUserInput = S.Struct({
  name: S.String,
  email: S.String,
  role: S.optional(UserRole),
})
export type CreateUserInput = S.Schema.Type<typeof CreateUserInput>

// =============================================================================
// Post Domain
// =============================================================================

export const Post = S.Struct({
  id: S.String,
  title: S.String,
  content: S.String,
  authorId: S.String,
  published: S.Boolean,
  createdAt: S.Number,
})
export type Post = S.Schema.Type<typeof Post>

export const CreatePostInput = S.Struct({
  title: S.String,
  content: S.String,
  published: S.optional(S.Boolean),
})
export type CreatePostInput = S.Schema.Type<typeof CreatePostInput>

// =============================================================================
// Comment Domain
// =============================================================================

export const Comment = S.Struct({
  id: S.String,
  content: S.String,
  postId: S.String,
  authorId: S.String,
  createdAt: S.Number,
})
export type Comment = S.Schema.Type<typeof Comment>
