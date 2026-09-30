import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// Fonts too, so the single-file build has no sidecar assets.
	build: { assetsInlineLimit: 200_000 },
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			// One self-contained HTML file, so the board can be shared without a server.
			output: { bundleStrategy: "inline" },
			// Screens link to real app routes that the prototype board intercepts; they don't exist yet.
			prerender: { crawl: false }
		})
	]
});
