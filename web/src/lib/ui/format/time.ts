// Times are formatted against a `now` the caller passes in, so screens, fixtures and screenshots
// agree on what "today" is.

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function localDay(t: number): number {
	const d = new Date(t);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Whole local days between two instants: 0 today, 1 yesterday. */
export function daysBetween(then: number, now: number): number {
	return Math.round((localDay(now) - localDay(then)) / DAY);
}

export function clock(t: number): string {
	return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function date(t: number, now: number): string {
	const sameYear = new Date(t).getFullYear() === new Date(now).getFullYear();
	return new Date(t).toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		...(sameYear ? {} : { year: 'numeric' })
	});
}

/** "just now", "12 min ago" and a clock time today; "Yesterday 18:02"; a date beyond. */
export function ago(iso: string, now: number): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return '';
	const diff = now - t;
	if (diff < MIN) return 'just now';
	if (diff < 60 * MIN && daysBetween(t, now) === 0) return `${Math.floor(diff / MIN)} min ago`;
	const days = daysBetween(t, now);
	if (days === 0) return clock(t);
	if (days === 1) return `Yesterday ${clock(t)}`;
	return date(t, now);
}

/** A section label for a day: "Today", "Yesterday", or "Mon, Sep 28". */
export function dayLabel(t: number, now: number): string {
	const days = daysBetween(t, now);
	if (days === 0) return 'Today';
	if (days === 1) return 'Yesterday';
	const sameYear = new Date(t).getFullYear() === new Date(now).getFullYear();
	return new Date(t).toLocaleDateString(undefined, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		...(sameYear ? {} : { year: 'numeric' })
	});
}

/** A calendar date ("2026-09-29") as a local-midnight instant. */
export function fromDate(ymd: string): number {
	const [y, m, d] = ymd.split('-').map(Number);
	return new Date(y, m - 1, d).getTime();
}

/** The local calendar date of an instant, as "YYYY-MM-DD". */
export function toDate(t: number): string {
	const d = new Date(t);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Tuesday, September 29" for a page title. */
export function longDate(ymd: string, now: number): string {
	const t = fromDate(ymd);
	const sameYear = new Date(t).getFullYear() === new Date(now).getFullYear();
	return new Date(t).toLocaleDateString(undefined, {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		...(sameYear ? {} : { year: 'numeric' })
	});
}

/** "42s", "3 min", "1 h 12 min". */
export function duration(ms: number): string {
	if (ms < MIN) return `${Math.max(1, Math.round(ms / 1000))}s`;
	const mins = Math.round(ms / MIN);
	if (mins < 60) return `${mins} min`;
	const h = Math.floor(mins / 60);
	const m = mins % 60;
	return m ? `${h} h ${m} min` : `${h} h`;
}

/** Groups items under day labels, newest day first, keeping the given order inside a day. */
export function byDay<T>(
	items: readonly T[],
	at: (item: T) => number,
	now: number
): { label: string; items: T[] }[] {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const t = at(item);
		const key = toDate(t);
		const list = groups.get(key) ?? [];
		list.push(item);
		groups.set(key, list);
	}
	return [...groups.entries()]
		.sort(([a], [b]) => b.localeCompare(a))
		.map(([key, list]) => ({ label: dayLabel(fromDate(key), now), items: list }));
}
