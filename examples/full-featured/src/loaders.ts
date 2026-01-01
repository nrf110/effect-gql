/**
 * DataLoaders
 *
 * Define DataLoaders using Effect GQL's Loader API.
 * Loaders batch and cache database queries within a single request.
 */

import { Effect } from "effect"
import { Loader } from "@effect-gql/core"
import { UserService, PostService, CommentService } from "./services"
import type { User, Post, Comment } from "./domain"

/**
 * Define all loaders for the application.
 *
 * Loader.single: One key → one value (e.g., user by ID)
 * Loader.grouped: One key → many values (e.g., posts by author ID)
 */
export const loaders = Loader.define({
  /**
   * Fetch users by their IDs.
   * Batches multiple user lookups into a single query.
   */
  UserById: Loader.single<string, User, UserService>({
    batch: (ids) =>
      Effect.gen(function* () {
        const userService = yield* UserService
        console.log(`📦 [Loader] Batch fetching users: [${ids.join(", ")}]`)
        return yield* userService.findByIds(ids)
      }),
    key: (user) => user.id,
  }),

  /**
   * Fetch all posts by author IDs.
   * Groups posts by their authorId.
   */
  PostsByAuthorId: Loader.grouped<string, Post, PostService>({
    batch: (authorIds) =>
      Effect.gen(function* () {
        const postService = yield* PostService
        console.log(`📦 [Loader] Batch fetching posts for authors: [${authorIds.join(", ")}]`)
        return yield* postService.findByAuthorIds(authorIds)
      }),
    groupBy: (post) => post.authorId,
  }),

  /**
   * Fetch all comments by post IDs.
   * Groups comments by their postId.
   */
  CommentsByPostId: Loader.grouped<string, Comment, CommentService>({
    batch: (postIds) =>
      Effect.gen(function* () {
        const commentService = yield* CommentService
        console.log(`📦 [Loader] Batch fetching comments for posts: [${postIds.join(", ")}]`)
        return yield* commentService.findByPostIds(postIds)
      }),
    groupBy: (comment) => comment.postId,
  }),
})
