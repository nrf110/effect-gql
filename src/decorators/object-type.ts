import { Class, Struct } from "effect/Schema"

/**
 * Type constraint for classes that implement Effect's Class interface.
 * This ensures the decorator can only be applied to classes created with Schema.Class
 * 
 * We use a type that checks for the key static properties that Class must have:
 * - fields: the struct fields definition
 * - identifier: the class identifier string
 * - ast: the AST transformation
 * - annotations: method to add annotations
 * - make: factory method to create instances
 */
type ClassLike = {
  new (...args: any[]): any
} & {
  readonly fields: Struct.Fields
  readonly identifier: string
  readonly ast: any
  annotations(annotations: any): any
  make(...args: any[]): any
}

/**
 * Decorator that can only be applied to classes implementing Effect's Class interface.
 * 
 * @example
 * ```ts
 * @ObjectType()
 * class Book extends Class<Book>("Book")({
 *   id: Schema.Number,
 *   name: Schema.String,
 * }) {}
 * ```
 */
export function ObjectType() {
  return <T extends ClassLike>(target: T): T => {
    // Decorator implementation - you can add metadata or other logic here
    return target
  }
}