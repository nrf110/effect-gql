// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://nrf110.github.io',
	base: '/effect-graphql',
	integrations: [
		starlight({
			title: 'Effect GraphQL',
			description: 'Type-safe GraphQL with Effect-TS',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/nrf110/effect-graphql' },
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
						{ label: 'Error Handling', slug: 'guides/error-handling' },
						{ label: 'Server Integration', slug: 'guides/server-integration' },
						{ label: 'Subscriptions', slug: 'guides/subscriptions' },
						{ label: 'DataLoader', slug: 'guides/dataloader' },
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
						content: 'https://nrf110.github.io/effect-graphql/og-image.png',
					},
				},
			],
		}),
	],
});
