<script lang="ts">
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { Button } from '$lib/ui/button';
	import ToolIcon from './tool-icon.svelte';
	import ToolRow from './tool-row.svelte';
	import { toolCategory } from '../tool-activity';
	import { splitGitHubPush } from '../render/ask-question';
	import { confirmationOutcome } from '../tool-confirmation';
	import type { AskView, ToolConfirmation } from '../types';
	let {
		ask,
		confirmation,
		onanswer
	}: {
		ask: AskView;
		confirmation: ToolConfirmation;
		onanswer?: (answer: string, index?: number) => void;
	} = $props();
	const live = $derived(ask.state === 'pending' || ask.state === 'answering');
	const outcome = $derived(confirmationOutcome(ask));
	const approved = $derived(outcome.startsWith('approved'));
	const push = $derived(
		confirmation.tool === 'github_push' ? splitGitHubPush(confirmation.input) : undefined
	);
	const category = $derived(toolCategory(confirmation.tool));
	const uid = $props.id();
	function choiceLabel(choice: string) {
		return /^(yes|approve|allow|confirm)$/i.test(choice)
			? 'Approve'
			: /^(no|deny|reject)$/i.test(choice)
				? 'Deny'
				: choice;
	}
</script>

{#if live}
	<section
		data-surface="tool-confirmation"
		data-ask-id={ask.askId}
		aria-labelledby="{uid}-title"
		class="min-w-0 rounded-xl border border-approval/60 bg-approval-surface px-3 py-2 text-ui"
	>
		<header class="flex min-h-8 items-center gap-2">
			<ToolIcon kind={category.kind} />
			<h3 id="{uid}-title" class="min-w-0 flex-1 font-semibold">
				{push ? 'Push to GitHub?' : `Allow ${category.label.toLowerCase()}?`}
			</h3>
			<ShieldCheck class="size-4 shrink-0 text-approval" aria-hidden="true" />
			<span class="text-meta text-muted-foreground">Approval needed</span>
		</header>
		{#if push}
			<div class="my-3 flex min-w-0 flex-col gap-2 [overflow-wrap:anywhere]">
				<p class="font-medium">{push.destination}</p>
				<p class="text-body">{push.summary}</p>
				<details class="group/commit">
					<summary class="flex min-h-12 cursor-pointer items-center text-meta text-muted-foreground"
						>Commit {push.commit.slice(0, 7)}</summary
					>
					<p class="pb-2 font-mono text-code">{push.commit}</p>
				</details>
			</div>
		{:else}
			<pre
				class="my-2 max-h-32 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-code [overflow-wrap:anywhere] whitespace-pre-wrap">{confirmation.input}</pre>
		{/if}
		{#if confirmation.reason}<p class="my-2 text-meta text-muted-foreground">
				{confirmation.reason}
			</p>{/if}
		<div class="flex gap-3">
			{#each ask.choices as choice, index (index)}
				<Button
					variant={/^(yes|approve|allow|confirm)$/i.test(choice) ? 'default' : 'outline'}
					disabled={ask.state === 'answering'}
					onclick={() => onanswer?.(choice, index)}
				>
					{#if ask.state === 'answering' && ask.answer === choice}<LoaderCircle
							class="animate-spin motion-reduce:animate-none"
							aria-hidden="true"
						/>{/if}
					{choiceLabel(choice)}
				</Button>
			{/each}
		</div>
		{#if ask.state === 'answering'}<p role="status" class="mt-2 text-meta text-muted-foreground">
				Sending your decision…
			</p>{/if}
	</section>
{:else}
	<div data-surface="tool-confirmation" data-ask-id={ask.askId}>
		<ToolRow
			step={{
				id: `confirmation:${ask.askId}`,
				tool: confirmation.tool,
				label: category.label,
				state: approved ? 'ok' : 'failed',
				input: confirmation.input,
				output: undefined
			}}
			approval={{ tool: confirmation.tool, outcome }}
			executionUnknown
			approvalReason={confirmation.reason}
		/>
	</div>
{/if}
