<script lang="ts">
	import Copy from '@lucide/svelte/icons/copy';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Link2 from '@lucide/svelte/icons/link-2';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { Button } from '$lib/ui/button';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import { Input } from '$lib/ui/input';
	import DetailScreen from '$lib/ui/screen/detail-screen.svelte';
	import { cn } from '$lib/utils';
	import type { AddState } from './types';

	let {
		add,
		back,
		online = true,
		copied = false,
		onurl,
		onredirect,
		onbegin,
		onsignedin,
		onfinish,
		onstepback,
		oncopy
	}: {
		add: AddState;
		back: { href: string; label: string; onclick?: (e: MouseEvent) => void };
		online?: boolean;
		copied?: boolean;
		onurl?: (url: string) => void;
		onredirect?: (redirect: string) => void;
		onbegin?: () => void;
		onsignedin?: () => void;
		onfinish?: () => void;
		onstepback?: () => void;
		oncopy?: (text: string) => void;
	} = $props();
	const uid = $props.id();
	const steps = ['Server address', 'Sign in', 'Paste back'];
	const step = $derived(add.stage === 'url' ? 0 : add.stage === 'oauth' ? 1 : 2);
	const hasCode = $derived(/[?&]code=/.test(add.redirect));
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline' }} />{/if}
{/snippet}

{#snippet footer()}
	<div class="flex flex-col gap-2 border-t px-4 py-3">
		{#if add.error}<p role="alert" class="text-sm text-failed">{add.error}</p>{/if}
		{#if add.stage === 'url'}
			<Button size="lg" disabled={!add.url.trim() || add.busy || !online} onclick={onbegin}>
				{#if add.busy}<LoaderCircle
						class="animate-spin motion-reduce:animate-none"
						aria-hidden="true"
					/>Checking the server…{:else}Continue{/if}
			</Button>
		{:else if add.stage === 'oauth'}
			<Button size="lg" onclick={onsignedin}>I've signed in</Button>
			<Button size="lg" variant="ghost" onclick={onstepback}>Back to the address</Button>
		{:else}
			<Button size="lg" disabled={!hasCode || add.busy || !online} onclick={onfinish}>
				{#if add.busy}<LoaderCircle
						class="animate-spin motion-reduce:animate-none"
						aria-hidden="true"
					/>Connecting…{:else}Connect{/if}
			</Button>
			<Button size="lg" variant="ghost" onclick={onstepback}>Back to sign-in</Button>
		{/if}
	</div>
{/snippet}

<DetailScreen title="Add a server" {back} {banner} {footer}>
	<div class="mx-auto flex max-w-xl flex-col gap-5 px-4 py-4">
		<ol class="grid grid-cols-3 gap-2 text-meta" aria-label="Steps">
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

		{#if add.stage === 'url'}
			<section class="flex flex-col gap-2">
				<label for="{uid}-url" class="text-sm font-medium">Server address</label>
				<Input
					id="{uid}-url"
					value={add.url}
					oninput={(e) => onurl?.(e.currentTarget.value)}
					placeholder="https://example.com/mcp"
					inputmode="url"
					autocomplete="off"
					autocapitalize="off"
					spellcheck={false}
					class="h-12 font-mono text-base"
				/>
				<p class="text-sm text-muted-foreground">
					An https:// address for a Streamable HTTP or SSE server. The agent checks it and asks it
					how to sign in.
				</p>
			</section>
		{:else if add.stage === 'oauth'}
			<section class="flex flex-col gap-3">
				<p class="text-sm">
					<span class="font-medium">{add.name}</span> uses a sign-in. Open this link on any device and
					approve.
				</p>
				<div class="flex items-start gap-2 rounded-xl border bg-muted/50 p-3">
					<Link2 class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
					<code class="min-w-0 flex-1 font-mono text-meta break-all">{add.authUrl}</code>
				</div>
				<div class="flex flex-wrap gap-2">
					<Button
						size="lg"
						variant="outline"
						href={add.authUrl}
						target="_blank"
						rel="noopener noreferrer"><ExternalLink />Open sign-in link</Button
					>
					<Button size="lg" variant="outline" onclick={() => add.authUrl && oncopy?.(add.authUrl)}
						><Copy />{copied ? 'Copied' : 'Copy'}</Button
					>
				</div>
				<p class="text-sm text-muted-foreground">
					After you approve, the browser lands on a localhost page that won't load. That's expected:
					the agent runs on a server, not on this phone. Copy that page's whole address.
				</p>
			</section>
		{:else}
			<section class="flex flex-col gap-2">
				<label for="{uid}-redirect" class="text-sm font-medium">Address from the browser</label>
				<Input
					id="{uid}-redirect"
					value={add.redirect}
					oninput={(e) => onredirect?.(e.currentTarget.value)}
					placeholder="http://localhost:7461/callback?code=…"
					autocomplete="off"
					autocapitalize="off"
					spellcheck={false}
					class="h-12 font-mono text-base"
				/>
				<p class="text-sm text-muted-foreground">
					It starts with http://localhost:7461/callback and has a code in it.
				</p>
				{#if add.redirect && !hasCode}
					<p class="text-sm text-failed">
						That address has no code. Copy it again after approving.
					</p>
				{/if}
			</section>
		{/if}
	</div>
</DetailScreen>
