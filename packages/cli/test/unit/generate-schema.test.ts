import { describe, it, expect } from "vitest"
import { Context, Effect } from "effect"
import * as S from "effect/Schema"
import * as path from "path"
import { execSync } from "child_process"
import { GraphQLSchemaBuilder, query, objectType } from "@effect-gql/core"
import { generateSDL, generateSDLFromModule } from "../../src"

// Resolve fixture path relative to this test file
const fixturesDir = path.resolve(__dirname, "../fixtures")
const cliDir = path.resolve(__dirname, "../..")

describe("generate-schema", () => {
  describe("generateSDL", () => {
    it("should generate SDL from a GraphQL schema", () => {
      const builder = GraphQLSchemaBuilder.empty.pipe(
        query("hello", {
          type: S.String,
          resolve: () => Effect.succeed("world"),
        })
      )

      const schema = builder.buildSchema()
      const sdl = generateSDL(schema)

      expect(sdl).toContain("type Query")
      expect(sdl).toContain("hello: String")
    })

    it("should sort schema alphabetically by default", () => {
      const builder = GraphQLSchemaBuilder.empty.pipe(
        query("zebra", {
          type: S.String,
          resolve: () => Effect.succeed("z"),
        }),
        query("alpha", {
          type: S.String,
          resolve: () => Effect.succeed("a"),
        })
      )

      const schema = builder.buildSchema()
      const sdl = generateSDL(schema, { sort: true })

      // Alpha should come before zebra when sorted
      const alphaIndex = sdl.indexOf("alpha")
      const zebraIndex = sdl.indexOf("zebra")
      expect(alphaIndex).toBeLessThan(zebraIndex)
    })

    it("should preserve original order when sort is false", () => {
      const builder = GraphQLSchemaBuilder.empty.pipe(
        query("zebra", {
          type: S.String,
          resolve: () => Effect.succeed("z"),
        }),
        query("alpha", {
          type: S.String,
          resolve: () => Effect.succeed("a"),
        })
      )

      const schema = builder.buildSchema()
      const sdl = generateSDL(schema, { sort: false })

      // Original order should be preserved (zebra before alpha)
      const alphaIndex = sdl.indexOf("alpha")
      const zebraIndex = sdl.indexOf("zebra")
      expect(zebraIndex).toBeLessThan(alphaIndex)
    })

    it("should include object types", () => {
      const User = S.Struct({
        id: S.String,
        name: S.String,
      })

      const builder = GraphQLSchemaBuilder.empty.pipe(
        objectType({ name: "User", schema: User }),
        query("user", {
          type: User,
          resolve: () => Effect.succeed({ id: "1", name: "Test" }),
        })
      )

      const schema = builder.buildSchema()
      const sdl = generateSDL(schema)

      expect(sdl).toContain("type User")
      expect(sdl).toContain("id: String!")
      expect(sdl).toContain("name: String!")
    })

    it("should include arguments", () => {
      const builder = GraphQLSchemaBuilder.empty.pipe(
        query("greet", {
          type: S.String,
          args: S.Struct({ name: S.String }),
          resolve: ({ name }) => Effect.succeed(`Hello, ${name}!`),
        })
      )

      const schema = builder.buildSchema()
      const sdl = generateSDL(schema)

      expect(sdl).toContain("greet(name: String!): String")
    })
  })

  describe("generateSDLFromModule", () => {
    // Note: The programmatic generateSDLFromModule test is skipped because in a
    // monorepo/vitest environment, dynamic module loading can result in different
    // graphql instances due to ESM vs CJS module resolution differences.
    // We test the CLI binary directly instead, which correctly handles this.
    it.skip("should load schema from module with builder export (programmatic)", async () => {
      const sdl = await Effect.runPromise(
        generateSDLFromModule(path.join(fixturesDir, "test-schema.ts"))
      )

      expect(sdl).toContain("type Query")
      expect(sdl).toContain("type User")
      expect(sdl).toContain("type Post")
    })

    it("should load schema from module via CLI binary", () => {
      // This tests the actual CLI binary which correctly loads graphql from the
      // same location as @effect-gql/core to avoid version mismatch issues
      const fixturePath = path.join(fixturesDir, "test-schema.ts")
      const sdl = execSync(
        `node ${path.join(cliDir, "dist/bin.js")} generate-schema ${fixturePath}`,
        {
          encoding: "utf-8",
          cwd: cliDir,
        }
      )

      expect(sdl).toContain("type Query")
      expect(sdl).toContain("type User")
      expect(sdl).toContain("type Post")
    })

    it("should load multi-file schema with relative imports via CLI binary", () => {
      // This tests that the CLI correctly handles TypeScript schemas that import
      // from sibling files using relative paths (e.g., ./types)
      const fixturePath = path.join(fixturesDir, "multi-file-schema.ts")
      const sdl = execSync(
        `node ${path.join(cliDir, "dist/bin.js")} generate-schema ${fixturePath}`,
        {
          encoding: "utf-8",
          cwd: cliDir,
        }
      )

      expect(sdl).toContain("type Query")
      expect(sdl).toContain("type User")
      expect(sdl).toContain("type Post")
      // The multi-file schema has an author field on Post that the single-file doesn't
      expect(sdl).toContain("author: User")
    })

    it("should fail for non-existent module", async () => {
      const result = await Effect.runPromise(
        generateSDLFromModule(path.join(fixturesDir, "non-existent-module.ts")).pipe(Effect.result)
      )

      expect(result._tag).toBe("Failure")
    })
  })

  describe("schema building without services", () => {
    it("should build schema without requiring Effect layer", () => {
      // This demonstrates that schema building works without any services
      // Define a service that would normally require a layer
      class DatabaseService extends Context.Service<
        DatabaseService,
        {
          getUsers: () => Effect.Effect<readonly string[]>
        }
      >()("@app/DatabaseService") {}

      const builder = GraphQLSchemaBuilder.empty.pipe(
        query("users", {
          type: S.Array(S.String),
          // This resolver requires DatabaseService, but schema building doesn't run it
          resolve: () => DatabaseService.pipe(Effect.flatMap((db) => db.getUsers())),
        })
      )

      // buildSchema() works without any layer - no DatabaseService needed
      const schema = builder.buildSchema()
      // Check it's a valid GraphQL schema by verifying it has the expected methods
      expect(schema.getQueryType).toBeDefined()
      expect(schema.getTypeMap).toBeDefined()

      // We can generate SDL without any services
      const sdl = generateSDL(schema)
      expect(sdl).toContain("users: [String]")
    })
  })
})
