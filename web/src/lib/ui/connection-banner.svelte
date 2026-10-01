<script lang="ts" module>
	export type ConnectionState =
		| { kind: 'offline' }
		/** Offline on a screen that sends nothing, so there's no queue to mention. */
		| { kind: 'app-offline' }
		| { kind: 'reconnecting'; elapsed?: string }
		| { kind: 'agent-offline' }
		| { kind: 'reset' };
</script>

<script lang="ts">
	import WifiOff from '@lucide/svelte/icons/wifi-off';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import ServerOff from '@lucide/svelte/icons/server-off';
	import History from '@lucide/svelte/icons/history';
	import ShieldOff from '@lucide/svelte/icons/shield-off';
	import { cn } from '$lib/utils';

	let { state }: { state: ConnectionState | 'forbidden' } = $props();
</script>

<p
	role="status"
	class={cn(
		'flex items-start gap-2.5 border-b px-4 py-2.5 text-sm',
		state === 'forbidden'
			? 'bg-failed-soft text-failed'
			: state.kind === 'reset'
				? 'bg-running-soft text-running'
				: 'bg-waiting-soft text-waiting'
	)}
>
	{#if state === 'forbidden'}
		<ShieldOff class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		<span>This device isn't signed in as the owner. Check Tailscale, then reopen the app.</span>
	{:else if state.kind === 'offline'}
		<WifiOff class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		<span>Offline. Messages send when you reconnect.</span>
	{:else if state.kind === 'app-offline'}
		<WifiOff class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		<span>You're offline. The app reconnects on its own when the network is back.</span>
	{:else if state.kind === 'reconnecting'}
		<LoaderCircle
			class="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none"
			aria-hidden="true"
		/>
		<span
			>Reconnecting…{#if state.elapsed}<span class="tabular-nums"> {state.elapsed}</span>{/if}</span
		>
	{:else if state.kind === 'agent-offline'}
		<ServerOff class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		<span>The agent is offline. Your message is queued and sends when it's back.</span>
	{:else}
		<History class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		<span>Reloaded the conversation. You were away longer than the live buffer.</span>
	{/if}
</p>
