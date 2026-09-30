import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pkg from './package.json' with { type: 'json' };

// Mirrors TRUSTED_TYPE_POLICIES in src/surfaces/web/static.ts; a root test keeps the two in step.
const TRUSTED_TYPE_POLICIES = 'svelte-trusted-html sushii-sw-url';

// Enforced in `vite preview` so the e2e suite runs under the Trusted Types policy the bot serves.
// A middleware, because SvelteKit's preview server ignores `preview.headers` for pages.
function enforceTrustedTypesInPreview(): Plugin {
	return {
		name: 'enforce-trusted-types-in-preview',
		configurePreviewServer(server) {
			server.middlewares.use((_req, res, next) => {
				res.setHeader(
					'Content-Security-Policy',
					`require-trusted-types-for 'script'; trusted-types ${TRUSTED_TYPE_POLICIES}`
				);
				next();
			});
		}
	};
}

const BUILD_INPUTS = [
	'src',
	'static',
	'package.json',
	'bun.lock',
	'vite.config.ts',
	'tsconfig.json'
];

// Same inputs, same version: a deploy that leaves web/ alone ships a byte-identical service
// worker, so installed apps neither re-download the shell nor show "Update ready".
function contentVersion(): string {
	const root = fileURLToPath(new URL('.', import.meta.url));
	const hash = createHash('sha256');
	const walk = (path: string): string[] =>
		statSync(root + path).isDirectory()
			? readdirSync(root + path)
					.sort()
					.flatMap((name) => walk(`${path}/${name}`))
			: [path];
	for (const file of BUILD_INPUTS.flatMap(walk)) {
		hash
			.update(file)
			.update('\0')
			.update(readFileSync(root + file))
			.update('\0');
	}
	return `${pkg.version}+${hash.digest('hex').slice(0, 12)}`;
}

// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
const runes = ({ filename }: { filename: string }) =>
	filename.split(/[/\\]/).includes('node_modules') ? undefined : true;

// PROTO=1 swaps in a separate routes tree so the prototype board never reaches the app build.
// An env var rather than --mode, because the prerender child process re-resolves this config
// without the CLI mode.
export default defineConfig(() => {
	const proto = process.env.PROTO === '1';
	const version = process.env.APP_VERSION || contentVersion();
	return {
		// Fonts too, so the single-file prototype has no sidecar assets.
		build: proto ? { assetsInlineLimit: 200_000 } : {},
		define: {
			__APP_VERSION__: JSON.stringify(version)
		},
		resolve: {
			alias: {
				// The package's browser build decodes entities through innerHTML, a Trusted Types sink.
				'decode-named-character-reference': fileURLToPath(
					new URL('./node_modules/decode-named-character-reference/index.js', import.meta.url)
				)
			}
		},
		server: {
			proxy: { '/api': 'http://localhost:8790' }
		},

		plugins: [
			enforceTrustedTypesInPreview(),
			tailwindcss(),
			sveltekit(
				proto
					? {
							compilerOptions: { runes },
							adapter: adapter({ pages: 'build-proto', assets: 'build-proto' }),
							// A path with no file turns the service worker off for the shareable file.
							files: { routes: 'src/proto-routes', serviceWorker: 'src/no-service-worker' },
							// One self-contained HTML file, so the board can be shared without a server.
							output: { bundleStrategy: 'inline' },
							// Screens link to app routes that the board intercepts; they don't exist here.
							prerender: { crawl: false }
						}
					: {
							compilerOptions: { runes },
							adapter: adapter({ fallback: 'index.html' }),
							version: { name: version },
							// Registered by the app so it can watch for a waiting update.
							serviceWorker: { register: false }
						}
			)
		]
	};
});
