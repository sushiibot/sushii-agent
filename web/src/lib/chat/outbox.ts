export interface OutboxEntry {
	clientId: string;
	text: string;
	uploadIds: string[];
	/** The resized photos, kept so a message queued past the server's 24h orphan GC can re-upload them. */
	photos?: { name: string; blob: Blob; uploadId: string; uploadedAt: number }[];
	at: string;
	/** The bot answered 202 at least once, so it holds the message durably. */
	posted: boolean;
}

export interface KeyValue<T> {
	all(): Promise<T[]>;
	put(v: T): Promise<void>;
	delete(key: string): Promise<void>;
}

const DB = 'agent-chat';
const VERSION = 1;

function open(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB, VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains('outbox'))
				db.createObjectStore('outbox', { keyPath: 'clientId' });
			if (!db.objectStoreNames.contains('drafts'))
				db.createObjectStore('drafts', { keyPath: 'id' });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function done<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function memory<T>(key: (v: T) => string): KeyValue<T> {
	const m = new Map<string, T>();
	return {
		all: async () => [...m.values()],
		put: async (v) => void m.set(key(v), v),
		delete: async (k) => void m.delete(k)
	};
}

/** An IndexedDB object store, or a Map when IndexedDB is missing or refuses to open (private mode). */
function store<T>(name: 'outbox' | 'drafts', key: (v: T) => string): KeyValue<T> {
	let db: Promise<IDBDatabase | null> | null = null;
	const fallback = memory(key);
	const get = () =>
		(db ??= typeof indexedDB === 'undefined' ? Promise.resolve(null) : open().catch(() => null));
	const tx = async (mode: IDBTransactionMode) =>
		(await get())?.transaction(name, mode).objectStore(name);
	return {
		async all() {
			const s = await tx('readonly');
			return s ? ((await done(s.getAll())) as T[]) : fallback.all();
		},
		async put(v) {
			const s = await tx('readwrite');
			if (s) await done(s.put(v));
			else await fallback.put(v);
		},
		async delete(k) {
			const s = await tx('readwrite');
			if (s) await done(s.delete(k));
			else await fallback.delete(k);
		}
	};
}

export const outbox = store<OutboxEntry>('outbox', (e) => e.clientId);
export const drafts = store<{ id: string; text: string }>('drafts', (d) => d.id);
