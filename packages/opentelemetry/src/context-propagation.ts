import { Effect, Context } from "effect"
import { HttpServerRequest } from "@effect/platform"

/**
 * W3C Trace Context header names
 * @see https://www.w3.org/TR/trace-context/
 */
export const TRACEPARENT_HEADER = "traceparent"
export const TRACESTATE_HEADER = "tracestate"

/**
 * Parsed W3C Trace Context from incoming HTTP headers
 */
export interface TraceContext {
  /**
   * Version of the trace context format (always "00" for current spec)
   */
  readonly version: string

  /**
   * Trace ID - 32 character lowercase hex string
   */
  readonly traceId: string

  /**
   * Parent Span ID - 16 character lowercase hex string
   */
  readonly parentSpanId: string

  /**
   * Trace flags - determines if trace is sampled
   * Bit 0 (0x01) = sampled flag
   */
  readonly traceFlags: number

  /**
   * Optional trace state from upstream services
   */
  readonly traceState?: string
}

/**
 * Context tag for TraceContext
 */
export class TraceContextTag extends Context.Tag("@effect-gql/opentelemetry/TraceContext")<
  TraceContextTag,
  TraceContext
>() {}

/**
 * Parse a W3C traceparent header value.
 *
 * Format: {version}-{trace-id}-{parent-id}-{trace-flags}
 * Example: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 *
 * @see https://www.w3.org/TR/trace-context/#traceparent-header
 *
 * @param header - The traceparent header value
 * @returns Parsed trace context or null if invalid
 */
export const parseTraceParent = (header: string): TraceContext | null => {
  const trimmed = header.trim().toLowerCase()
  const parts = trimmed.split("-")

  if (parts.length !== 4) {
    return null
  }

  const [version, traceId, parentSpanId, flagsHex] = parts

  // Validate version (2 hex chars)
  if (version.length !== 2 || !/^[0-9a-f]{2}$/.test(version)) {
    return null
  }

  // Validate trace ID (32 hex chars, not all zeros)
  if (traceId.length !== 32 || !/^[0-9a-f]{32}$/.test(traceId)) {
    return null
  }
  if (traceId === "00000000000000000000000000000000") {
    return null
  }

  // Validate parent span ID (16 hex chars, not all zeros)
  if (parentSpanId.length !== 16 || !/^[0-9a-f]{16}$/.test(parentSpanId)) {
    return null
  }
  if (parentSpanId === "0000000000000000") {
    return null
  }

  // Validate trace flags (2 hex chars)
  if (flagsHex.length !== 2 || !/^[0-9a-f]{2}$/.test(flagsHex)) {
    return null
  }

  const traceFlags = parseInt(flagsHex, 16)

  return {
    version,
    traceId,
    parentSpanId,
    traceFlags,
  }
}

/**
 * Check if a trace context is sampled (should be recorded)
 */
export const isSampled = (context: TraceContext): boolean => {
  return (context.traceFlags & 0x01) === 0x01
}

/**
 * Extract trace context from HTTP request headers.
 *
 * Looks for the W3C Trace Context headers:
 * - `traceparent`: Required, contains trace ID, span ID, and flags
 * - `tracestate`: Optional, vendor-specific trace data
 *
 * @example
 * ```typescript
 * const context = yield* extractTraceContext
 * if (context) {
 *   console.log(`Continuing trace: ${context.traceId}`)
 * }
 * ```
 */
export const extractTraceContext: Effect.Effect<
  TraceContext | null,
  never,
  HttpServerRequest.HttpServerRequest
> = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const headers = request.headers

  // Get traceparent header (case-insensitive)
  const traceparentKey = Object.keys(headers).find((k) => k.toLowerCase() === TRACEPARENT_HEADER)

  if (!traceparentKey) {
    return null
  }

  const traceparentValue = headers[traceparentKey]
  const traceparent = Array.isArray(traceparentValue) ? traceparentValue[0] : traceparentValue

  if (!traceparent) {
    return null
  }

  const context = parseTraceParent(traceparent)
  if (!context) {
    return null
  }

  // Get optional tracestate header
  const tracestateKey = Object.keys(headers).find((k) => k.toLowerCase() === TRACESTATE_HEADER)

  if (tracestateKey) {
    const tracestateValue = headers[tracestateKey]
    const tracestate = Array.isArray(tracestateValue) ? tracestateValue[0] : tracestateValue

    if (tracestate) {
      return { ...context, traceState: tracestate }
    }
  }

  return context
})

/**
 * Format a trace context as a traceparent header value
 */
export const formatTraceParent = (context: TraceContext): string => {
  const flags = context.traceFlags.toString(16).padStart(2, "0")
  return `${context.version}-${context.traceId}-${context.parentSpanId}-${flags}`
}
