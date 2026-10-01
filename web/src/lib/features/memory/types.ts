// View models for Memory. The bot has no memory routes yet; this is what they will need to serve.
import type { DiffLine } from '$lib/ui/diff/diff-view.svelte';

export type { DiffLine };

export interface MemoryFileSummary {
	/** URL-safe id; the path can hold slashes. */
	id: string;
	/** Relative to the workspace's memory folder. */
	path: string;
	/** One line on what the file holds. */
	about: string;
	updatedAt: string;
	lines: number;
}

export interface MemoryFile extends MemoryFileSummary {
	/** The file as the agent wrote it, markdown. Untrusted: render it only through Markdown. */
	content: string;
}

export interface MemoryWriteRecord {
	id: string;
	fileId: string;
	path: string;
	/** What changed, in one line. */
	summary: string;
	at: string;
	/** The memory repo's commit for this write. */
	commit: string;
	run?: { id: string; title: string };
	thread?: { id: string; title: string };
	/** Set when the run had read outside content before writing, in plain words. */
	taint?: string;
	diff: DiffLine[];
	/** Undone with a revert commit; Restore re-applies the write. */
	reverted?: { at: string; commit: string };
}

export interface MemoryOverview {
	files: MemoryFileSummary[];
	/** Newest first. */
	writes: MemoryWriteRecord[];
}

export interface MemoryFileDetail {
	file: MemoryFile;
	writes: MemoryWriteRecord[];
}
