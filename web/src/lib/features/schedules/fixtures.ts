// Typed fixtures for Schedules, shared by the fake API, the prototype board and tests. Made up.
import type { JobDetail } from './types';

const MIN = 60_000;
const at = (now: number, mins: number) => new Date(now + mins * MIN).toISOString();
const RUN = {
	triage: '01K6B4D2F4H6K8M0P2R4T6V8X0',
	nightlySync: '01K6B2N8W3J5Q7R9T1V3X5Z7A9',
	weeklyDeps: '01K6AZ8B0D2F4H6K8M0P2R4T6V',
	brief: '01K6AW0E2G4J6M8P0R2T4W6Y8A',
	syncOld: '01K6AT9F1H3K5N7Q9S1V3X5Z7B'
};

/** The next local clock time h:m after `now`. */
function nextAt(now: number, h: number, m: number): string {
	const d = new Date(now);
	d.setHours(h, m, 0, 0);
	if (d.getTime() <= now) d.setDate(d.getDate() + 1);
	return d.toISOString();
}

export function jobDetails(now: number): JobDetail[] {
	const H = 60;
	const D = 24 * H;
	return [
		{
			id: 'nightly-sync',
			name: 'Back up projects',
			schedule: 'Nightly 02:00',
			nextRun: nextAt(now, 2, 0),
			enabled: true,
			prompt: 'Back up the projects folder to the home server and say if anything failed.',
			last: {
				at: at(now, -11),
				result: 'failed',
				note: 'rsync could not reach the backup server (exit 30)',
				runId: RUN.nightlySync
			},
			runs: [
				{
					at: at(now, -11),
					result: 'failed',
					note: 'rsync could not reach the backup server (exit 30)',
					runId: RUN.nightlySync
				},
				{
					at: at(now, -D - 11),
					result: 'quiet',
					note: 'Backed up, nothing to report',
					runId: RUN.syncOld
				},
				{ at: at(now, -2 * D - 11), result: 'quiet', note: 'Backed up, nothing to report' }
			]
		},
		{
			id: 'inbox-triage',
			name: 'Inbox watch',
			schedule: 'Every 30 min, 08:00–22:00',
			nextRun: at(now, 19),
			enabled: true,
			prompt: 'Sort new mail and flag anything that needs me today.',
			last: {
				at: at(now, -4),
				result: 'quiet',
				note: '12 new, none needed you',
				runId: RUN.triage
			},
			runs: [
				{ at: at(now, -4), result: 'quiet', note: '12 new, none needed you', runId: RUN.triage },
				{ at: at(now, -34), result: 'sent', note: 'Flagged the garage invoice' },
				{ at: at(now, -64), result: 'suppressed', note: 'Same newsletter as the run before' }
			]
		},
		{
			id: 'briefing',
			name: 'Morning briefing',
			schedule: 'Daily 07:30',
			nextRun: nextAt(now, 7, 30),
			enabled: true,
			prompt: 'Write my morning briefing with sources.',
			last: { at: at(now, -9 * H), result: 'sent', note: '5 items', runId: RUN.brief },
			runs: [
				{ at: at(now, -9 * H), result: 'sent', note: '5 items', runId: RUN.brief },
				{ at: at(now, -D - 9 * H), result: 'sent', note: '3 items' }
			]
		},
		{
			id: 'weekly-deps',
			name: 'Dependency check',
			schedule: 'Mondays 07:00',
			nextRun: at(now, 5 * D),
			enabled: true,
			prompt: 'Check project dependencies for updates and open a PR for safe ones.',
			last: {
				at: at(now, -26 * H),
				result: 'sent',
				note: '3 updates, none are security fixes',
				runId: RUN.weeklyDeps
			},
			runs: [
				{
					at: at(now, -26 * H),
					result: 'sent',
					note: '3 updates, none are security fixes',
					runId: RUN.weeklyDeps
				}
			]
		},
		{
			id: 'heartbeat',
			name: 'Heartbeat',
			schedule: 'Hourly, 08:00–22:00',
			nextRun: at(now, 19),
			enabled: true,
			prompt: 'Check whether anything is due.',
			last: { at: at(now, -11 * H), result: 'outside-hours', note: 'Active hours start at 08:00' },
			runs: [{ at: at(now, -11 * H), result: 'outside-hours', note: 'Active hours start at 08:00' }]
		},
		{
			id: 'repo-backup-check',
			name: 'Backup check',
			schedule: 'Sundays 20:00',
			nextRun: null,
			enabled: false,
			prompt: 'Check that last week’s backups can be restored.',
			last: { at: at(now, -3 * D), result: 'skipped', note: 'Paused by you' },
			runs: [{ at: at(now, -3 * D), result: 'skipped', note: 'Paused by you' }]
		}
	];
}
