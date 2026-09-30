<script lang="ts">
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import UserCheck from '@lucide/svelte/icons/user-check';
	import Ban from '@lucide/svelte/icons/ban';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import FileText from '@lucide/svelte/icons/file-text';
	import Hash from '@lucide/svelte/icons/hash';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import ScanSearch from '@lucide/svelte/icons/scan-search';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';
	import AppShell from '../app-shell.svelte';
	import StatePill from '../state-pill.svelte';
	import type { Evidence, Run, ToolCall } from '../types';

	let { run, open: initialOpen = [] }: { run: Run; open?: string[] } = $props();
	const uid = $props.id();

	// svelte-ignore state_referenced_locally
	let open = $state<string[]>(initialOpen);
	const toggle = (id: string) =>
		(open = open.includes(id) ? open.filter((o) => o !== id) : [...open, id]);

	const stepIcon: Record<
		ToolCall['status'],
		{ icon: typeof CircleCheck; class: string; label: string }
	> = {
		ok: { icon: CircleCheck, class: 'text-muted-foreground', label: 'OK' },
		error: { icon: CircleX, class: 'text-failed', label: 'Error' },
		approved: { icon: UserCheck, class: 'text-review', label: 'Approved' },
		denied: { icon: Ban, class: 'text-failed', label: 'Denied' }
	};
	const evidenceIcon: Record<Evidence['kind'], typeof Hash> = {
		'message-id': Hash,
		readback: ScanSearch,
		http: Hash,
		file: FileText,
		screenshot: FileText
	};
	const verified = $derived(run.outcome === 'verified');
</script>

{#snippet outcome()}
	<section
		aria-label="Outcome"
		class={cn(
			'rounded-lg p-3',
			verified ? 'bg-review-soft text-review' : 'bg-waiting-soft text-waiting'
		)}
	>
		<StatePill of={run.outcome} class="bg-background/60" />
		<p class="mt-2 text-sm">
			{verified ? 'Finished and verified.' : 'Finished, but nothing confirms it worked.'}
			<span class="text-foreground/80">{run.outcomeNote}</span>
		</p>
		{#if !verified}
			<Button size="lg" variant="outline" class="mt-3 bg-background"
				><RotateCcw />Rerun with fix</Button
			>
		{/if}
	</section>
{/snippet}

{#snippet evidenceList()}
	<section aria-labelledby="{uid}-ev-h" class="flex flex-col gap-2">
		<h2 id="{uid}-ev-h" class="text-sm font-semibold">Evidence</h2>
		{#if run.evidence.length}
			<ul class="flex flex-col divide-y rounded-lg border bg-card text-sm">
				{#each run.evidence as ev (ev.label)}
					{@const Icon = evidenceIcon[ev.kind]}
					<li class="flex items-start gap-2.5 px-3 py-2">
						<Icon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						<span class="flex min-w-0 flex-col">
							<span class="text-muted-foreground">{ev.label}</span>
							<span class="font-mono text-[13px] break-all">{ev.value}</span>
						</span>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">
				No evidence recorded. The run never read back a result.
			</p>
		{/if}
	</section>
{/snippet}

{#snippet trust()}
	{#if run.tainted}
		<section
			aria-labelledby="{uid}-trust-h"
			class="flex flex-col gap-2 rounded-lg border p-3 text-sm"
		>
			<h2 id="{uid}-trust-h" class="flex items-center gap-2 font-semibold">
				Trust <StatePill of="tainted" />
			</h2>
			<p class="text-muted-foreground">
				Tainted by <span class="font-mono text-[13px] text-foreground">{run.tainted.by}</span>.
				After that, these tools asked first:
			</p>
			<p class="flex flex-wrap gap-1.5">
				{#each run.tainted.locked as tool (tool)}
					<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{tool}</code>
				{/each}
			</p>
		</section>
	{/if}
{/snippet}

<AppShell active="runs" title={run.title} back={{ href: '/runs', label: 'Runs' }} waiting={2}>
	<div
		class="flex flex-col gap-5 px-4 py-4 @3xl:grid @3xl:grid-cols-[minmax(0,1fr)_20rem] @3xl:grid-rows-[auto_auto_auto_1fr] @3xl:items-start @3xl:gap-x-8 @3xl:px-6"
	>
		<div class="@3xl:col-start-2 @3xl:row-start-1">{@render outcome()}</div>

		<div class="flex min-w-0 flex-col gap-5 @3xl:col-start-1 @3xl:row-span-4 @3xl:row-start-1">
			<dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm @md:grid-cols-4">
				{#each [['Trigger', run.trigger], ['Started', run.started], ['Took', run.duration], ['Cost', run.cost]] as [k, v] (k)}
					<div class="flex flex-col">
						<dt class="text-xs text-muted-foreground">{k}</dt>
						<dd class="tabular-nums">{v}</dd>
					</div>
				{/each}
			</dl>
			<section aria-labelledby="{uid}-tl-h" class="flex flex-col gap-2">
				<h2 id="{uid}-tl-h" class="flex items-baseline justify-between text-sm font-semibold">
					Timeline <span class="text-xs font-normal text-muted-foreground"
						>{run.steps.length} tool calls · {run.model}</span
					>
				</h2>
				<ol class="relative flex flex-col">
					{#each run.steps as step, i (step.id)}
						{@const s = stepIcon[step.status]}
						{@const expanded = open.includes(step.id)}
						<li class="relative grid grid-cols-[1.25rem_1fr] gap-x-3">
							{#if i < run.steps.length - 1}
								<span
									class="absolute top-6 bottom-0 left-[0.6rem] w-px bg-border"
									aria-hidden="true"
								></span>
							{/if}
							<s.icon
								class={cn('relative mt-2.5 size-5 bg-background', s.class)}
								aria-label={s.label}
							/>
							<div class="min-w-0 pb-2">
								<button
									type="button"
									aria-expanded={expanded}
									disabled={!step.detail}
									onclick={() => toggle(step.id)}
									class="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/60 disabled:hover:bg-transparent"
								>
									<span class="flex min-w-0 flex-1 flex-col gap-0.5">
										<span class="flex flex-wrap items-center gap-x-2 gap-y-1">
											<code class="font-mono text-[13px] font-medium">{step.name}</code>
											{#if step.taints}<StatePill of="tainted" label="Tainted here" />{/if}
										</span>
										<span class="text-sm text-muted-foreground">{step.summary}</span>
									</span>
									<span
										class="flex shrink-0 flex-col items-end text-xs text-muted-foreground tabular-nums"
									>
										<span>{step.at}</span>
										<span
											>{step.ms >= 1000 ? `${(step.ms / 1000).toFixed(1)}s` : `${step.ms}ms`}</span
										>
									</span>
									{#if step.detail}
										<ChevronDown
											class={cn(
												'mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform',
												expanded && 'rotate-180'
											)}
											aria-hidden="true"
										/>
									{/if}
								</button>
								{#if expanded && step.detail}
									<p
										class={cn(
											'mx-2 mb-1 rounded-md bg-muted px-2.5 py-2 font-mono text-xs break-words whitespace-pre-wrap',
											step.status === 'error' && 'bg-failed-soft text-failed'
										)}
									>
										{step.detail}
									</p>
								{/if}
							</div>
						</li>
					{/each}
				</ol>
			</section>

			<Button variant="link" class="h-auto self-start px-0" href="/history/{run.file}">
				<FileText />Open run file
			</Button>
		</div>

		<div class="@3xl:col-start-2 @3xl:row-start-2">{@render evidenceList()}</div>
		{#if run.tainted}
			<div class="@3xl:col-start-2 @3xl:row-start-3">{@render trust()}</div>
		{/if}
	</div>
</AppShell>
