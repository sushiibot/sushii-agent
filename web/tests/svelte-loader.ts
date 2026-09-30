import { plugin } from 'bun';
import { compile, compileModule } from 'svelte/compiler';

// Compiles components for svelte/server so unit tests can render real markup without a browser.
plugin({
	name: 'svelte-ssr',
	setup(build) {
		build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
			const source = await Bun.file(path).text();
			const { js } = compile(source, { filename: path, generate: 'server', runes: true });
			return { contents: js.code, loader: 'js' };
		});
		build.onLoad({ filter: /\.svelte\.(ts|js)$/ }, async ({ path }) => {
			const source = await Bun.file(path).text();
			const ts = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
			const { js } = compileModule(ts, { filename: path, generate: 'server' });
			return { contents: js.code, loader: 'js' };
		});
	}
});
