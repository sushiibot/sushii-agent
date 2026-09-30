import tailwindcss from '@tailwindcss/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';

// Builds the render components on their own, so e2e can drive them in Chromium (V8) under the
// same Trusted Types policy the gateway serves, before any route wires them up.
const web = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

// The policy names mirror TRUSTED_TYPE_POLICIES in src/surfaces/web/static.ts; a root test keeps them in step.
const CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' blob:",
	"require-trusted-types-for 'script'",
	'trusted-types svelte-trusted-html sushii-sw-url'
].join('; ');

function csp(): Plugin {
	return {
		name: 'harness-csp',
		configurePreviewServer(server) {
			server.middlewares.use((_req, res, next) => {
				res.setHeader('Content-Security-Policy', CSP);
				next();
			});
		}
	};
}

export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	plugins: [csp(), tailwindcss(), svelte({ compilerOptions: { runes: true } })],
	resolve: {
		alias: {
			$lib: web('src/lib'),
			'decode-named-character-reference': web(
				'node_modules/decode-named-character-reference/index.js'
			)
		}
	},
	build: {
		outDir: web('e2e/harness/dist'),
		emptyOutDir: true,
		modulePreload: { polyfill: false }
	}
});
