<script lang="ts">
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import Share from '@lucide/svelte/icons/share';
	import Lock from '@lucide/svelte/icons/lock';
	import Copy from '@lucide/svelte/icons/copy';
</script>

<div
	class="flex h-[92px] shrink-0 items-start gap-2 border-t bg-muted/80 px-3 pt-2.5 text-foreground/80"
	aria-hidden="true"
>
	<span class="grid size-11 shrink-0 place-items-center rounded-full bg-background shadow-sm"
		><ChevronLeft class="size-5" /></span
	>
	<span
		class="flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full bg-background px-3 text-[15px] shadow-sm"
	>
		<Lock class="size-3.5 shrink-0" /><span class="truncate">agent.home.example</span>
	</span>
	<span
		class="grid size-11 shrink-0 place-items-center rounded-full bg-background text-brand shadow-sm ring-2 ring-brand/40"
		><Share class="size-5" /></span
	>
	<span class="grid size-11 shrink-0 place-items-center rounded-full bg-background shadow-sm"
		><Copy class="size-5" /></span
	>
</div>
