<script lang="ts">
	import { onMount } from 'svelte';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import BellRing from '@lucide/svelte/icons/bell-ring';
	import AppShell from '$lib/agent/app-shell.svelte';
	import { Button } from '$lib/components/ui/button';
	import ConnectionBanner from '$lib/app/connection-banner.svelte';
	import UpdateToast from '$lib/app/update-toast.svelte';
	import { api, type Me } from '$lib/api';
	import { pwa } from '$lib/app/pwa.svelte';
	import {
		currentPushStatus,
		disablePush,
		enablePush,
		PushSetupError,
		type PushStatus
	} from '$lib/app/push';
	import { applyTheme, readTheme, type ThemeChoice } from '$lib/app/theme';
	import { cn } from '$lib/utils';

	const version = __APP_VERSION__;

	let me = $state<Me | null>(null);
	let meError = $state<string | null>(null);
	let meSlow = $state(false);

	let push = $state<PushStatus | 'checking'>('checking');
	let pushBusy = $state(false);
	let pushError = $state<string | null>(null);
	let testBusy = $state(false);
	let testResult = $state<{ ok: boolean; text: string } | null>(null);

	let theme = $state<ThemeChoice>('system');

	const errorText = (err: unknown) =>
		err instanceof Error ? err.message : 'Something went wrong. Try again.';

	async function loadMe() {
		meError = null;
		meSlow = false;
		const slow = setTimeout(() => (meSlow = true), 300);
		try {
			me = await api.me();
		} catch (err) {
			meError = errorText(err);
		} finally {
			clearTimeout(slow);
		}
	}

	async function loadPush() {
		try {
			push = await currentPushStatus();
		} catch (err) {
			push = 'unavailable';
			pushError = errorText(err);
		}
	}

	async function togglePush() {
		if (pushBusy) return;
		pushBusy = true;
		pushError = null;
		testResult = null;
		try {
			if (push === 'on') {
				await disablePush();
				push = 'off';
			} else {
				await enablePush();
				push = 'on';
			}
		} catch (err) {
			if (err instanceof PushSetupError) push = err.status;
			pushError = errorText(err);
		} finally {
			pushBusy = false;
		}
	}

	async function sendTest() {
		testBusy = true;
		testResult = null;
		try {
			const { sent, pruned } = await api.testPush();
			const devices = sent === 1 ? '1 device' : `${sent} devices`;
			const expired = pruned ? ` Removed ${pruned} expired.` : '';
			testResult = {
				ok: sent > 0,
				text:
					sent > 0
						? `Sent to ${devices}.${expired}`
						: `No device received it.${expired} Turn notifications off and on again.`
			};
		} catch (err) {
			testResult = { ok: false, text: errorText(err) };
		} finally {
			testBusy = false;
		}
	}

	function chooseTheme(choice: ThemeChoice) {
		theme = choice;
		applyTheme(choice);
	}

	onMount(() => {
		theme = readTheme();
		void loadMe();
		void loadPush();
	});

	const pushLabel = $derived(
		{
			checking: 'Checking…',
			unsupported: "This browser can't receive notifications",
			blocked: 'Blocked in Android settings',
			unavailable: 'Not available right now',
			off: 'Off for this device',
			on: 'On for this device'
		}[push]
	);
	const pushToggleDisabled = $derived(
		pushBusy || push === 'checking' || push === 'unsupported' || push === 'blocked'
	);
	const themes: { id: ThemeChoice; label: string }[] = [
		{ id: 'system', label: 'System' },
		{ id: 'light', label: 'Light' },
		{ id: 'dark', label: 'Dark' }
	];
</script>

<svelte:head><title>Settings · Agent</title></svelte:head>

{#snippet banner()}<ConnectionBanner />{/snippet}
{#snippet toast()}<UpdateToast />{/snippet}

<AppShell
	active="more"
	title="Settings"
	back={{ href: '/', label: 'Back to Main' }}
	{banner}
	toast={pwa.waiting ? toast : undefined}
>
	<div class="mx-auto flex max-w-2xl flex-col gap-8 px-4 pt-5 pb-10">
		<section aria-labelledby="account" class="flex flex-col gap-2">
			<h2 id="account" class="text-sm font-medium text-muted-foreground">Account</h2>
			<div class="flex min-h-16 flex-col justify-center rounded-xl border bg-card px-4 py-3">
				{#if me}
					<p class="text-sm text-muted-foreground">Signed in as</p>
					<p class="font-medium [overflow-wrap:anywhere]" data-testid="login">
						{me.displayName ?? me.login}
					</p>
					{#if me.displayName}
						<p class="text-sm [overflow-wrap:anywhere] text-muted-foreground">{me.login}</p>
					{/if}
				{:else if meError}
					<div class="flex flex-col items-start gap-3" role="alert">
						<p class="text-sm">
							<span class="font-medium">Couldn't load your account.</span>
							{meError}
						</p>
						<Button variant="outline" onclick={loadMe}><RotateCcw />Try again</Button>
					</div>
				{:else if meSlow}
					<p class="flex items-center gap-2 text-sm text-muted-foreground" role="status">
						<LoaderCircle
							class="size-4 animate-spin motion-reduce:animate-none"
							aria-hidden="true"
						/>
						Loading your account…
					</p>
				{/if}
			</div>
		</section>

		<section aria-labelledby="notifications" class="flex flex-col gap-2">
			<h2 id="notifications" class="text-sm font-medium text-muted-foreground">Notifications</h2>
			<div class="flex flex-col divide-y rounded-xl border bg-card">
				<button
					type="button"
					role="switch"
					aria-checked={push === 'on'}
					aria-describedby="push-state"
					disabled={pushToggleDisabled}
					onclick={togglePush}
					class="flex min-h-16 w-full items-center gap-3 rounded-xl px-4 py-3 text-left disabled:cursor-not-allowed"
				>
					<span class="flex min-w-0 flex-1 flex-col gap-0.5">
						<span class="font-medium">Notify this device</span>
						<span id="push-state" class="text-sm text-muted-foreground">
							{#if pushBusy}
								{push === 'on' ? 'Turning off…' : 'Turning on…'}
							{:else}
								{pushLabel}
							{/if}
						</span>
					</span>
					<span
						aria-hidden="true"
						class={cn(
							'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 transition-colors duration-150',
							push === 'on' ? 'bg-primary' : 'bg-input',
							pushToggleDisabled && 'opacity-50'
						)}
					>
						<span
							class={cn(
								'size-6 rounded-full bg-background shadow-sm transition-transform duration-150 motion-reduce:transition-none',
								push === 'on' && 'translate-x-5'
							)}
						></span>
					</span>
				</button>
				<div class="flex flex-col gap-3 px-4 py-4">
					<p class="text-sm text-muted-foreground">
						Only when the agent needs you, a run fails, or something you asked about finishes.
					</p>
					<Button
						variant="outline"
						class="w-full"
						disabled={push !== 'on' || testBusy}
						onclick={sendTest}
					>
						{#if testBusy}
							<LoaderCircle class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
							Sending…
						{:else}
							<BellRing aria-hidden="true" />Send test notification
						{/if}
					</Button>
					{#if testResult}
						<p
							role={testResult.ok ? 'status' : 'alert'}
							class={cn('text-sm', !testResult.ok && 'text-failed')}
						>
							{testResult.text}
						</p>
					{/if}
				</div>
			</div>
			{#if pushError}
				<p role="alert" class="text-sm text-failed">{pushError}</p>
			{/if}
			{#if push === 'blocked'}
				<div class="flex flex-col gap-2 rounded-xl bg-waiting-soft px-4 py-3 text-sm">
					<p class="font-medium">Turn notifications back on</p>
					<ol class="flex list-decimal flex-col gap-1 pl-5">
						<li>Long-press the Agent icon on your home screen and tap App info.</li>
						<li>Tap Notifications and switch them on.</li>
						<li>Come back here and turn notifications on.</li>
					</ol>
					<p class="text-muted-foreground">
						In a Chrome tab instead: tap the icon left of the address, then Permissions, then
						Notifications.
					</p>
				</div>
			{/if}
		</section>

		<section aria-labelledby="appearance" class="flex flex-col gap-2">
			<h2 id="appearance" class="text-sm font-medium text-muted-foreground">Appearance</h2>
			<div role="radiogroup" aria-labelledby="appearance" class="grid grid-cols-3 gap-2">
				{#each themes as t (t.id)}
					<button
						type="button"
						role="radio"
						aria-checked={theme === t.id}
						onclick={() => chooseTheme(t.id)}
						class={cn(
							'h-12 rounded-xl border bg-card text-sm font-medium text-muted-foreground',
							theme === t.id && 'border-foreground text-foreground'
						)}>{t.label}</button
					>
				{/each}
			</div>
		</section>

		<section aria-labelledby="app" class="flex flex-col gap-2">
			<h2 id="app" class="text-sm font-medium text-muted-foreground">App</h2>
			<dl class="flex flex-col divide-y rounded-xl border bg-card text-sm">
				<div class="flex min-h-12 items-center justify-between gap-4 px-4 py-3">
					<dt class="text-muted-foreground">Version</dt>
					<dd class="font-mono text-xs [overflow-wrap:anywhere]" data-testid="version">
						{version}
					</dd>
				</div>
				<div class="flex min-h-12 items-center justify-between gap-4 px-4 py-3">
					<dt class="text-muted-foreground">Installed</dt>
					<dd>{pwa.standalone ? 'Yes' : 'No, running in the browser'}</dd>
				</div>
			</dl>
			{#if pwa.canInstall}
				<Button class="w-full" onclick={() => pwa.install()}>Install the app</Button>
			{/if}
			{#if pwa.swError}
				<p role="alert" class="text-sm text-failed">
					Offline support is off: the background worker didn't start ({pwa.swError}).
				</p>
			{/if}
		</section>
	</div>
</AppShell>
