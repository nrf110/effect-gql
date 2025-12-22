import { describe, it, expect } from "vitest"
import { graphiqlHtml } from "../../../src/server/graphiql"

describe("graphiql.ts", () => {
  // ==========================================================================
  // graphiqlHtml
  // ==========================================================================
  describe("graphiqlHtml", () => {
    it("should generate valid HTML document", () => {
      const html = graphiqlHtml("/graphql")

      expect(html).toContain("<!DOCTYPE html>")
      expect(html).toContain("<html")
      expect(html).toContain("</html>")
      expect(html).toContain("<head>")
      expect(html).toContain("</head>")
      expect(html).toContain("<body")
      expect(html).toContain("</body>")
    })

    it("should include GraphiQL title", () => {
      const html = graphiqlHtml("/graphql")

      expect(html).toContain("<title>GraphiQL</title>")
    })

    it("should include GraphiQL CSS from CDN", () => {
      const html = graphiqlHtml("/graphql")

      expect(html).toContain("graphiql.min.css")
      expect(html).toContain("unpkg.com/graphiql")
    })

    it("should include React from CDN", () => {
      const html = graphiqlHtml("/graphql")

      expect(html).toContain("unpkg.com/react@18")
      expect(html).toContain("react.production.min.js")
    })

    it("should include React DOM from CDN", () => {
      const html = graphiqlHtml("/graphql")

      expect(html).toContain("unpkg.com/react-dom@18")
      expect(html).toContain("react-dom.production.min.js")
    })

    it("should include GraphiQL JS from CDN", () => {
      const html = graphiqlHtml("/graphql")

      expect(html).toContain("graphiql.min.js")
    })

    it("should include graphiql container div", () => {
      const html = graphiqlHtml("/graphql")

      expect(html).toContain('id="graphiql"')
      expect(html).toContain("height: 100vh")
    })

    it("should configure fetcher with provided endpoint", () => {
      const html = graphiqlHtml("/graphql")

      expect(html).toContain("GraphiQL.createFetcher")
      expect(html).toContain("url: '/graphql'")
    })

    it("should use custom endpoint in fetcher configuration", () => {
      const html = graphiqlHtml("/api/v1/graphql")

      expect(html).toContain("url: '/api/v1/graphql'")
    })

    it("should initialize GraphiQL with ReactDOM.createRoot", () => {
      const html = graphiqlHtml("/graphql")

      expect(html).toContain("ReactDOM.createRoot")
      expect(html).toContain("React.createElement(GraphiQL")
    })

    it("should have proper meta viewport for responsive display", () => {
      const html = graphiqlHtml("/graphql")

      expect(html).toContain('name="viewport"')
      expect(html).toContain("width=device-width")
    })

    it("should have no margin on body", () => {
      const html = graphiqlHtml("/graphql")

      expect(html).toContain("margin: 0")
    })

    it("should handle endpoints with special characters", () => {
      const html = graphiqlHtml("/api/graphql?version=2")

      expect(html).toContain("url: '/api/graphql?version=2'")
    })
  })
})
