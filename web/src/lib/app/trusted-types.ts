// Policy names must match the `trusted-types` CSP directive in src/surfaces/web/static.ts.
export const SW_POLICY = 'sushii-sw-url';
export const SERVICE_WORKER_URL = '/service-worker.js';

// lib.dom has no Trusted Types declarations yet.
interface ScriptUrlPolicy {
	createScriptURL(url: string): unknown;
}
interface PolicyFactory {
	createPolicy(name: string, rules: { createScriptURL(url: string): string }): ScriptUrlPolicy;
}

let swPolicy: ScriptUrlPolicy | null | undefined;

/** The only script URL the app loads by string: its own service worker. Under enforced Trusted Types
 *  `register()` rejects a plain string, so this returns a TrustedScriptURL typed as a string. */
export function serviceWorkerUrl(): string {
	if (swPolicy === undefined) {
		const tt = (globalThis as { trustedTypes?: PolicyFactory }).trustedTypes;
		swPolicy =
			tt?.createPolicy(SW_POLICY, {
				createScriptURL(url: string) {
					if (url !== SERVICE_WORKER_URL) throw new TypeError(`blocked script URL: ${url}`);
					return url;
				}
			}) ?? null;
	}
	return (swPolicy?.createScriptURL(SERVICE_WORKER_URL) ?? SERVICE_WORKER_URL) as string;
}
