<script lang="ts">
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { Button } from '$lib/ui/button';
	import { currentLocation, type LocationReply } from '../location';
	import type { PendingApproval } from '../types';
	let {
		pending,
		submitting = false,
		onapprove,
		ondeny
	}: {
		pending: PendingApproval;
		submitting?: boolean;
		onapprove?: (nonce: string, location?: LocationReply) => void;
		ondeny?: (nonce: string) => void;
	} = $props();
	const uid = $props.id();
	const view = $derived(pending.view);
	const location = $derived(view.tool === 'request_current_location');
	const title = $derived(
		location
			? 'Share your current location'
			: view.tool
					.replace(/^(?:mcp__[^_]+__)/, '')
					.replaceAll('_', ' ')
					.replace(/^./, (c) => c.toUpperCase())
	);
	const labels: Record<string, string> = {
		to: 'To',
		recipient: 'To',
		recipients: 'To',
		subject: 'Subject',
		body: 'Message',
		text: 'Message',
		message: 'Message',
		command: 'Command',
		url: 'URL',
		repo: 'Repository',
		reason: 'Reason'
	};
	let locating = $state(false);
	let capture: AbortController | undefined;
	$effect(() => {
		void pending.nonce;
		return () => capture?.abort();
	});
	async function approve() {
		if (submitting || locating) return;
		if (!location) return onapprove?.(pending.nonce);
		locating = true;
		const nonce = pending.nonce;
		capture = new AbortController();
		const reply = await currentLocation(capture.signal);
		if (!capture.signal.aborted && nonce === pending.nonce) onapprove?.(nonce, reply);
		locating = false;
	}
</script>

<section
	data-approval
	data-surface="approval"
	aria-labelledby="{uid}-title"
	class="min-w-0 rounded-xl border border-approval/60 bg-approval-surface px-3 py-2"
>
	<header class="flex items-center gap-2">
		<ShieldCheck class="size-4 shrink-0 text-approval" aria-hidden="true" />
		<h3 id="{uid}-title" class="min-w-0 flex-1 text-ui font-semibold [overflow-wrap:anywhere]">
			{title}
		</h3>
		<span class="shrink-0 text-meta text-muted-foreground">Approval needed</span>
	</header>
	<dl class="mt-2 flex flex-col gap-1 text-ui">
		{#each view.fields as field, i (i)}
			<div class="flex min-w-0 gap-2">
				<dt class="w-16 shrink-0 text-meta leading-5 text-muted-foreground">
					{labels[field.key] ?? field.key.replaceAll('_', ' ')}
				</dt>
				<dd
					class="min-w-0 flex-1 [overflow-wrap:anywhere] whitespace-pre-wrap"
					class:line-clamp-2={field.kind === 'body'}
				>
					{field.value}
				</dd>
			</div>
		{/each}
	</dl>
	<details class="group/exact mt-1">
		<summary
			class="flex min-h-12 cursor-pointer list-none items-center gap-1.5 text-meta text-muted-foreground [&::-webkit-details-marker]:hidden"
			>Exact input<ChevronDown
				class="size-3.5 transition-transform group-open/exact:rotate-180 motion-reduce:transition-none"
				aria-hidden="true"
			/></summary
		>
		<dl class="mb-2 flex max-h-48 flex-col gap-2 overflow-auto text-meta">
			{#each view.fields as field, i (i)}<div>
					<dt>{field.key}</dt>
					<dd class="font-mono text-code [overflow-wrap:anywhere] whitespace-pre-wrap">
						{field.value}
					</dd>
				</div>{/each}
			<div>
				<dt>Tool</dt>
				<dd class="font-mono text-code [overflow-wrap:anywhere]">{view.tool}</dd>
			</div>
			<div>
				<dt>Requested by (self-reported)</dt>
				<dd>{view.agentName}</dd>
			</div>
		</dl>
	</details>
	{#if pending.tainted}<p class="mb-2 flex items-start gap-2 text-meta text-taint">
			<TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{pending.tainted}
		</p>{/if}
	<div class="flex gap-3">
		<Button
			variant="outline"
			disabled={submitting || locating}
			aria-label="Deny {view.tool}"
			onclick={() => ondeny?.(pending.nonce)}><X />Deny</Button
		>
		<Button
			class="flex-1"
			disabled={submitting || locating}
			aria-label="Approve {view.tool}"
			onclick={approve}
		>
			{#if submitting || locating}<LoaderCircle
					class="animate-spin motion-reduce:animate-none"
				/>{locating ? 'Getting location…' : 'Submitting…'}{:else}<Check />{location
					? 'Share location'
					: 'Approve'}{/if}
		</Button>
	</div>
</section>
