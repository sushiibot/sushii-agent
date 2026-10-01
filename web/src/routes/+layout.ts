export const ssr = false;
export const prerender = false;

let faked: Promise<void> | null = null;

// `bun dev` with ?fake drives the whole app from in-memory fakes over the one hub. The import sits
// behind DEV so a production build never contains the fakes or their fixtures.
export async function load({ url }) {
	if (import.meta.env.DEV && url.searchParams.has('fake')) {
		faked ??= import('./dev-fakes').then((m) => m.installFakes());
		await faked;
	}
	return {};
}
