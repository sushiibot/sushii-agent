<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import FoldVertical from '@lucide/svelte/icons/fold-vertical';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Search from '@lucide/svelte/icons/search';
	import type { ChatUsage, ModelFacts, ModelsResponse } from '$lib/core/realtime/events';
	import { Button } from '$lib/ui/button';
	import { Input } from '$lib/ui/input';
	import { cn } from '$lib/utils';
	import { contextTone, modelName, usageRows } from '../render/usage';

	type Role = 'main' | 'fallback';
	type Row = { key: string; title: string; detail: string; current: boolean };

	let {
		models,
		usage,
		now,
		role = 'main',
		query = '',
		results = null,
		searching = false,
		searchError = null,
		picking = null,
		error = null,
		compactDisabled = false,
		onrole,
		onquery,
		onpick,
		oncompact,
		onclose
	}: {
		models: ModelsResponse | null;
		/** The last reply's usage, for the context section. */
		usage: ChatUsage | null;
		now: number;
		role?: Role;
		query?: string;
		results?: ({ id: string; name: string } & ModelFacts)[] | null;
		searching?: boolean;
		searchError?: string | null;
		/** The alias being switched to. */
		picking?: string | null;
		error?: string | null;
		compactDisabled?: boolean;
		onrole?: (role: Role) => void;
		onquery?: (query: string) => void;
		onpick?: (alias: string, role: Role) => void;
		oncompact?: () => void;
		onclose?: () => void;
	} = $props();

	const uid = $props.id();
	const pct = $derived(usage?.contextPct === undefined ? null : Math.round(usage.contextPct));
	const tone = $derived(contextTone(pct));
	const cooling = $derived(
		models?.fallbackUntil && Date.parse(models.fallbackUntil) > now ? models.fallbackUntil : null
	);
	const at = (iso: string) =>
		new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

	function facts(m: ModelFacts & { backend?: string }): string {
		const parts: string[] = [];
		if (m.backend === 'chatgpt') parts.push('ChatGPT plan');
		else if (m.priceIn != null && m.priceOut != null) {
			parts.push(`$${m.priceIn} / $${m.priceOut} per 1M`);
		}
		if (m.contextWindow) parts.push(`${tokens(m.contextWindow)} context`);
		if (m.image) parts.push('images');
		return parts.join(' · ');
	}
	function tokens(n: number): string {
		if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
		return `${Math.round(n / 1000)}k`;
	}

	// The fallback must be an OpenRouter model: it is what answers while ChatGPT can't.
	const listed = $derived.by((): Row[] => {
		if (!models) return [];
		const chosen = role === 'main' ? models.current : (models.fallback ?? null);
		return models.models
			.filter((m) => role === 'main' || m.backend === 'openrouter')
			.map((m) => ({
				key: role === 'main' ? m.alias : m.id,
				title: m.alias === m.id ? modelName(m.id) : m.alias,
				detail: [m.alias === m.id ? null : m.id, facts(m)].filter(Boolean).join(' · '),
				current: role === 'main' ? m.alias === chosen : m.id === chosen
			}));
	});
	const found = $derived(
		(results ?? []).map((m): Row => ({
			key: m.id,
			title: m.name,
			detail: [m.id, facts(m)].join(' · '),
			current: role === 'main' ? m.id === models?.current : m.id === models?.fallback
		}))
	);
</script>

{#snippet rows(list: Row[], label: string)}
	<ul class="flex flex-col" aria-label={label}>
		{#each list as r (r.key)}
			<li>
				<button
					type="button"
					aria-pressed={r.current}
					aria-disabled={!!picking}
					onclick={() => (picking ? undefined : r.current ? onclose?.() : onpick?.(r.key, role))}
					class="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-muted aria-disabled:cursor-progress"
				>
					<span class="flex min-w-0 flex-1 flex-col gap-0.5">
						<span class="text-body font-medium [overflow-wrap:anywhere]">{r.title}</span>
						<span class="text-sm [overflow-wrap:anywhere] text-muted-foreground">{r.detail}</span>
					</span>
					{#if picking === r.key}
						<LoaderCircle
							class="size-5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
							aria-label="Switching"
						/>
					{:else if r.current}
						<Check class="size-5 shrink-0" aria-label="Current" />
					{/if}
				</button>
			</li>
		{/each}
	</ul>
{/snippet}

<div class="flex flex-col gap-4 px-3 pt-1 pb-3">
	<h2 class="px-2 pt-1 text-lg font-semibold">Model and context</h2>

	{#if pct !== null && usage}
		<section aria-labelledby="{uid}-ctx" class="flex flex-col gap-2 px-2">
			<div class="flex items-baseline justify-between gap-3">
				<h3 id="{uid}-ctx" class="text-sm font-medium">Context</h3>
				<span class="text-sm text-muted-foreground tabular-nums">{pct}% used</span>
			</div>
			<div
				role="meter"
				aria-label="Context used"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={pct}
				class="h-2 overflow-hidden rounded-full bg-muted"
			>
				<div
					class={cn(
						'h-full rounded-full',
						tone === 'failed' ? 'bg-failed' : tone === 'waiting' ? 'bg-waiting' : 'bg-foreground/70'
					)}
					style:width="{Math.min(100, pct)}%"
				></div>
			</div>
			<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
				{#each usageRows(usage).filter(([k]) => k !== 'Context used') as [k, v] (k)}
					<dt class="text-muted-foreground">{k}</dt>
					<dd class="text-right [overflow-wrap:anywhere] tabular-nums">{v}</dd>
				{/each}
			</dl>
			<p class="text-sm text-muted-foreground">
				For the last reply. The agent compacts on its own when it gets full.
			</p>
			<Button variant="outline" disabled={compactDisabled} onclick={() => oncompact?.()}
				><FoldVertical />Compact now</Button
			>
		</section>
	{/if}

	{#if !models}
		<p role="status" class="px-2 text-sm text-muted-foreground">
			The agent can't say which models it has right now. Try again once it's back.
		</p>
	{:else}
		{#if cooling}
			<p role="status" class="mx-2 rounded-lg bg-waiting-soft px-3 py-2 text-sm text-waiting">
				ChatGPT is unavailable until {at(cooling)}. Replies come from {modelName(
					models.fallback ?? ''
				)}.
			</p>
		{/if}
		{#if error}
			<p role="alert" class="mx-2 rounded-lg bg-failed-soft px-3 py-2 text-sm text-failed">
				{error}
			</p>
		{/if}

		<div
			role="radiogroup"
			aria-label="What to pick"
			class="mx-2 grid grid-cols-2 gap-1 rounded-xl bg-muted p-1"
		>
			{#each [['main', 'Model'], ['fallback', 'Fallback']] as const as [value, label] (value)}
				<button
					type="button"
					role="radio"
					aria-checked={role === value}
					onclick={() => onrole?.(value)}
					class={cn(
						'h-12 rounded-lg text-sm font-medium text-muted-foreground',
						role === value && 'bg-background text-foreground shadow-sm'
					)}>{label}</button
				>
			{/each}
		</div>
		<p class="px-2 text-sm text-muted-foreground">
			{role === 'main'
				? 'Applies from the next reply.'
				: `Answers while ChatGPT is over its limit or signed out. Now: ${modelName(models.fallback ?? '')}.`}
		</p>

		{@render rows(listed, role === 'main' ? 'Models' : 'Fallback models')}

		<label class="relative mx-2 block">
			<span class="sr-only">Search OpenRouter models</span>
			<Search
				class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
				aria-hidden="true"
			/>
			<Input
				type="search"
				value={query}
				oninput={(e) => onquery?.(e.currentTarget.value)}
				placeholder="Search OpenRouter models"
				class="h-12 pl-9 text-base"
			/>
		</label>
		{#if searching}
			<p role="status" class="px-2 text-sm text-muted-foreground">Searching…</p>
		{:else if searchError}
			<p role="alert" class="px-2 text-sm text-failed">{searchError}</p>
		{:else if results && !results.length}
			<p role="status" class="px-2 text-sm text-muted-foreground">
				No tool-capable model matches “{query}”.
			</p>
		{:else if results}
			{@render rows(found, 'Search results')}
		{/if}
	{/if}
	<Button size="lg" variant="ghost" onclick={() => onclose?.()}>Close</Button>
</div>
