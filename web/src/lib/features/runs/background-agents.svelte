<script lang="ts">
	import Bot from '@lucide/svelte/icons/bot';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { untrack } from 'svelte';
	import { backgroundWork } from './background.svelte';
	import { request } from '$lib/core/http';
	import { leaveSheet, routedSheet } from '$lib/core/nav/sheet';
	import { Button } from '$lib/ui/button';
	import RoutedSheet from '$lib/ui/sheet/routed-sheet.svelte';
	import { duration } from '$lib/ui/format/time';
	import { activityTitle, executionLabel } from './format';
	import StepRow from './components/step-row.svelte';
	import type { RunSummary } from './types';
	import type { ActivityDetail } from './activity';

	let {
		conversationId = 'main',
		turnId,
		compact = false,
		onrun
	}: {
		conversationId?: string;
		turnId?: string;
		compact?: boolean;
		onrun: (id: string) => Promise<void>;
	} = $props();
	const work = $derived(backgroundWork(conversationId));
	const runs = $derived(work.runs);
	let selected = $state<RunSummary | null>(null);
	let detail = $state<ActivityDetail | null>(null);
	let error = $state<string | null>(null);
	let stopping = $state(false);
	let now = $state(Date.now());
	const sheet = routedSheet('agent-activity');
	const uid = $props.id();
	const sheetOpen = $derived(sheet.open && sheet.arg?.startsWith(`${uid}:`) === true);
	const shown = $derived(
		runs.filter((r) => (turnId ? r.turnId === turnId : r.status === 'running'))
	);
	async function refresh() {
		await work.refresh();
		if (selected) {
			try {
				detail = await work.readActivity(selected.runId);
				error = null;
			} catch (e) {
				error = e instanceof Error ? e.message : 'Could not load agent activity.';
			}
		}
		now = Date.now();
	}
	async function inspect(run: RunSummary) {
		selected = run;
		detail = null;
		error = null;
		sheet.openWith(`${uid}:${run.runId}`);
		try {
			detail = await work.readActivity(run.runId);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load agent activity.';
		}
	}
	async function openFullRun(event: MouseEvent) {
		if (
			event.defaultPrevented ||
			event.button !== 0 ||
			event.metaKey ||
			event.ctrlKey ||
			event.shiftKey ||
			event.altKey
		)
			return;
		const runId = selected?.runId;
		if (!runId) return;
		event.preventDefault();
		await leaveSheet(sheet);
		await onrun(runId);
	}

	async function stop() {
		if (!selected || stopping) return;
		stopping = true;
		error = null;
		try {
			await request('POST', `/runs/${selected.runId}/stop`);
			await refresh();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not stop this agent.';
		} finally {
			stopping = false;
		}
	}
	$effect(() => {
		const current = work;
		const off = untrack(() => current.connect());
		return off;
	});
	$effect(() => {
		if (!sheetOpen) return;
		const timer = setInterval(() => void refresh(), 3000);
		return () => clearInterval(timer);
	});
</script>

{#if shown.length}
	{#if compact}
		<details class="border-t px-4 text-sm" data-background-work>
			<summary class="flex min-h-12 cursor-pointer items-center gap-2 text-muted-foreground">
				<Bot class="size-4" aria-hidden="true" />
				Delegated tasks · {shown.length} running
			</summary>
			{#each shown as run (run.runId)}
				<button
					class="flex min-h-12 w-full items-center gap-2 text-left"
					onclick={() => void inspect(run)}
				>
					<Bot class="size-4 shrink-0" aria-hidden="true" /><span class="min-w-0 flex-1 truncate"
						>{activityTitle(run)}</span
					><ChevronRight class="size-4" aria-hidden="true" />
				</button>
			{/each}
		</details>
	{:else}
		<div class="flex flex-col gap-1" data-delegated-agents>
			{#each shown as run (run.runId)}
				<button
					class="flex min-h-12 w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm hover:bg-muted/50"
					onclick={() => void inspect(run)}
				>
					<Bot class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
					<span class="flex min-w-0 flex-1 flex-col"
						><span class="truncate font-medium">{activityTitle(run)}</span><span
							class="truncate text-meta text-muted-foreground"
							>{run.agentName}{run.repo ? ` · ${run.repo}` : ''} · {executionLabel(run.status)} · {duration(
								Math.max(
									0,
									Date.parse(run.endedAt ?? new Date(now).toISOString()) - Date.parse(run.startedAt)
								)
							)}</span
						>{#if work.activity[run.runId]}<span class="truncate text-meta text-muted-foreground"
								>{work.activity[run.runId]}</span
							>{/if}</span
					>
					<ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				</button>
			{/each}
		</div>
	{/if}
{/if}

<RoutedSheet open={sheetOpen} label="Agent activity" onclose={() => sheet.close()}>
	<div class="flex flex-col gap-3 px-5 pb-5">
		{#if selected}
			<h2 class="text-lg font-semibold">Agent activity</h2>
			<p class="text-sm text-muted-foreground">
				{selected.agentName}{selected.repo ? ` · ${selected.repo}` : ''} · {executionLabel(
					detail?.run.status ?? selected.status
				)}
			</p>
			<details class="group/task min-w-0" data-task-brief>
				<summary
					class="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 text-ui font-medium [&::-webkit-details-marker]:hidden"
				>
					Task brief
					<ChevronDown
						class="size-4 shrink-0 text-muted-foreground transition-transform group-open/task:rotate-180 motion-reduce:transition-none"
						aria-hidden="true"
					/>
				</summary>
				<!-- The brief scrolls inside the sheet; keyboard users must be able to focus it. -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<p
					tabindex="0"
					role="region"
					aria-label="Task brief"
					class="max-h-48 overflow-y-auto pb-2 text-ui leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap"
				>
					{detail?.taskBrief ?? selected.title}
				</p>
			</details>
			{#if error}<p role="alert" class="text-sm text-failed">{error}</p>{/if}
			{#if detail}
				<p class="text-meta text-muted-foreground">
					Recent activity · oldest first. Open task for the full history.
				</p>
				<div class="flex max-h-80 flex-col overflow-y-auto">
					{#each detail.steps.filter((step) => !(step.type === 'user' && step.text === detail?.taskBrief)) as step (step.id)}<StepRow
							{step}
						/>{/each}
				</div>
				{#if detail.run.resultSummary}<p class="text-sm">{detail.run.resultSummary}</p>{/if}
			{:else if !error}<p role="status" class="text-sm text-muted-foreground">
					Loading activity…
				</p>{/if}
			<div class="flex flex-wrap gap-2">
				<Button
					variant="outline"
					href="/runs/{selected.runId}"
					onclick={(event) => void openFullRun(event)}>Open task</Button
				>
				{#if (detail?.run.status ?? selected.status) === 'running'}<Button
						variant="ghost"
						disabled={stopping}
						onclick={() => void stop()}>{stopping ? 'Stopping…' : 'Stop this agent'}</Button
					>{/if}
			</div>
		{/if}
	</div>
</RoutedSheet>
