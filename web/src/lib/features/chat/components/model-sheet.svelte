<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Search from '@lucide/svelte/icons/search';
	import type { ChatUsage, ModelFacts, ModelsResponse } from '$lib/core/realtime/events';
	import { Button } from '$lib/ui/button';
	import { Input } from '$lib/ui/input';
	import { cn } from '$lib/utils';
	import { aggregateCost, modelName, usageRows } from '../render/usage';

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
		onrole,
		onquery,
		onpick,
		onclose
	}: {
		models: ModelsResponse | null;
		/** Historical reply usage, separate from current conversation context. */
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
		onrole?: (role: Role) => void;
		onquery?: (query: string) => void;
		onpick?: (alias: string, role: Role) => void;
		onclose?: () => void;
	} = $props();

	const uid = $props.id();
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
	// The id behind the current choice, so a search hit for a listed model shows as current too.
	const chosenId = $derived(
		role === 'main'
			? (models?.models.find((m) => m.alias === models.current)?.id ?? models?.current ?? null)
			: (models?.fallback ?? null)
	);
	const unique = (rows: Row[]) =>
		rows.filter((r, i) => rows.findIndex((o) => o.key === r.key) === i);
	const listed = $derived.by((): Row[] => {
		if (!models) return [];
		return unique(
			models.models
				.filter((m) => role === 'main' || m.backend === 'openrouter')
				.map((m) => ({
					key: role === 'main' ? m.alias : m.id,
					title: m.alias === m.id ? modelName(m.id) : m.alias,
					detail: [m.alias === m.id ? null : m.id, facts(m)].filter(Boolean).join(' · '),
					current: role === 'main' ? m.alias === models.current : m.id === chosenId
				}))
		);
	});
	const found = $derived(
		unique(
			(results ?? []).map((m): Row => ({
				key: m.id,
				title: m.name,
				detail: [m.id, facts(m)].join(' · '),
				current: m.id === chosenId
			}))
		)
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

<div
	class="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-3 border-b bg-background px-5 py-2"
>
	<h2 class="font-semibold">Model</h2>
	<Button variant="ghost" size="icon" class="size-12" aria-label="Close" onclick={onclose}
		><X aria-hidden="true" /></Button
	>
</div>
<div class="flex flex-col gap-4 px-3 py-5">
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
			role="group"
			aria-label="What to pick"
			class="mx-2 grid grid-cols-2 gap-1 rounded-xl bg-muted p-1"
		>
			{#each [['main', 'Model'], ['fallback', 'Fallback']] as const as [value, label] (value)}
				<button
					type="button"
					aria-pressed={role === value}
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
	<section aria-labelledby="{uid}-cost" class="flex flex-col gap-1 px-2">
		<h3 id="{uid}-cost" class="text-sm font-medium">Cost</h3>
		<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
			<dt class="text-muted-foreground">This session</dt>
			<dd class="text-right tabular-nums">
				{aggregateCost(models?.cost?.session, models?.cost?.truncated)}
			</dd>
			<dt
				class="text-muted-foreground"
				title={models?.cost ? `${models.cost.date} · ${models.cost.timeZone}` : undefined}
			>
				Today
			</dt>
			<dd class="text-right tabular-nums">
				{aggregateCost(models?.cost?.today, models?.cost?.truncated)}
			</dd>
		</dl>
		<p class="text-meta text-muted-foreground">
			Recorded USD, including delegated work.
			{#if models?.cost?.truncated}Older runs are outside this total.{/if}
			{#if models?.cost?.session?.unpricedRuns || models?.cost?.today.unpricedRuns}Unpriced and
				subscription usage is excluded.{/if}
		</p>
	</section>

	{#if usage}
		<details class="mx-2 border-t pt-2">
			<summary class="min-h-12 cursor-pointer py-3 font-medium">Last reply usage</summary>
			<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
				{#each usageRows(usage).filter(([k]) => k !== 'Context used') as [k, v] (k)}
					<dt class="text-muted-foreground">{k}</dt>
					<dd class="text-right [overflow-wrap:anywhere] tabular-nums">{v}</dd>
				{/each}
			</dl>
		</details>
	{/if}
</div>
