<script lang="ts">
	import SquarePlus from '@lucide/svelte/icons/square-plus';
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/ui/button';

	let {
		canInstall,
		oninstall
	}: {
		canInstall: boolean;
		oninstall: () => Promise<'accepted' | 'dismissed' | 'failed'>;
	} = $props();

	const KEY = 'install-hint-dismissed';
	let dismissed = $state(read());
	let failed = $state(false);

	function read() {
		try {
			return localStorage.getItem(KEY) === '1';
		} catch {
			return false;
		}
	}

	function dismiss() {
		dismissed = true;
		try {
			localStorage.setItem(KEY, '1');
		} catch {
			// Private mode: hidden for this visit only.
		}
	}

	async function install() {
		failed = (await oninstall()) === 'failed';
	}
</script>

{#if (canInstall || failed) && !dismissed}
	<aside
		aria-label="Install the app"
		class="relative flex items-start gap-3 rounded-xl border bg-card p-4 pr-12 text-sm"
	>
		<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-brand/12 text-brand">
			<SquarePlus class="size-5" aria-hidden="true" />
		</span>
		<div class="flex min-w-0 flex-col items-start gap-3">
			<p class="flex flex-col gap-0.5">
				<span class="font-medium">Install the app</span>
				<span class="text-muted-foreground">
					It opens full screen from your home screen and can notify you.
				</span>
			</p>
			<Button onclick={install}>Install</Button>
			{#if failed}
				<p role="alert" class="text-failed">
					Chrome didn't open the install prompt. Open Chrome's menu and choose Install app.
				</p>
			{/if}
		</div>
		<Button
			variant="ghost"
			size="icon"
			class="absolute top-1 right-1 size-12"
			aria-label="Dismiss install hint"
			onclick={dismiss}><X class="size-5" /></Button
		>
	</aside>
{/if}
