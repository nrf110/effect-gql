/**
 * @effect-gql/cli - CLI tools for Effect GraphQL development
 *
 * @example CLI usage
 * ```bash
 * # Generate SDL from schema
 * effect-gql generate-schema ./src/schema.ts
 * effect-gql generate-schema ./src/schema.ts -o schema.graphql
 *
 * # Watch mode
 * effect-gql generate-schema ./src/schema.ts -o schema.graphql --watch
 * ```
 *
 * @example Programmatic usage
 * ```typescript
 * import { generateSDL, generateSDLFromModule } from "@effect-gql/cli"
 * import { Effect } from "effect"
 *
 * // From a schema directly
 * const sdl = generateSDL(builder.buildSchema())
 *
 * // From a module path
 * const sdl = await Effect.runPromise(
 *   generateSDLFromModule("./src/schema.ts")
 * )
 * ```
 */

export { generateSDL, generateSDLFromModule, loadSchema } from "./commands/generate-schema"
