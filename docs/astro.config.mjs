// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://nrf110.github.io',
	base: '/effect-gql',
	integrations: [
		starlight({
			title: 'Effect GQL',
			description: 'Type-safe GraphQL with Effect-TS',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/nrf110/effect-gql' },
			],
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Installation', slug: 'getting-started/installation' },
						{ label: 'Quick Start', slug: 'getting-started/quick-start' },
						{ label: 'Your First Schema', slug: 'getting-started/first-schema' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Schema Builder', slug: 'guides/schema-builder' },
						{ label: 'Resolvers', slug: 'guides/resolvers' },
						{ label: 'Resolver Context', slug: 'guides/resolver-context' },
						{ label: 'Middleware', slug: 'guides/middleware' },
						{ label: 'Extensions', slug: 'guides/extensions' },
						{ label: 'Error Handling', slug: 'guides/error-handling' },
						{ label: 'Server Integration', slug: 'guides/server-integration' },
						{ label: 'Subscriptions', slug: 'guides/subscriptions' },
						{ label: 'DataLoader', slug: 'guides/dataloader' },
						{ label: 'CLI Tools', slug: 'guides/cli' },
						{ label: 'Complexity Limiting', slug: 'guides/complexity-limiting' },
						{ label: 'Response Caching', slug: 'guides/response-caching' },
						{ label: 'OpenTelemetry', slug: 'guides/opentelemetry' },
						{ label: 'Apollo Federation', slug: 'guides/federation' },
						{ label: 'Persisted Queries', slug: 'guides/persisted-queries' },
						{ label: 'File Uploads', slug: 'guides/file-uploads' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Overview', slug: 'reference' },
						{ label: 'GraphQLSchemaBuilder', slug: 'reference/schema-builder' },
						{ label: 'Pipe Functions', slug: 'reference/pipe-functions' },
						{ label: 'Type Mapping', slug: 'reference/type-mapping' },
						{ label: 'Error Types', slug: 'reference/error-types' },
						{ label: 'Context API', slug: 'reference/context-api' },
						{ label: 'Loader API', slug: 'reference/loader-api' },
						{ label: 'Server API', slug: 'reference/server-api' },
						{ label: 'CLI API', slug: 'reference/cli' },
					],
				},
				{
					label: 'Examples',
					autogenerate: { directory: 'examples' },
				},
			],
			customCss: ['./src/styles/custom.css'],
			head: [
				{
					tag: 'meta',
					attrs: {
						property: 'og:image',
						content: 'https://nrf110.github.io/effect-gql/og-image.png',
					},
				},
			],
		}),
	],
});
