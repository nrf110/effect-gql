// Configuration types and utilities
export type { GraphiQLConfig, GraphQLRouterConfig, GraphQLRouterConfigInput } from "./config"

export { defaultConfig, normalizeConfig, GraphQLRouterConfigFromEnv } from "./config"

// GraphiQL HTML generator
export { graphiqlHtml } from "./graphiql"

// Router factory
export {
  makeGraphQLRouter,
  defaultErrorHandler,
  type MakeGraphQLRouterOptions,
  type ErrorHandler,
} from "./router"

// Schema builder extension
export { toRouter } from "./schema-builder-extensions"

// Complexity limiting
export type {
  ComplexityConfig,
  ComplexityResult,
  ComplexityAnalysisInfo,
  ComplexityExceededInfo,
  ComplexityCalculator,
  FieldComplexity,
  FieldComplexityMap,
} from "./complexity"

export {
  ComplexityLimitExceededError,
  ComplexityAnalysisError,
  validateComplexity,
  defaultComplexityCalculator,
  depthOnlyCalculator,
  combineCalculators,
  ComplexityConfigFromEnv,
} from "./complexity"

// Cache control
export type {
  CacheHintMap,
  CachePolicy,
  CacheControlConfig,
  CachePolicyAnalysisInfo,
} from "./cache-control"

export {
  computeCachePolicy,
  computeCachePolicyFromQuery,
  toCacheControlHeader,
  CacheControlConfigFromEnv,
} from "./cache-control"

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

// WebSocket utilities for 'ws' library integration
export type { WsWebSocket } from "./ws-utils"
export { toEffectWebSocketFromWs, WS_CLOSED } from "./ws-utils"

// SSE (Server-Sent Events) subscription support
export type {
  EffectSSE,
  SSEEvent,
  SSEEventType,
  SSESubscriptionRequest,
  SSEConnectionContext,
  GraphQLSSEOptions,
  GraphQLSSEConfig,
  SSESubscriptionResult,
} from "./sse-types"

export {
  SSEError,
  SSE_HEADERS,
  formatNextEvent,
  formatErrorEvent,
  formatCompleteEvent,
  formatSSEMessage,
} from "./sse-types"

export { makeSSESubscriptionStream, makeGraphQLSSEHandler } from "./sse-adapter"
