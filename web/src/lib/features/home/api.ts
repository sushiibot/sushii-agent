import type { HomeData } from './types';

/** Home's own server calls; approvals and asks are answered through chat's API. */
export interface HomeApi {
	load(): Promise<HomeData>;
	/** Hides a failed job alert ("job:<name>") or failed run ("run:<runId>") from Home. */
	dismiss(id: string): Promise<void>;
	/** Takes a finished run ("run:<runId>") off "Ready for review" on every device. */
	opened(id: string): Promise<void>;
}
