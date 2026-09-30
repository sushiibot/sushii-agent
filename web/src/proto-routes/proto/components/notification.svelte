<script lang="ts">
	let { title, body, when = 'now' }: { title: string; body: string; when?: string } = $props();
</script>

<!-- Android heads-up notification. A button, so the board can follow the tap. -->
<button
	type="button"
	class="absolute inset-x-2 top-[52px] z-40 flex flex-col gap-1 rounded-[22px] bg-[oklch(0.97_0.005_260)] px-4 py-3 text-left text-[oklch(0.2_0_0)] shadow-[0_10px_30px_-8px_rgb(0_0_0/0.45)] dark:bg-[oklch(0.28_0.005_260)] dark:text-white"
>
	<span class="flex items-center gap-1.5 text-[12px] text-[oklch(0.45_0_0)] dark:text-white/65">
		<span class="grid size-4 place-items-center rounded-full bg-[oklch(0.145_0_0)] text-white">
			<svg viewBox="0 0 16 16" class="size-2.5" aria-hidden="true"
				><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="2.5" /></svg
			>
		</span>
		Agent · {when}
	</span>
	<span class="text-[15px] font-semibold">{title}</span>
	<span class="text-[14px] leading-snug">{body}</span>
</button>
