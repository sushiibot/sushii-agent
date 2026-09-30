<script lang="ts">
	import Plus from '@lucide/svelte/icons/plus';
	import Copy from '@lucide/svelte/icons/copy';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Link2 from '@lucide/svelte/icons/link-2';
	import { Button } from '$lib/ui/button';
	import { Input } from '$lib/ui/input';
	import { cn } from '$lib/utils';
	import AppShell from './app-shell.svelte';
	import type { McpServer } from './types';

	type Stage = 'list' | 'url' | 'oauth' | 'paste';
	let {
		servers,
		stage = 'list',
		url = '',
		redirect = ''
	}: { servers: McpServer[]; stage?: Stage; url?: string; redirect?: string } = $props();
	const uid = $props.id();

	// svelte-ignore state_referenced_locally
	let urlValue = $state(url);
	// svelte-ignore state_referenced_locally
	let redirectValue = $state(redirect);
	const steps = ['Server URL', 'Sign in', 'Paste back'];
	const step = $derived(stage === 'url' ? 0 : stage === 'oauth' ? 1 : 2);
	const authLink =
		'https://linear.example/oauth/authorize?client_id=agt_7c1e&redirect_uri=http%3A%2F%2Flocalhost%3A7461%2Fcallback&state=q8Zt2';
</script>

<AppShell
	active="connectors"
	title={stage === 'list' ? 'Connectors' : 'Add MCP server'}
	back={stage === 'list' ? undefined : { href: '/connectors', label: 'Connectors' }}
	waiting={2}
>
	<div class="mx-auto flex max-w-xl flex-col gap-5 px-4 py-4 @3xl:py-8">
		{#if stage === 'list'}
			<ul class="flex flex-col divide-y rounded-lg border bg-card">
				{#each servers as s (s.name)}
					<li>
						<a
							href="/connectors/{s.name.toLowerCase()}"
							class="flex items-center gap-3 px-3 py-3 hover:bg-muted/60"
						>
							<span
								class="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-sm font-semibold"
								>{s.name[0]}</span
							>
							<span class="flex min-w-0 flex-1 flex-col">
								<span class="text-sm font-medium">{s.name}</span>
								<span class="truncate font-mono text-xs text-muted-foreground">{s.url}</span>
							</span>
							<span class="text-xs text-muted-foreground tabular-nums"
								>{s.tools.filter((t) => t.change !== 'removed').length} tools</span
							>
						</a>
					</li>
				{/each}
			</ul>
			<Button size="lg" class="self-start"><Plus />Add MCP server</Button>
		{:else}
			<ol class="grid grid-cols-3 gap-2 text-xs" aria-label="Steps">
				{#each steps as label, i (label)}
					<li
						aria-current={i === step ? 'step' : undefined}
						class={cn('flex flex-col gap-1.5', i > step ? 'text-muted-foreground' : 'font-medium')}
					>
						<span class={cn('h-1 rounded-full', i <= step ? 'bg-foreground' : 'bg-muted')}></span>
						{label}
					</li>
				{/each}
			</ol>

			{#if stage === 'url'}
				<section class="flex flex-col gap-2">
					<label for="{uid}-mcp-url" class="text-sm font-medium">Server URL</label>
					<Input
						id="{uid}-mcp-url"
						bind:value={urlValue}
						placeholder="https://example.com/mcp"
						inputmode="url"
						class="h-10 font-mono text-sm"
					/>
					<p class="text-sm text-muted-foreground">
						Streamable HTTP or SSE. The agent checks the server and asks it how to sign in.
					</p>
				</section>
				<Button size="lg" class="self-start" disabled={!urlValue.trim()}>Continue</Button>
			{:else if stage === 'oauth'}
				<section class="flex flex-col gap-3">
					<p class="text-sm">
						<span class="font-medium">Linear</span> uses OAuth. Open this link on any device and sign
						in.
					</p>
					<div class="flex items-start gap-2 rounded-lg border bg-muted/50 p-3">
						<Link2 class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						<code class="min-w-0 flex-1 font-mono text-xs break-all">{authLink}</code>
					</div>
					<div class="flex flex-wrap gap-2">
						<Button size="lg"><ExternalLink />Open sign-in link</Button>
						<Button size="lg" variant="outline"><Copy />Copy</Button>
					</div>
					<p class="text-sm text-muted-foreground">
						After you approve, the browser lands on a localhost page that won't load. That's
						expected. Copy its whole address.
					</p>
				</section>
				<Button size="lg" variant="outline" class="self-start">I've signed in</Button>
			{:else}
				<section class="flex flex-col gap-2">
					<label for="{uid}-mcp-redirect" class="text-sm font-medium"
						>Address from the browser</label
					>
					<Input
						id="{uid}-mcp-redirect"
						bind:value={redirectValue}
						placeholder="http://localhost:7461/callback?code=…"
						class="h-10 font-mono text-sm"
					/>
					<p class="text-sm text-muted-foreground">
						It starts with http://localhost:7461/callback and has a code in it.
					</p>
					{#if redirectValue && !redirectValue.includes('code=')}
						<p class="text-sm text-failed">
							That address has no code. Copy it again after approving.
						</p>
					{/if}
				</section>
				<Button size="lg" class="self-start" disabled={!redirectValue.includes('code=')}
					>Connect</Button
				>
			{/if}
		{/if}
	</div>
</AppShell>
