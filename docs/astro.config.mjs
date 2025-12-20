// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://nickfisher.dev',
	base: '/effect-graphql-prototype',
	integrations: [
		starlight({
			title: 'Effect GraphQL',
			description: 'Type-safe GraphQL with Effect-TS',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/nickfisher/effect-graphql-prototype' },
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
						{ label: 'Error Handling', slug: 'guides/error-handling' },
					],
				},
				{
					label: 'Reference',
					autogenerate: { directory: 'reference' },
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
						content: 'https://nickfisher.dev/effect-graphql-prototype/og-image.png',
					},
				},
			],
		}),
	],
});
