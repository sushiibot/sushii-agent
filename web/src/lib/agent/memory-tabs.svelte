<script lang="ts">
	import { cn } from '$lib/utils';

	let { active }: { active: 'changes' | 'skills' } = $props();
	const tabs = [
		{ id: 'changes', href: '/memory', label: 'Changes' },
		{ id: 'skills', href: '/memory/skills', label: 'Skills' }
	] as const;
</script>

<nav aria-label="Memory sections" class="grid grid-cols-2 rounded-lg bg-muted p-0.5 text-sm">
	{#each tabs as t (t.id)}
		<a
			href={t.href}
			aria-current={active === t.id ? 'page' : undefined}
			class={cn(
				'rounded-md py-1.5 text-center text-muted-foreground',
				active === t.id && 'bg-background font-medium text-foreground shadow-sm'
			)}>{t.label}</a
		>
	{/each}
</nav>
