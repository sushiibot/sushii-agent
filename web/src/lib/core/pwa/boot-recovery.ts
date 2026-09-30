// SvelteKit's last-resort error page parses an HTML string, which Trusted Types blocks, so a
// failed boot would leave a blank screen. This reloads once for a stale or missing
// chunk, and otherwise draws a plain fallback with DOM calls.

const RELOAD_KEY = 'sushii-boot-reload';

let booted = false;
let reloading = false;
let shown = false;

/** Called once the root layout mounts; after that Kit handles chunk failures itself. */
export function markBooted() {
	booted = true;
	try {
		sessionStorage.removeItem(RELOAD_KEY);
	} catch {
		// Storage off: nothing was recorded either.
	}
}

function reloadOnce(): boolean {
	try {
		if (sessionStorage.getItem(RELOAD_KEY)) return false;
		sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
	} catch {
		// Without storage there is no loop guard, so show the fallback instead.
		return false;
	}
	reloading = true;
	location.reload();
	return true;
}

function showFallback() {
	if (booted || reloading || shown) return;
	shown = true;
	const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
		const node = document.createElement(tag);
		if (text) node.textContent = text;
		return node;
	};
	const main = el('main');
	Object.assign(main.style, {
		display: 'flex',
		flexDirection: 'column',
		gap: '12px',
		padding: '48px 16px',
		maxWidth: '32rem',
		margin: '0 auto',
		font: '16px/1.5 system-ui, sans-serif'
	});
	const heading = el('h1', "sushii-agent couldn't start");
	heading.style.fontSize = '20px';
	heading.style.margin = '0';
	const text = el('p', 'Check your connection, then try again.');
	text.style.margin = '0';
	const retry = el('button', 'Try again');
	retry.type = 'button';
	Object.assign(retry.style, { minHeight: '48px', padding: '0 24px', alignSelf: 'flex-start' });
	retry.addEventListener('click', () => location.reload());
	main.append(heading, text, retry);
	document.documentElement.style.colorScheme = 'light dark';
	Object.assign(document.body.style, { background: 'Canvas', color: 'CanvasText', margin: '0' });
	document.body.replaceChildren(main);
}

// App code has no string-to-markup sinks (the raw-HTML lint), so a blocked sink before boot can
// only be Kit's error page.
const isFatalPageBlock = (e: SecurityPolicyViolationEvent) => e.blockedURI === 'trusted-types-sink';

export function installBootRecovery() {
	if (typeof window === 'undefined') return;
	window.addEventListener('vite:preloadError', () => {
		if (!booted && !reloading) reloadOnce();
	});
	window.addEventListener('securitypolicyviolation', (e) => {
		if (isFatalPageBlock(e)) showFallback();
	});
	window.addEventListener('unhandledrejection', (e) => {
		if (e.reason instanceof TypeError && /TrustedHTML/.test(e.reason.message)) showFallback();
	});
}
