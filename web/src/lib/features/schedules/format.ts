import { clock, daysBetween } from '$lib/ui/format/time';
import type { Job } from './types';

/** "Next run in 19 min", "Next run tomorrow 7:30 AM", or "Paused". */
export function nextRunLine(job: Pick<Job, 'enabled' | 'nextRun'>, now: number): string {
	if (!job.enabled || !job.nextRun) return 'Paused, no next run';
	const t = Date.parse(job.nextRun);
	const mins = Math.round((t - now) / 60_000);
	if (mins <= 0) return 'Running about now';
	if (mins < 60) return `Next run in ${mins} min`;
	const days = -daysBetween(t, now);
	if (days === 0) return `Next run today ${clock(t)}`;
	if (days === 1) return `Next run tomorrow ${clock(t)}`;
	const date = new Date(t).toLocaleDateString(undefined, {
		weekday: 'short',
		month: 'short',
		day: 'numeric'
	});
	return `Next run ${date}, ${clock(t)}`;
}
