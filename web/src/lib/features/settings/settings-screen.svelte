<script lang="ts" module>
	export type ThemeChoice = 'system' | 'light' | 'dark';
	export type PushState = 'checking' | 'unsupported' | 'blocked' | 'unavailable' | 'off' | 'on';
</script>

<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import BellRing from '@lucide/svelte/icons/bell-ring';
	import { Button } from '$lib/ui/button';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import UpdateToast from '$lib/ui/pwa/update-toast.svelte';
	import * as RadioGroup from '$lib/ui/radio-group';
	import DetailScreen from '$lib/ui/screen/detail-screen.svelte';
	import ScreenState, { type RemoteLike } from '$lib/ui/screen/screen-state.svelte';
	import { SwitchRow } from '$lib/ui/switch';
	import { cn } from '$lib/utils';

	let {
		back,
		me,
		push,
		pushBusy = false,
		pushError = null,
		pushSyncFailed = false,
		testBusy = false,
		testResult = null,
		theme,
		version,
		standalone = false,
		canInstall = false,
		installFailed = false,
		swError = null,
		online = true,
		updateReady = false,
		onretryme,
		ontogglepush,
		ontest,
		onchoosetheme,
		oninstall,
		onreload
	}: {
		back?: { href: string; label: string; onclick?: (e: MouseEvent) => void };
		me: RemoteLike & { data?: { login: string; displayName?: string } };
		push: PushState;
		pushBusy?: boolean;
		pushError?: string | null;
		/** Notifications are on here, but the agent hasn't got this device's subscription. */
		pushSyncFailed?: boolean;
		testBusy?: boolean;
		testResult?: { ok: boolean; text: string } | null;
		theme: ThemeChoice;
		version: string;
		standalone?: boolean;
		canInstall?: boolean;
		installFailed?: boolean;
		swError?: string | null;
		online?: boolean;
		updateReady?: boolean;
		onretryme?: () => void;
		ontogglepush?: () => void;
		ontest?: () => void;
		onchoosetheme?: (choice: ThemeChoice) => void;
		oninstall?: () => void;
		onreload?: () => void;
	} = $props();

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
	// The group runs left to right; Up and Down move it too, as in the WAI-ARIA radio pattern.
	// Caught on capture, because the items handle and swallow arrow keys themselves.
	function themeKeydown(e: KeyboardEvent) {
		const step = ({ ArrowDown: 1, ArrowUp: -1 } as Record<string, number>)[e.key];
		if (!step) return;
		e.preventDefault();
		const i = themes.findIndex((t) => t.id === theme);
		const next = (i + step + themes.length) % themes.length;
		onchoosetheme?.(themes[next].id);
		(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
	}

	const themes: { id: ThemeChoice; label: string }[] = [
		{ id: 'system', label: 'System' },
		{ id: 'light', label: 'Light' },
		{ id: 'dark', label: 'Dark' }
	];
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline' }} />{/if}
{/snippet}
{#snippet toast()}<UpdateToast onreload={() => onreload?.()} />{/snippet}

{#snippet accountLoading()}
	<p class="flex items-center gap-2 text-sm text-muted-foreground" role="status">
		<LoaderCircle class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
		Loading your account…
	</p>
{/snippet}

<DetailScreen title="Settings" {back} {banner} toast={updateReady ? toast : undefined}>
	<div class="mx-auto flex max-w-2xl flex-col gap-8 px-4 pt-5 pb-10">
		<section aria-labelledby="account" class="flex flex-col gap-2">
			<h2 id="account" class="text-sm font-medium text-muted-foreground">Account</h2>
			<div class="flex min-h-16 flex-col justify-center rounded-xl border bg-card px-4 py-3">
				<ScreenState
					remote={me}
					errorTitle="Couldn't load your account."
					onretry={onretryme}
					skeleton={accountLoading}
				>
					{#if me.data}
						<p class="text-sm text-muted-foreground">Signed in as</p>
						<p class="font-medium [overflow-wrap:anywhere]" data-testid="login">
							{me.data.displayName ?? me.data.login}
						</p>
						{#if me.data.displayName}
							<p class="text-sm [overflow-wrap:anywhere] text-muted-foreground">{me.data.login}</p>
						{/if}
					{/if}
				</ScreenState>
			</div>
		</section>

		<section aria-labelledby="notifications" class="flex flex-col gap-2">
			<h2 id="notifications" class="text-sm font-medium text-muted-foreground">Notifications</h2>
			<div class="flex flex-col divide-y rounded-xl border bg-card">
				<SwitchRow
					checked={push === 'on'}
					disabled={pushToggleDisabled}
					describedby="push-state"
					onchange={() => ontogglepush?.()}
					class="rounded-xl"
				>
					<span class="font-medium">Notify this device</span>
					<span id="push-state" class="text-sm text-muted-foreground">
						{#if pushBusy}
							{push === 'on' ? 'Turning off…' : 'Turning on…'}
						{:else}
							{pushLabel}
						{/if}
					</span>
				</SwitchRow>
				<div class="flex flex-col gap-3 px-4 py-4">
					<p class="text-sm text-muted-foreground">
						Only when the agent needs you, a run fails, or something you asked about finishes.
					</p>
					<Button
						variant="outline"
						class="w-full"
						disabled={push !== 'on' || testBusy}
						onclick={() => ontest?.()}
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
			{:else if push === 'on' && pushSyncFailed}
				<p role="status" class="text-sm text-muted-foreground">
					Couldn't sync this device with the agent. The app will retry when you come back to it.
				</p>
			{/if}
			{#if push === 'blocked'}
				<div class="flex flex-col gap-2 rounded-xl bg-waiting-soft px-4 py-3 text-sm">
					<p class="font-medium">Turn notifications back on</p>
					<ol class="flex list-decimal flex-col gap-1 pl-5">
						<li>Long-press the sushii icon on your home screen and tap App info.</li>
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
			<RadioGroup.Root
				aria-labelledby="appearance"
				orientation="horizontal"
				onkeydowncapture={themeKeydown}
				class="grid-cols-3"
				bind:value={() => theme, (v) => onchoosetheme?.(v as ThemeChoice)}
			>
				{#each themes as t (t.id)}
					<RadioGroup.Card value={t.id}>{t.label}</RadioGroup.Card>
				{/each}
			</RadioGroup.Root>
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
					<dd>{standalone ? 'Yes' : 'No, running in the browser'}</dd>
				</div>
			</dl>
			{#if canInstall}
				<Button class="w-full" onclick={() => oninstall?.()}>Install the app</Button>
			{/if}
			{#if installFailed}
				<p role="alert" class="text-sm text-failed">
					Chrome didn't open the install prompt. Open Chrome's menu and choose Install app.
				</p>
			{/if}
			{#if swError}
				<p role="alert" class="text-sm text-failed">
					Offline support is off: the background worker didn't start ({swError}).
				</p>
			{/if}
		</section>
	</div>
</DetailScreen>
