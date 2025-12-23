// Configuration types and utilities
export type {
  GraphiQLConfig,
  GraphQLRouterConfig,
  GraphQLRouterConfigInput,
} from "./config"

export {
  defaultConfig,
  normalizeConfig,
  GraphQLRouterConfigFromEnv,
} from "./config"

// GraphiQL HTML generator
export { graphiqlHtml } from "./graphiql"

// Router factory
export { makeGraphQLRouter } from "./router"

// Schema builder extension
export { toRouter } from "./schema-builder-extensions"

// WebSocket subscription support
export type {
  EffectWebSocket,
  CloseEvent,
  ConnectionContext,
  GraphQLWSOptions,
  GraphQLWSConfig,
  SubscribeMessage,
  CompleteMessage,
} from "./ws-types"

export { WebSocketError } from "./ws-types"

export { makeGraphQLWSHandler } from "./ws-adapter"
