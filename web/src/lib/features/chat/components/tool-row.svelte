<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import ToolIcon from './tool-icon.svelte';
	import { toolCategory } from '../tool-activity';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ApprovalInline from './approval-inline.svelte';
	import type { TurnStep, PendingApproval, ApprovalOutcome } from '../types';
	import type { LocationReply } from '../location';
	let {
		step,
		approval,
		pending,
		submitting = false,
		open = false,
		executionUnknown = false,
		onapprove,
		ondeny
	}: {
		step: TurnStep;
		approval?: { tool: string; outcome: ApprovalOutcome; nonce?: string };
		pending?: PendingApproval;
		submitting?: boolean;
		open?: boolean;
		executionUnknown?: boolean;
		onapprove?: (nonce: string, location?: LocationReply) => void;
		ondeny?: (nonce: string) => void;
	} = $props();
	const labels: Record<ApprovalOutcome, string> = {
		pending: 'Approval needed',
		approved: 'Approved',
		denied: 'Denied',
		timeout: 'Expired',
		cancelled: 'Cancelled',
		'approved-elsewhere': 'Approved on another device',
		'denied-elsewhere': 'Denied on another device'
	};
	const readable = $derived(step.label === step.tool ? step.tool.replaceAll('_', ' ') : step.label);
</script>

{#if pending && approval?.outcome === 'pending'}
	<ApprovalInline {pending} {submitting} {onapprove} {ondeny} />
{:else}
	<details {open} data-tool-call={step.id} class="group/tool min-w-0 text-ui text-muted-foreground">
		<summary
			class="flex min-h-12 cursor-pointer list-none items-center gap-2 py-1 [&::-webkit-details-marker]:hidden"
		>
			<ToolIcon kind={toolCategory(step.tool).kind} />
			{#if step.state === 'failed'}<CircleX
					class="size-4 shrink-0 text-failed"
					aria-hidden="true"
				/>{/if}
			<span class="min-w-0 flex-1 truncate">{readable}</span>
			<span class="flex shrink-0 items-center gap-1 text-meta"
				>{#if step.state === 'running'}<LoaderCircle
						class="size-3.5 animate-spin text-running motion-reduce:animate-none"
						aria-hidden="true"
					/>{/if}{executionUnknown && approval
					? labels[approval.outcome]
					: step.state === 'running'
						? 'Running'
						: step.state === 'failed'
							? 'Failed'
							: 'Finished'}</span
			>
			<ChevronDown
				class="size-3.5 shrink-0 transition-transform group-open/tool:rotate-180 motion-reduce:transition-none"
				aria-hidden="true"
			/>
		</summary>
		<dl class="flex min-w-0 flex-col gap-2 border-t py-2 text-meta">
			{#if approval}<div>
					<dt class="sr-only">Decision</dt>
					<dd data-approval-record>
						{labels[approval.outcome]}{approval.outcome.startsWith('approved')
							? executionUnknown
								? ' · Execution status unavailable'
								: ' · Execution status shown above'
							: ''}
					</dd>
				</div>{/if}
			<div>
				<dt class="text-muted-foreground">Tool</dt>
				<dd class="font-mono text-code">{step.tool}</dd>
			</div>
			{#if step.input}<div>
					<dt>Input</dt>
					<dd>
						<pre
							class="max-h-48 overflow-auto font-mono text-code [overflow-wrap:anywhere] whitespace-pre-wrap">{step.input}</pre>
					</dd>
				</div>{/if}
			{#if step.output}<div>
					<dt>Output</dt>
					<dd>
						<pre
							class="max-h-64 overflow-auto font-mono text-code [overflow-wrap:anywhere] whitespace-pre-wrap">{step.output}</pre>
					</dd>
				</div>{/if}
		</dl>
	</details>
{/if}
