import * as S from "effect/Schema"

// ============================================================================
// Simple Primitives
// ============================================================================

export const StringSchema = S.String
export const IntSchema = S.Int
export const NumberSchema = S.Number
export const BooleanSchema = S.Boolean

// ============================================================================
// Tagged Structs (auto-name extraction)
// ============================================================================

export const UserSchema = S.TaggedStruct("User", {
  id: S.String,
  name: S.String,
  email: S.optional(S.String),
})
export type User = S.Schema.Type<typeof UserSchema>

export const PostSchema = S.TaggedStruct("Post", {
  id: S.String,
  title: S.String,
  content: S.String,
  authorId: S.String,
  published: S.Boolean,
})
export type Post = S.Schema.Type<typeof PostSchema>

export const CommentSchema = S.TaggedStruct("Comment", {
  id: S.String,
  text: S.String,
  postId: S.String,
  authorId: S.String,
})
export type Comment = S.Schema.Type<typeof CommentSchema>

// ============================================================================
// Plain Structs (no auto name - requires explicit name)
// ============================================================================

export const AddressSchema = S.Struct({
  street: S.String,
  city: S.String,
  zip: S.optional(S.String),
  country: S.String,
})
export type Address = S.Schema.Type<typeof AddressSchema>

export const PointSchema = S.Struct({
  x: S.Number,
  y: S.Number,
})
export type Point = S.Schema.Type<typeof PointSchema>

// ============================================================================
// Nested Structs
// ============================================================================

export const TeamSchema = S.TaggedStruct("Team", {
  id: S.String,
  name: S.String,
  members: S.Array(UserSchema),
})
export type Team = S.Schema.Type<typeof TeamSchema>

export const OrganizationSchema = S.TaggedStruct("Organization", {
  id: S.String,
  name: S.String,
  teams: S.Array(TeamSchema),
})
export type Organization = S.Schema.Type<typeof OrganizationSchema>

// ============================================================================
// Enum-like Literals
// ============================================================================

export const StatusValues = ["ACTIVE", "INACTIVE", "PENDING"] as const
export const StatusSchema = S.Literal(...StatusValues)
export type Status = S.Schema.Type<typeof StatusSchema>

export const PriorityValues = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const
export const PrioritySchema = S.Literal(...PriorityValues)
export type Priority = S.Schema.Type<typeof PrioritySchema>

export const RoleValues = ["ADMIN", "USER", "GUEST"] as const
export const RoleSchema = S.Literal(...RoleValues)
export type Role = S.Schema.Type<typeof RoleSchema>

// ============================================================================
// Input Types
// ============================================================================

export const CreateUserInputSchema = S.Struct({
  name: S.String,
  email: S.optional(S.String),
})
export type CreateUserInput = S.Schema.Type<typeof CreateUserInputSchema>

export const UpdateUserInputSchema = S.Struct({
  name: S.optional(S.String),
  email: S.optional(S.String),
})
export type UpdateUserInput = S.Schema.Type<typeof UpdateUserInputSchema>

export const PaginationInputSchema = S.Struct({
  limit: S.optional(S.Int),
  offset: S.optional(S.Int),
})
export type PaginationInput = S.Schema.Type<typeof PaginationInputSchema>

// ============================================================================
// Array Schemas
// ============================================================================

export const UsersArraySchema = S.Array(UserSchema)
export const StringArraySchema = S.Array(S.String)
export const IntArraySchema = S.Array(S.Int)

// ============================================================================
// Optional Fields
// ============================================================================

export const ProfileSchema = S.Struct({
  userId: S.String,
  bio: S.optional(S.String),
  avatar: S.optional(S.String),
  website: S.optional(S.String),
})
export type Profile = S.Schema.Type<typeof ProfileSchema>

// ============================================================================
// With Refinements
// ============================================================================

export const EmailSchema = S.String.pipe(S.pattern(/@/))

export const PositiveIntSchema = S.Int.pipe(S.positive())

// ============================================================================
// Complex Nested with Optionals
// ============================================================================

export const FullUserSchema = S.TaggedStruct("FullUser", {
  id: S.String,
  name: S.String,
  email: S.optional(S.String),
  profile: S.optional(ProfileSchema),
  posts: S.optional(S.Array(PostSchema)),
  role: S.optional(RoleSchema),
})
export type FullUser = S.Schema.Type<typeof FullUserSchema>

// ============================================================================
// Mock Data Factories
// ============================================================================

export const createUser = (overrides: Partial<User> = {}): User => ({
  _tag: "User",
  id: "1",
  name: "Test User",
  ...overrides,
})

export const createPost = (overrides: Partial<Post> = {}): Post => ({
  _tag: "Post",
  id: "1",
  title: "Test Post",
  content: "Test content",
  authorId: "1",
  published: true,
  ...overrides,
})

export const createTeam = (overrides: Partial<Team> = {}): Team => ({
  _tag: "Team",
  id: "1",
  name: "Test Team",
  members: [],
  ...overrides,
})
