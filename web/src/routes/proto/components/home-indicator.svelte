<script lang="ts">
	let { light = false }: { light?: boolean } = $props();
</script>

<span
	class="pointer-events-none absolute bottom-2 left-1/2 z-30 h-[5px] w-[134px] -translate-x-1/2 rounded-full {light
		? 'bg-white'
		: 'bg-foreground'}"
	aria-hidden="true"
></span>
