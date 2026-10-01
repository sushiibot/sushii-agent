import { api, type Me } from '$lib/core/api';
import {
	currentPushStatus,
	disablePush,
	enablePush,
	PushSetupError,
	watchPermission,
	type PushStatus
} from '$lib/core/pwa/push';
import { pwa } from '$lib/core/pwa/pwa.svelte';
import { applyTheme, readTheme, type ThemeChoice } from '$lib/core/pwa/theme';
import { Remote } from '$lib/core/remote.svelte';

const errorText = (err: unknown) =>
	err instanceof Error ? err.message : 'Something went wrong. Try again.';

export class SettingsStore {
	me = new Remote<Me>(() => api.me());
	push = $state<PushStatus | 'checking'>('checking');
	pushBusy = $state(false);
	pushError = $state<string | null>(null);
	testBusy = $state(false);
	testResult = $state<{ ok: boolean; text: string } | null>(null);
	theme = $state<ThemeChoice>('system');
	installFailed = $state(false);

	/** Loads everything the screen shows; returns the cleanup for when it leaves. */
	open(): () => void {
		this.push = 'checking';
		this.pushError = null;
		this.testResult = null;
		this.installFailed = false;
		this.theme = readTheme();
		void this.me.refetch();
		void this.#loadPush();
		return watchPermission(() => void this.#refreshPush());
	}

	async #loadPush() {
		try {
			this.push = await currentPushStatus();
		} catch (err) {
			this.push = 'unavailable';
			this.pushError = errorText(err);
		}
	}

	// Coming back from Android settings, or a permission change, updates the switch in place.
	async #refreshPush() {
		if (this.pushBusy) return;
		const wasBlocked = this.push === 'blocked';
		try {
			const next = await currentPushStatus();
			if (this.pushBusy) return;
			this.push = next;
			if (wasBlocked && next !== 'blocked') this.pushError = null;
		} catch {
			// Keep the last known state; the next visit checks again.
		}
	}

	async togglePush() {
		if (this.pushBusy) return;
		this.pushBusy = true;
		this.pushError = null;
		this.testResult = null;
		try {
			if (this.push === 'on') {
				await disablePush();
				this.push = 'off';
			} else {
				await enablePush();
				this.push = 'on';
			}
			pwa.markPushSynced();
		} catch (err) {
			if (err instanceof PushSetupError) this.push = err.status;
			this.pushError = errorText(err);
		} finally {
			this.pushBusy = false;
		}
	}

	async sendTest() {
		this.testBusy = true;
		this.testResult = null;
		try {
			const { sent, pruned } = await api.testPush();
			const devices = sent === 1 ? '1 device' : `${sent} devices`;
			const expired = pruned ? ` Removed ${pruned} expired.` : '';
			this.testResult = {
				ok: sent > 0,
				text:
					sent > 0
						? `Sent to ${devices}.${expired}`
						: `No device received it.${expired} Turn notifications off and on again.`
			};
		} catch (err) {
			this.testResult = { ok: false, text: errorText(err) };
		} finally {
			this.testBusy = false;
		}
	}

	chooseTheme(choice: ThemeChoice) {
		this.theme = choice;
		applyTheme(choice);
	}

	async install() {
		this.installFailed = (await pwa.install()) === 'failed';
	}
}

let store: SettingsStore | null = null;

export function settingsStore(): SettingsStore {
	return (store ??= new SettingsStore());
}
