import { Effect } from "effect"
import * as S from "effect/Schema"

/**
 * Configuration for a @key directive
 */
export interface KeyDirective {
  /** FieldSet selection string (e.g., "id" or "sku package") */
  readonly fields: string
  /** Whether this key can be used to resolve the entity. Default: true */
  readonly resolvable?: boolean
}

/**
 * All Federation 2.x directive types
 */
export type FederationDirective =
  | { readonly _tag: "key"; readonly fields: string; readonly resolvable?: boolean }
  | { readonly _tag: "external" }
  | { readonly _tag: "requires"; readonly fields: string }
  | { readonly _tag: "provides"; readonly fields: string }
  | { readonly _tag: "shareable" }
  | { readonly _tag: "inaccessible" }
  | { readonly _tag: "override"; readonly from: string; readonly label?: string }
  | { readonly _tag: "interfaceObject" }
  | { readonly _tag: "tag"; readonly name: string }

/**
 * Entity representation sent to _entities query
 * Contains __typename plus the key fields
 */
export interface EntityRepresentation {
  readonly __typename: string
  readonly [key: string]: unknown
}

/**
 * Configuration for registering an entity type
 */
export interface EntityRegistration<A, R = never> {
  /** Type name */
  readonly name: string
  /** Effect Schema for the entity type */
  readonly schema: S.Schema<A, any, any>
  /** Key directive configurations (at least one required) */
  readonly keys: readonly KeyDirective[]
  /** Additional directives to apply to the type */
  readonly directives?: readonly FederationDirective[]
  /**
   * Reference resolver - given key fields, return the full entity.
   * The representation contains __typename plus all fields from any matching @key.
   */
  readonly resolveReference: (
    representation: Partial<A> & { __typename: string }
  ) => Effect.Effect<A | null, any, R>
}

/**
 * Configuration for the FederatedSchemaBuilder
 */
export interface FederatedSchemaConfig {
  /** Federation specification version (default: "2.3") */
  readonly version?: string
}

/**
 * Result of building a federated schema
 */
export interface FederatedSchemaResult {
  /** The GraphQL schema with Federation queries */
  readonly schema: import("graphql").GraphQLSchema
  /** The Federation-compliant SDL with directive annotations */
  readonly sdl: string
}

/**
 * Convert a FederationDirective to a DirectiveApplication
 */
export function toDirectiveApplication(
  directive: FederationDirective
): import("@effect-gql/core").DirectiveApplication {
  switch (directive._tag) {
    case "key":
      return {
        name: "key",
        args: {
          fields: directive.fields,
          ...(directive.resolvable !== undefined ? { resolvable: directive.resolvable } : {}),
        },
      }
    case "external":
      return { name: "external" }
    case "requires":
      return { name: "requires", args: { fields: directive.fields } }
    case "provides":
      return { name: "provides", args: { fields: directive.fields } }
    case "shareable":
      return { name: "shareable" }
    case "inaccessible":
      return { name: "inaccessible" }
    case "override":
      return {
        name: "override",
        args: {
          from: directive.from,
          ...(directive.label !== undefined ? { label: directive.label } : {}),
        },
      }
    case "interfaceObject":
      return { name: "interfaceObject" }
    case "tag":
      return { name: "tag", args: { name: directive.name } }
  }
}
