<script lang="ts" module>
	export type ConnectionState =
		| { kind: 'offline' }
		| { kind: 'reconnecting'; elapsed?: string }
		| { kind: 'agent-offline' }
		| { kind: 'reset' };
</script>

<script lang="ts">
	import WifiOff from '@lucide/svelte/icons/wifi-off';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import ServerOff from '@lucide/svelte/icons/server-off';
	import History from '@lucide/svelte/icons/history';
	import { cn } from '$lib/utils';

	let { state }: { state: ConnectionState } = $props();
</script>

<p
	role="status"
	class={cn(
		'flex items-start gap-2.5 border-b px-4 py-2.5 text-sm',
		state.kind === 'reset' ? 'bg-running-soft text-running' : 'bg-waiting-soft text-waiting'
	)}
>
	{#if state.kind === 'offline'}
		<WifiOff class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		<span>Offline. Messages send when you reconnect.</span>
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
