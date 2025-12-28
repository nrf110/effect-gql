import { describe, it, expect } from "vitest"
import { parseTraceParent, formatTraceParent, isSampled } from "../../src/context-propagation"

describe("context-propagation.ts", () => {
  describe("parseTraceParent", () => {
    it("should parse a valid traceparent header", () => {
      const result = parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")

      expect(result).not.toBeNull()
      expect(result!.version).toBe("00")
      expect(result!.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
      expect(result!.parentSpanId).toBe("00f067aa0ba902b7")
      expect(result!.traceFlags).toBe(1)
    })

    it("should parse sampled flag correctly (sampled)", () => {
      const result = parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")

      expect(result).not.toBeNull()
      expect(isSampled(result!)).toBe(true)
    })

    it("should parse sampled flag correctly (not sampled)", () => {
      const result = parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00")

      expect(result).not.toBeNull()
      expect(isSampled(result!)).toBe(false)
    })

    it("should handle uppercase hex values", () => {
      const result = parseTraceParent("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01")

      expect(result).not.toBeNull()
      expect(result!.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
    })

    it("should handle whitespace around the header", () => {
      const result = parseTraceParent("  00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01  ")

      expect(result).not.toBeNull()
      expect(result!.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
    })

    it("should return null for invalid format (too few parts)", () => {
      expect(parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736")).toBeNull()
    })

    it("should return null for invalid format (too many parts)", () => {
      expect(
        parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra")
      ).toBeNull()
    })

    it("should return null for invalid version (too short)", () => {
      expect(parseTraceParent("0-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeNull()
    })

    it("should return null for invalid trace ID (too short)", () => {
      expect(parseTraceParent("00-4bf92f35-00f067aa0ba902b7-01")).toBeNull()
    })

    it("should return null for invalid trace ID (all zeros)", () => {
      expect(parseTraceParent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeNull()
    })

    it("should return null for invalid span ID (too short)", () => {
      expect(parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa-01")).toBeNull()
    })

    it("should return null for invalid span ID (all zeros)", () => {
      expect(parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01")).toBeNull()
    })

    it("should return null for invalid trace flags (too short)", () => {
      expect(parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-1")).toBeNull()
    })

    it("should return null for non-hex characters in trace ID", () => {
      expect(parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0g4736-00f067aa0ba902b7-01")).toBeNull()
    })
  })

  describe("formatTraceParent", () => {
    it("should format a trace context as a traceparent header", () => {
      const context = {
        version: "00",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        parentSpanId: "00f067aa0ba902b7",
        traceFlags: 1,
      }

      expect(formatTraceParent(context)).toBe(
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
      )
    })

    it("should pad trace flags to 2 characters", () => {
      const context = {
        version: "00",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        parentSpanId: "00f067aa0ba902b7",
        traceFlags: 0,
      }

      expect(formatTraceParent(context)).toBe(
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00"
      )
    })
  })

  describe("isSampled", () => {
    it("should return true when sampled bit is set", () => {
      expect(
        isSampled({
          version: "00",
          traceId: "abc",
          parentSpanId: "def",
          traceFlags: 0x01,
        })
      ).toBe(true)
    })

    it("should return false when sampled bit is not set", () => {
      expect(
        isSampled({
          version: "00",
          traceId: "abc",
          parentSpanId: "def",
          traceFlags: 0x00,
        })
      ).toBe(false)
    })

    it("should check only the sampled bit", () => {
      // 0xff has all bits set, but we only care about bit 0
      expect(
        isSampled({
          version: "00",
          traceId: "abc",
          parentSpanId: "def",
          traceFlags: 0xfe, // bit 0 is NOT set
        })
      ).toBe(false)

      expect(
        isSampled({
          version: "00",
          traceId: "abc",
          parentSpanId: "def",
          traceFlags: 0xff, // bit 0 IS set
        })
      ).toBe(true)
    })
  })
})
