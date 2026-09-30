<script lang="ts">
	import Markdown from '$lib/agent/markdown.svelte';
	import ApprovalTray from '$lib/agent/approval-tray.svelte';
	import WorkingRow from '$lib/agent/working-row.svelte';
	import Conversation from '$lib/agent/conversation.svelte';
	import { api } from './api.svelte';

	const files = (f: unknown) => f as { id: string; inline: boolean }[] | undefined;
</script>

<div id="solo"></div>
<p id="counter">{api.counter}</p>
<div id="list">
	{#each api.messages as m, i (i)}
		<div class="msg"><Markdown text={m.text} files={files(m.files)} /></div>
	{/each}
</div>
<div id="steps">
	<WorkingRow turn={{ state: 'done', steps: api.steps }} open />
</div>
<div id="chat"><Conversation messages={api.chat} /></div>
{#if api.tray}
	<div id="tray" class="fixed inset-x-0 bottom-0">
		<ApprovalTray
			items={api.tray}
			holdMs={300}
			onapprove={(n) => api.approved.push(n)}
			ondeny={(n) => api.approved.push(`deny:${n}`)}
		/>
	</div>
{/if}
