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
