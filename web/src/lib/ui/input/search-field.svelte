<script lang="ts">
	import Search from '@lucide/svelte/icons/search';
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/ui/button';
	import Input from './input.svelte';

	let {
		label,
		value = $bindable(''),
		ref = $bindable(null)
	}: { label: string; value?: string; ref?: HTMLInputElement | null } = $props();
	const uid = $props.id();
	function clear() {
		value = '';
		ref?.focus({ preventScroll: true });
	}
</script>

<div class="flex min-w-0 flex-col gap-2">
	<label for={uid} class="text-sm font-medium">{label}</label>
	<div class="relative">
		<Search
			class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
			aria-hidden="true"
		/>
		<Input
			id={uid}
			type="search"
			bind:value
			bind:ref
			class="h-12 pr-12 pl-9 text-base [&::-webkit-search-cancel-button]:appearance-none"
		/>
		<Button
			variant="ghost"
			size="icon-lg"
			class="absolute top-0 right-0 size-12 {value ? '' : 'invisible'}"
			aria-label="Clear search"
			disabled={!value}
			onclick={clear}><X /></Button
		>
	</div>
</div>
