/**
 * Generate HTML for GraphiQL IDE, loading dependencies from CDN
 */
export const graphiqlHtml = (endpoint: string): string => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GraphiQL</title>
    <link
      rel="stylesheet"
      href="https://unpkg.com/graphiql@3/graphiql.min.css"
    />
  </head>
  <body style="margin: 0; overflow: hidden;">
    <div id="graphiql" style="height: 100vh;"></div>
    <script
      crossorigin
      src="https://unpkg.com/react@18/umd/react.production.min.js"
    ></script>
    <script
      crossorigin
      src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"
    ></script>
    <script
      crossorigin
      src="https://unpkg.com/graphiql@3/graphiql.min.js"
    ></script>
    <script>
      const fetcher = GraphiQL.createFetcher({
        url: '${endpoint}',
      });
      ReactDOM.createRoot(document.getElementById('graphiql')).render(
        React.createElement(GraphiQL, { fetcher })
      );
    </script>
  </body>
</html>`
