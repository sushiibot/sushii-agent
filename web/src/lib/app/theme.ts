export type ThemeChoice = 'system' | 'light' | 'dark';

// Kept in step with the inline script in app.html, which applies the theme before first paint.
const BAR = { light: '#ffffff', dark: '#0a0a0a' };

export function readTheme(): ThemeChoice {
	try {
		const t = localStorage.getItem('theme');
		return t === 'light' || t === 'dark' ? t : 'system';
	} catch {
		return 'system';
	}
}

export function applyTheme(choice: ThemeChoice) {
	try {
		if (choice === 'system') localStorage.removeItem('theme');
		else localStorage.setItem('theme', choice);
	} catch {
		// Private mode: the choice still applies for this visit.
	}
	const dark =
		choice === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : choice === 'dark';
	document.documentElement.classList.toggle('dark', dark);
	document
		.querySelector('meta[name="theme-color"]')
		?.setAttribute('content', dark ? BAR.dark : BAR.light);
}
