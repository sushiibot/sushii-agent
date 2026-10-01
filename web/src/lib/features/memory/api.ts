import { enc, featureHttp } from '$lib/core/feature-http';
import type { MemoryFileDetail, MemoryOverview, MemoryWriteRecord } from './types';

export interface MemoryApi {
	overview(): Promise<MemoryOverview>;
	/** null: no such file. */
	file(id: string): Promise<MemoryFileDetail | null>;
	/** null: no such write. */
	write(id: string): Promise<MemoryWriteRecord | null>;
	/** Undoes a write with a new commit; the write stays in the list, marked reverted. */
	revert(id: string): Promise<MemoryWriteRecord>;
	/** Re-applies a reverted write. */
	restore(id: string): Promise<MemoryWriteRecord>;
}

const http = featureHttp("Memory isn't available yet.");

export const httpMemoryApi: MemoryApi = {
	overview: () => http.get('/memory'),
	file: (id) => http.find(`/memory/files/${enc(id)}`),
	write: (id) => http.find(`/memory/writes/${enc(id)}`),
	revert: (id) => http.post(`/memory/writes/${enc(id)}/revert`),
	restore: (id) => http.post(`/memory/writes/${enc(id)}/restore`)
};
