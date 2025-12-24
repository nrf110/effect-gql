import { Effect, Layer } from "effect"
import * as S from "effect/Schema"
import { GraphQLSchemaBuilder, execute, objectType, enumType, unionType, query } from "@effect-gql/core"
import { printSchema } from "graphql"

/**
 * Example: Enum and Union Types
 *
 * Demonstrates:
 * - Enum types for fixed sets of values
 * - Union types for polymorphic returns (using _tag for resolution)
 */

// ============================================================================
// Enum Types
// ============================================================================

// Status enum values
const StatusValues = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const
type Status = typeof StatusValues[number]

// Priority enum values
const PriorityValues = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const
type Priority = typeof PriorityValues[number]

// ============================================================================
// Object Types with Enums
// ============================================================================

const ArticleSchema = S.Struct({
  id: S.String,
  title: S.String,
  status: S.Literal(...StatusValues),
})

type Article = S.Schema.Type<typeof ArticleSchema>

const TaskSchema = S.Struct({
  id: S.String,
  title: S.String,
  priority: S.Literal(...PriorityValues),
  completed: S.Boolean,
})

type Task = S.Schema.Type<typeof TaskSchema>

// ============================================================================
// Union Types (with _tag discriminator)
// ============================================================================

const TextContentSchema = S.TaggedStruct("TextContent", {
  id: S.String,
  body: S.String,
})

type TextContent = S.Schema.Type<typeof TextContentSchema>

const ImageContentSchema = S.TaggedStruct("ImageContent", {
  id: S.String,
  url: S.String,
  altText: S.String,
})

type ImageContent = S.Schema.Type<typeof ImageContentSchema>

const VideoContentSchema = S.TaggedStruct("VideoContent", {
  id: S.String,
  url: S.String,
  duration: S.Number,
})

type VideoContent = S.Schema.Type<typeof VideoContentSchema>

type MediaContent = TextContent | ImageContent | VideoContent

// ============================================================================
// Mock Data
// ============================================================================

const articles: Article[] = [
  { id: "1", title: "Getting Started with Effect", status: "PUBLISHED" },
  { id: "2", title: "Advanced Patterns", status: "DRAFT" },
  { id: "3", title: "Old Tutorial", status: "ARCHIVED" },
]

const tasks: Task[] = [
  { id: "1", title: "Fix bug", priority: "HIGH", completed: false },
  { id: "2", title: "Write docs", priority: "MEDIUM", completed: true },
  { id: "3", title: "Deploy", priority: "CRITICAL", completed: false },
]

const mediaContent: MediaContent[] = [
  { _tag: "TextContent", id: "1", body: "Hello world" },
  { _tag: "ImageContent", id: "2", url: "https://example.com/image.png", altText: "Example" },
  { _tag: "VideoContent", id: "3", url: "https://example.com/video.mp4", duration: 120 },
]

// ============================================================================
// Build Schema
// ============================================================================

const builder = GraphQLSchemaBuilder.empty.pipe(
  // Register enums
  enumType({ name: "Status", values: StatusValues, description: "Publication status" }),
  enumType({ name: "Priority", values: PriorityValues, description: "Task priority level" }),

  // Register object types
  objectType({ name: "Article", schema: ArticleSchema }),
  objectType({ name: "Task", schema: TaskSchema }),
  objectType({ name: "TextContent", schema: TextContentSchema }),
  objectType({ name: "ImageContent", schema: ImageContentSchema }),
  objectType({ name: "VideoContent", schema: VideoContentSchema }),
).pipe(
  // Register union type - uses _tag for type resolution by default
  unionType({
    name: "MediaContent",
    types: ["TextContent", "ImageContent", "VideoContent"],
  }),

  // Queries
  query("articles", {
    type: S.Array(ArticleSchema),
    args: S.Struct({
      status: S.optional(S.Literal(...StatusValues)),
    }),
    description: "Get articles, optionally filtered by status",
    resolve: (args: { status?: Status }) =>
      Effect.succeed(
        args.status
          ? articles.filter(a => a.status === args.status)
          : articles
      ),
  }),

  query("tasks", {
    type: S.Array(TaskSchema),
    args: S.Struct({
      priority: S.optional(S.Literal(...PriorityValues)),
    }),
    description: "Get tasks, optionally filtered by priority",
    resolve: (args: { priority?: Priority }) =>
      Effect.succeed(
        args.priority
          ? tasks.filter(t => t.priority === args.priority)
          : tasks
      ),
  }),

  query("allMedia", {
    type: S.Array(S.Union(TextContentSchema, ImageContentSchema, VideoContentSchema)),
    description: "Get all media content",
    resolve: () => Effect.succeed(mediaContent),
  }),

  query("mediaById", {
    type: S.Union(TextContentSchema, ImageContentSchema, VideoContentSchema),
    args: S.Struct({ id: S.String }),
    description: "Get media content by ID",
    resolve: (args: { id: string }) =>
      Effect.sync(() => {
        const content = mediaContent.find(m => m.id === args.id)
        if (!content) throw new Error(`Media ${args.id} not found`)
        return content
      }),
  }),
)

const schema = builder.buildSchema()

// ============================================================================
// Print and Execute
// ============================================================================

console.log("=== GraphQL Schema ===\n")
console.log(printSchema(schema))

const layer = Layer.empty

const runExample = Effect.gen(function*() {
  // Query with enum filter
  console.log("\n=== Query: Articles by status ===")
  const articlesResult = yield* execute(schema, layer)(
    `
      query {
        articles(status: PUBLISHED) {
          id
          title
          status
        }
      }
    `
  )
  console.log(JSON.stringify(articlesResult, null, 2))

  // Query tasks by priority
  console.log("\n=== Query: Critical tasks ===")
  const tasksResult = yield* execute(schema, layer)(
    `
      query {
        tasks(priority: CRITICAL) {
          id
          title
          priority
          completed
        }
      }
    `
  )
  console.log(JSON.stringify(tasksResult, null, 2))

  // Query union type
  console.log("\n=== Query: All media (union type) ===")
  const mediaResult = yield* execute(schema, layer)(
    `
      query {
        allMedia {
          ... on TextContent {
            id
            body
          }
          ... on ImageContent {
            id
            url
            altText
          }
          ... on VideoContent {
            id
            url
            duration
          }
        }
      }
    `
  )
  console.log(JSON.stringify(mediaResult, null, 2))

  // Query single media item
  console.log("\n=== Query: Single media by ID ===")
  const singleMediaResult = yield* execute(schema, layer)(
    `
      query {
        mediaById(id: "2") {
          ... on TextContent {
            id
            body
          }
          ... on ImageContent {
            id
            url
            altText
          }
          ... on VideoContent {
            id
            url
            duration
          }
        }
      }
    `
  )
  console.log(JSON.stringify(singleMediaResult, null, 2))
})

Effect.runPromise(runExample).catch(console.error)
