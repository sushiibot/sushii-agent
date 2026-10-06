/** Text snapshots only. Drafts, queued messages and the versioned PWA shell use separate storage. */
export const OFFLINE_MAX_BYTES = 50 * 1024 * 1024;

export interface CachedResponse {
	path: string;
	group: string;
	text: string;
	bytes: number;
	savedAt: number;
	/** Missing on older snapshots; fall back to their download time. */
	usedAt?: number;
}

export function cacheGroup(path: string): string | null {
	if (path === '/chats') return 'list';
	if (/^\/chat\/history\?/.test(path)) return 'main';
	const thread = /^\/threads\/([^/?]+)(?:\/chat\/history\?[^#]*)?$/.exec(path);
	return thread ? `thread:${thread[1]}` : null;
}

/** Storage is the only retention limit. Evict individual least recently used responses. */
export function retainedResponses(rows: CachedResponse[]): CachedResponse[] {
	let bytes = rows.reduce((n, r) => n + r.bytes, 0);
	const oldest = [...rows].sort((a, b) => (a.usedAt ?? a.savedAt) - (b.usedAt ?? b.savedAt));
	const removed = new Set<string>();
	for (const row of oldest) {
		if (bytes <= OFFLINE_MAX_BYTES) break;
		removed.add(row.path);
		bytes -= row.bytes;
	}
	return rows.filter((r) => !removed.has(r.path));
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

export async function saveResponse(path: string, text: string, priority = Date.now()) {
	const group = cacheGroup(path);
	if (!group) return;
	const bytes = new TextEncoder().encode(path + text).byteLength;
	if (bytes > OFFLINE_MAX_BYTES) return;
	try {
		await update((rows) => [
			...rows.filter((r) => r.path !== path),
			{
				path,
				group,
				text,
				bytes,
				savedAt: Date.now(),
				usedAt: Math.max(priority, rows.find((r) => r.path === path)?.usedAt ?? 0)
			}
		]);
	} catch {
		// Private mode, storage pressure or a full device must never break a live request.
	}
}

export async function cachedResponse(path: string): Promise<Response | null> {
	if (!cacheGroup(path)) return null;
	try {
		const rows = await update((rows) =>
			rows.map((row) => (row.path === path ? { ...row, usedAt: Date.now() } : row))
		);
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
