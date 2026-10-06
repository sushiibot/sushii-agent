<script lang="ts">
	// What the agent's transcript shows it did. Listed, never judged: nothing here is "verified".
	import Download from '@lucide/svelte/icons/download';
	import { fileUrl, type UploadRef } from '$lib/core/realtime/events';
	import { clock } from '$lib/ui/format/time';
	import type { RunApprovalRecord, RunEvidence } from '../types';

	let {
		evidence,
		approvals,
		files
	}: { evidence?: RunEvidence; approvals: RunApprovalRecord[]; files: UploadRef[] } = $props();
	const uid = $props.id();

	const decision: Record<string, string> = {
		approve: 'You approved',
		deny: 'You denied',
		timeout: 'Timed out, denied',
		cancelled: 'Withdrawn',
		pending: 'Still waiting'
	};
	const checkResult = (ok: boolean | null) =>
		ok === null ? 'No result' : ok ? 'Passed' : 'Failed';
	const size = (bytes: number) =>
		bytes < 1024
			? `${bytes} B`
			: bytes < 1024 ** 2
				? `${Math.round(bytes / 1024)} KB`
				: `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	const t = (iso: string) => clock(Date.parse(iso));
	const nothing = $derived(
		!files.length &&
			!approvals.length &&
			(!evidence ||
				(!evidence.checks.length &&
					!evidence.changedRepos.length &&
					!evidence.filesSent.length &&
					!evidence.memoryWrites.length))
	);
</script>

{#snippet heading(id: string, text: string)}
	<h3 {id} class="text-sm font-medium text-muted-foreground">{text}</h3>
{/snippet}

<section aria-labelledby="{uid}-h" class="flex flex-col gap-4">
	<h2 id="{uid}-h" class="text-base font-semibold">Checks and outputs</h2>
	{#if nothing}
		<p class="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
			The transcript shows no checks, files or memory writes for this attempt.
		</p>
	{/if}

	{#if evidence?.checks.length}
		<div class="flex flex-col gap-1.5" role="group" aria-labelledby="{uid}-checks">
			{@render heading(`${uid}-checks`, 'Checks the agent ran')}
			<ul class="flex flex-col divide-y rounded-xl border">
				{#each evidence.checks as check, i (i)}
					<li class="flex items-start justify-between gap-3 px-3 py-2.5">
						<code class="min-w-0 font-mono text-code [overflow-wrap:anywhere]">{check.command}</code
						>
						<span
							class="shrink-0 text-meta font-medium {check.ok === false
								? 'text-failed'
								: 'text-muted-foreground'}">{checkResult(check.ok)} · {t(check.at)}</span
						>
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	{#if evidence && evidence.changedRepos.length}
		<p class="text-sm">
			<span class="text-muted-foreground">Changed code in</span>
			<span class="font-mono text-code">{evidence.changedRepos.join(', ')}</span>.
			{#if evidence.checkAfterLastChange === true}
				A check ran after the last change.
			{:else if evidence.checkAfterLastChange === false}
				<span class="font-medium text-failed">No check ran after the last change.</span>
			{/if}
		</p>
	{/if}

	{#if evidence?.filesSent.length || files.length}
		<div class="flex flex-col gap-1.5" role="group" aria-labelledby="{uid}-files">
			{@render heading(`${uid}-files`, 'Files sent to you')}
			<ul class="flex flex-col divide-y rounded-xl border">
				{#each files as file (file.id)}
					<li>
						<a
							href={fileUrl(file.id)}
							download={file.name}
							class="flex min-h-12 items-center gap-3 px-3 py-2 hover:bg-muted/60"
						>
							<Download class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
							<span class="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{file.name}</span>
							<span class="shrink-0 text-meta text-muted-foreground">{size(file.bytes)}</span>
						</a>
					</li>
				{/each}
				{#each (evidence?.filesSent ?? []).filter((f) => !files.some((u) => u.name === f.name)) as f, i (i)}
					<li class="flex min-h-12 items-center justify-between gap-3 px-3 py-2 text-sm">
						<span class="min-w-0 [overflow-wrap:anywhere]">{f.name}</span>
						<span class="shrink-0 text-meta text-muted-foreground">{t(f.at)}</span>
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	{#if evidence?.memoryWrites.length}
		<div class="flex flex-col gap-1.5" role="group" aria-labelledby="{uid}-mem">
			{@render heading(`${uid}-mem`, 'Memory the agent changed')}
			<ul class="flex flex-col divide-y rounded-xl border">
				{#each evidence.memoryWrites as w, i (i)}
					<li class="flex items-start justify-between gap-3 px-3 py-2.5">
						<span class="min-w-0 font-mono text-code break-all">{w.path}</span>
						<span class="shrink-0 text-meta text-muted-foreground">{w.tool} · {t(w.at)}</span>
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	{#if approvals.length}
		<div class="flex flex-col gap-1.5" role="group" aria-labelledby="{uid}-appr">
			{@render heading(`${uid}-appr`, 'Approvals during this attempt')}
			<ul class="flex flex-col divide-y rounded-xl border">
				{#each approvals as a (a.nonce)}
					<li class="flex items-start justify-between gap-3 px-3 py-2.5">
						<code class="min-w-0 font-mono text-code [overflow-wrap:anywhere]">{a.tool}</code>
						<span class="shrink-0 text-meta text-muted-foreground"
							>{decision[a.decision ?? 'pending']} · {t(a.at)}</span
						>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</section>
