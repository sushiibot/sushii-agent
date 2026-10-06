/** Text snapshots only. Drafts, queued messages and the versioned PWA shell use separate storage. */
export const OFFLINE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const OFFLINE_MAX_BYTES = 50 * 1024 * 1024;
export const OFFLINE_MAX_THREADS = 20;

export interface CachedResponse {
	path: string;
	group: string;
	text: string;
	bytes: number;
	savedAt: number;
}

export function cacheGroup(path: string): string | null {
	if (path === '/chats') return 'list';
	if (/^\/chat\/history\?/.test(path)) return 'main';
	const thread = /^\/threads\/([^/?]+)(?:\/chat\/history\?[^#]*)?$/.exec(path);
	return thread ? `thread:${thread[1]}` : null;
}

/** Evict whole conversations, so old pagination never survives its thread metadata. */
export function retainedResponses(rows: CachedResponse[], now = Date.now()): CachedResponse[] {
	const fresh = rows.filter((r) => now - r.savedAt < OFFLINE_TTL_MS);
	const groups = new Map<string, number>();
	for (const row of fresh) groups.set(row.group, Math.max(groups.get(row.group) ?? 0, row.savedAt));
	const threads = [...groups.keys()]
		.filter((g) => g.startsWith('thread:'))
		.sort((a, b) => groups.get(b)! - groups.get(a)!)
		.slice(0, OFFLINE_MAX_THREADS);
	let kept = fresh.filter((r) => !r.group.startsWith('thread:') || threads.includes(r.group));
	const oldest = [...new Set(kept.map((r) => r.group))].sort(
		(a, b) => groups.get(a)! - groups.get(b)!
	);
	let bytes = kept.reduce((n, r) => n + r.bytes, 0);
	for (const group of oldest) {
		if (bytes <= OFFLINE_MAX_BYTES) break;
		kept = kept.filter((r) => {
			if (r.group !== group) return true;
			bytes -= r.bytes;
			return false;
		});
	}
	return kept;
}

let database: Promise<IDBDatabase> | undefined;
function open() {
	return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open('agent-offline', 1);
		req.onupgradeneeded = () => req.result.createObjectStore('responses', { keyPath: 'path' });
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	}));
}

/** One read/write transaction serializes pruning across tabs and waits for durable commit. */
async function update(change: (rows: CachedResponse[]) => CachedResponse[]) {
	const db = await open();
	return new Promise<CachedResponse[]>((resolve, reject) => {
		const tx = db.transaction('responses', 'readwrite');
		const store = tx.objectStore('responses');
		let kept: CachedResponse[] = [];
		const req = store.getAll();
		req.onsuccess = () => {
			const rows = req.result as CachedResponse[];
			kept = retainedResponses(change(rows));
			const paths = new Set(kept.map((r) => r.path));
			for (const row of rows) if (!paths.has(row.path)) store.delete(row.path);
			const existing = new Map(rows.map((row) => [row.path, row]));
			for (const row of kept) if (existing.get(row.path) !== row) store.put(row);
		};
		tx.oncomplete = () => resolve(kept);
		tx.onerror = tx.onabort = () => reject(tx.error);
	});
}

export async function saveResponse(path: string, text: string) {
	const group = cacheGroup(path);
	if (!group) return;
	const bytes = new TextEncoder().encode(path + text).byteLength;
	if (bytes > OFFLINE_MAX_BYTES) return;
	try {
		await update((rows) => [
			...rows.filter((r) => r.path !== path),
			{ path, group, text, bytes, savedAt: Date.now() }
		]);
	} catch {
		// Private mode, storage pressure or a full device must never break a live request.
	}
}

export async function cachedResponse(path: string): Promise<Response | null> {
	if (!cacheGroup(path)) return null;
	try {
		const rows = await update((rows) => rows);
		const row = rows.find((r) => r.path === path);
		if (!row) return null;
		let text = row.text;
		if (path === '/chats') {
			const data = JSON.parse(text);
			// Only advertise threads that can actually be opened on this device.
			data.threads = data.threads.filter((t: { id: string }) =>
				rows.some((r) => r.path === `/threads/${encodeURIComponent(t.id)}`)
			);
			text = JSON.stringify(data);
		}
		return new Response(text, {
			headers: { 'content-type': 'application/json', 'x-offline-snapshot': String(row.savedAt) }
		});
	} catch {
		return null;
	}
}

export async function forgetResponse(path: string) {
	const group = cacheGroup(path);
	try {
		await update((rows) => rows.filter((r) => r.group !== group));
	} catch {
		// Optional cache; failures do not affect the live API.
	}
}

export async function clearResponses() {
	try {
		await update(() => []);
	} catch {
		/* Optional storage. */
	}
}
