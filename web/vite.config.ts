import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
const runes = ({ filename }: { filename: string }) =>
	filename.split(/[/\\]/).includes('node_modules') ? undefined : true;

// PROTO=1 swaps in a separate routes tree so the prototype board never reaches the app build.
// An env var rather than --mode, because the prerender child process re-resolves this config
// without the CLI mode.
export default defineConfig(() => {
	const proto = process.env.PROTO === '1';
	return {
		// Fonts too, so the single-file prototype has no sidecar assets.
		build: proto ? { assetsInlineLimit: 200_000 } : {},
		define: {
			__APP_VERSION__: JSON.stringify(
				process.env.APP_VERSION || `${pkg.version}+${new Date().toISOString().slice(0, 10)}`
			)
		},
		server: {
			proxy: { '/api': 'http://localhost:8790' }
		},
		plugins: [
			tailwindcss(),
			sveltekit(
				proto
					? {
							compilerOptions: { runes },
							adapter: adapter({ pages: 'build-proto', assets: 'build-proto' }),
							files: { routes: 'src/proto-routes', serviceWorker: 'src/no-service-worker' },
							// One self-contained HTML file, so the board can be shared without a server.
							output: { bundleStrategy: 'inline' },
							// Screens link to app routes that the board intercepts; they don't exist here.
							prerender: { crawl: false }
						}
					: {
							compilerOptions: { runes },
							adapter: adapter({ fallback: 'index.html' }),
							// Registered by the app so it can watch for a waiting update.
							serviceWorker: { register: false }
						}
			)
		]
	};
});
