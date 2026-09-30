<script lang="ts">
	import type { Snippet } from 'svelte';
	import Wrench from '@lucide/svelte/icons/wrench';
	import Split from '@lucide/svelte/icons/split';
	import Bell from '@lucide/svelte/icons/bell';
	import Archive from '@lucide/svelte/icons/archive';
	import BookMarked from '@lucide/svelte/icons/book-marked';
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import { cn } from '$lib/utils';
	import type { ChatMessage } from './types';

	let { messages, pressed, after }: { messages: ChatMessage[]; pressed?: string; after?: Snippet } =
		$props();
	const uid = $props.id();
</script>

<ol class="flex flex-col gap-4 px-4 py-4">
	{#each messages as message (message.id)}
		<li
			class={cn(
				message.role === 'user' ? 'flex flex-col items-end gap-2' : 'flex flex-col gap-2',
				pressed === message.id &&
					'-mx-2 rounded-xl bg-muted px-2 py-2 ring-2 ring-brand/50 transition-colors'
			)}
		>
			{#each message.parts as part, i (i)}
				{#if part.type === 'text'}
					<p
						class={message.role === 'user'
							? 'max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[15px] leading-snug text-primary-foreground'
							: 'text-[15px] leading-relaxed'}
					>
						{part.text}
					</p>
				{:else if part.type === 'data-notice'}
					<a
						href={part.data.href}
						class="flex items-start gap-2.5 rounded-lg border border-dashed px-3 py-2.5 text-sm hover:bg-muted/50"
					>
						<Bell class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						<span class="flex min-w-0 flex-col gap-0.5">
							<span class="text-xs font-medium text-muted-foreground">{part.data.source}</span>
							<span>{part.data.items.join(' · ')}</span>
						</span>
					</a>
				{:else if part.type === 'data-thread-offer'}
					<section
						aria-label="Thread suggestion"
						class="flex flex-col gap-3 rounded-xl border border-brand/40 bg-card p-3.5 shadow-[0_6px_20px_-14px_rgb(0_0_0/0.35)]"
					>
						<p class="flex items-center gap-2 text-sm font-semibold">
							<span class="grid size-7 place-items-center rounded-md bg-brand/12 text-brand">
								<Split class="size-4" aria-hidden="true" />
							</span>
							Start a thread: {part.data.title}
						</p>
						<p class="text-sm text-muted-foreground">{part.data.reason}</p>
						{#if part.data.openedAs}
							<a
								href="/chats/{part.data.openedAs}"
								class="inline-flex items-center gap-1 self-start text-sm font-medium text-brand hover:underline"
								>Moved to the thread<ArrowUpRight class="size-3.5" aria-hidden="true" /></a
							>
						{:else}
							<div class="flex flex-wrap gap-2">
								<Button size="lg"><Split />Start thread</Button>
								<Button size="lg" variant="ghost">Keep it here</Button>
							</div>
						{/if}
					</section>
				{:else if part.type === 'data-thread-brief'}
					<section
						aria-labelledby="{uid}-brief-{message.id}"
						class="flex flex-col gap-3 rounded-xl border bg-muted/40 p-3.5 text-sm"
					>
						<h2
							id="{uid}-brief-{message.id}"
							class="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
						>
							From Main
						</h2>
						<div class="flex flex-col gap-1">
							<h3 class="font-medium">What's known</h3>
							<ul
								class="flex list-disc flex-col gap-1 pl-5 text-muted-foreground marker:text-border"
							>
								{#each part.data.known as line (line)}<li>{line}</li>{/each}
							</ul>
						</div>
						<div class="flex flex-col gap-1">
							<h3 class="font-medium">Open questions</h3>
							<ul
								class="flex list-disc flex-col gap-1 pl-5 text-muted-foreground marker:text-border"
							>
								{#each part.data.open as line (line)}<li>{line}</li>{/each}
							</ul>
						</div>
						<label class="flex items-center justify-between gap-3 border-t pt-3">
							<span class="flex flex-col">
								<span>Include the last {part.data.recentFromMain} messages</span>
								<span class="text-xs text-muted-foreground"
									>Off: the thread starts from this brief only</span
								>
							</span>
							<Switch />
						</label>
					</section>
				{:else if part.type === 'data-thread-report'}
					<a
						href="/chats/{part.data.sessionId}"
						class="flex items-start gap-2.5 rounded-lg border bg-card px-3 py-2.5 text-sm hover:bg-muted/50"
					>
						<Archive class="mt-0.5 size-4 shrink-0 text-review" aria-hidden="true" />
						<span class="flex min-w-0 flex-col gap-0.5">
							<span class="text-xs text-muted-foreground"
								>Thread closed · <span class="font-medium text-foreground">{part.data.title}</span
								></span
							>
							<span>{part.data.line}</span>
						</span>
						<ArrowUpRight
							class="mt-0.5 ml-auto size-4 shrink-0 text-muted-foreground"
							aria-label="View archived thread"
						/>
					</a>
				{:else if part.type === 'data-memory-write'}
					<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<BookMarked class="size-3.5 shrink-0" aria-hidden="true" />
						Saved to memory
						<code class="truncate font-mono text-[11px] text-foreground/80">{part.data.file}</code>
					</p>
				{:else}
					<details class="group rounded-lg border bg-card text-sm">
						<summary
							class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted-foreground"
						>
							<Wrench class="size-3.5 shrink-0" aria-hidden="true" />
							<code class="font-mono text-xs text-foreground">{part.type.slice(5)}</code>
							<span class="truncate">{part.output?.found ?? ''}</span>
						</summary>
						<pre
							class="border-t px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">{JSON.stringify(
								part.input,
								null,
								2
							)}</pre>
					</details>
				{/if}
			{/each}
		</li>
	{/each}
	{#if after}<li class="flex flex-col gap-2">{@render after()}</li>{/if}
</ol>
